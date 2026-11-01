// Immutable, hash-chained hand-off records per session, following the HeliosEntitlementAuthority
// hand-off convention: a record is never rewritten; each names its predecessor
// (continuation_from) and carries the SHA-256 of the predecessor's LF bytes
// (continuation_token_sha256); each has a sidecar. latest.json is the only file rewritten in
// place, and it moves only to a record that passed its checks (ACCEPTED): newest is not the same
// as trusted. Since record schema v3 those checks include continuity (lib/continuity.mjs): a
// record that would lose what the accepted one carries is kept as evidence (RETAINED) but never
// becomes the pointer. Every step is appended to lifecycle.jsonl (CAPTURED; ACCEPTED, RETAINED or
// REJECTED; SUPERSEDED; INJECTED or NOT_INJECTED; ACCEPTANCE_CORRECTED when a record accepted under
// an earlier rule fails the current one: the journal is never edited, the correction moves
// forward). Cell sources a record cites are stored once under their own hash, and a record is
// accepted only while every cell it cites is there with that hash.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONTINUITY_RULE, continuityVerdict, coverage } from './continuity.mjs';
import { checkSidecar, fileSha256, lf, sha256, writeAtomic, writeSidecar } from './files.mjs';

export const RECORD_SCHEMA = 'codex-handoff-record.v3';
const KNOWN_SCHEMAS = ['codex-handoff-record.v1', 'codex-handoff-record.v2', 'codex-handoff-record.v3'];
const LATEST_SCHEMA = 'codex-handoff-latest.v2';
const RECORD_NAME = /^handoff-(\d{4,})\.json$/;
const CELL_FILE = /^cells\/([0-9a-f]{64})\.js$/;
export const RECORD_CHECK = 'codex-handoff record check v3 (sidecar, predecessor binding, schema, cited cells, continuity rule v1)';

export function listRecords(sessionDir) {
  const dir = join(sessionDir, 'records');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => name.match(RECORD_NAME))
    .filter(Boolean)
    .map((m) => ({ name: m[0], sequence: Number(m[1]), path: join(dir, m[0]) }))
    .sort((a, b) => a.sequence - b.sequence);
}

export function readLifecycle(sessionDir) {
  const path = join(sessionDir, 'lifecycle.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { event: 'UNREADABLE', line: l.slice(0, 80) };
      }
    });
}

export function appendLifecycle(sessionDir, event) {
  appendFileSync(join(sessionDir, 'lifecycle.jsonl'), `${JSON.stringify({ at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ...event })}\n`);
}

export function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// The cell files a record cites (artifacts): each must exist under cells/ with the hash in its name.
export function checkArtifacts(record, sessionDir) {
  const cited = record?.artifacts ?? [];
  for (const a of cited) {
    const m = String(a.file ?? '').match(CELL_FILE);
    if (!m || m[1] !== a.sha256) return { ok: false, detail: `cited artifact ${a.file} is not a cell file named by its hash` };
    const path = join(sessionDir, a.file);
    if (!existsSync(path)) return { ok: false, detail: `cited artifact ${a.file} is missing` };
    if (fileSha256(path) !== a.sha256) return { ok: false, detail: `cited artifact ${a.file} does not match its hash` };
  }
  return { ok: true, detail: `${new Set(cited.map((a) => a.file)).size} cited cell file(s) match` };
}

// The checks a record must pass before latest.json may point to it.
export function checkRecord(records, index) {
  const r = records[index];
  const side = checkSidecar(r.path);
  if (!side.ok) return { ok: false, detail: `sidecar: ${side.detail}` };
  const record = readRecord(r.path);
  if (!record) return { ok: false, detail: 'not valid JSON' };
  if (!KNOWN_SCHEMAS.includes(record.schema_version)) return { ok: false, detail: `unknown schema ${record.schema_version}` };
  const prev = records[index - 1];
  if (record.sequence !== r.sequence || r.sequence !== index + 1) return { ok: false, detail: `sequence ${record.sequence} at position ${index + 1}` };
  if (record.continuation_from !== (prev?.name ?? null)) return { ok: false, detail: `continues ${record.continuation_from ?? 'nothing'}, expected ${prev?.name ?? 'nothing'}` };
  if (record.continuation_token_sha256 !== (prev ? fileSha256(prev.path) : null)) return { ok: false, detail: 'predecessor hash does not match the predecessor file' };
  if (!record.session_id) return { ok: false, detail: 'no session_id' };
  const cells = checkArtifacts(record, dirname(dirname(r.path)));
  if (!cells.ok) return cells;
  return { ok: true, detail: side.detail };
}

function writeLatest(sessionDir, record, priorAccepted) {
  const latest = {
    schema_version: LATEST_SCHEMA,
    current: record.name,
    handoff_sha256: fileSha256(record.path),
    status: 'ACCEPTED',
    verified_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    verifier: RECORD_CHECK,
    prior: priorAccepted ?? null,
  };
  writeAtomic(join(sessionDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
}

export function readLatest(sessionDir) {
  return readRecord(join(sessionDir, 'latest.json'));
}

// Records whose acceptance a later rule corrected (ACCEPTANCE_CORRECTED events).
export const correctedAcceptances = (lifecycle) => new Set(lifecycle.filter((e) => e.event === 'ACCEPTANCE_CORRECTED').map((e) => e.record));

// The record the pointer stands for: the newest one accepted and not corrected since, still
// passing its checks. Sessions from before the journal fall back to latest.json.
export function effectiveAccepted(sessionDir) {
  const records = listRecords(sessionDir);
  const lifecycle = readLifecycle(sessionDir);
  const corrected = correctedAcceptances(lifecycle);
  const accepted = new Set(lifecycle.filter((e) => e.event === 'ACCEPTED' && !corrected.has(e.record)).map((e) => e.record));
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (accepted.has(r.name) && checkRecord(records, i).ok) return { name: r.name, path: r.path, sha256: fileSha256(r.path), record: readRecord(r.path) };
  }
  const latest = readLatest(sessionDir);
  if (!lifecycle.length && latest?.current) {
    const r = records.find((x) => x.name === latest.current);
    if (r) return { name: r.name, path: r.path, sha256: fileSha256(r.path), record: readRecord(r.path) };
  }
  return null;
}

// The hand-off text latest.json vouches for: the accepted record, unchanged (its sidecar and the
// pointer's hash agree), and handoff.txt with exactly the hash that record states for it.
export function acceptedHandoff(sessionDir) {
  const latest = readLatest(sessionDir);
  if (!latest?.current || (latest.status !== undefined && latest.status !== 'ACCEPTED')) return { reason: 'NO_ACCEPTED_RECORD' };
  const name = latest.current;
  const path = join(sessionDir, 'records', name);
  const side = existsSync(path) ? checkSidecar(path) : { ok: false };
  if (!side.ok || side.detail !== latest.handoff_sha256) return { name, reason: 'RECORD_HASH_MISMATCH' };
  const record = readRecord(path);
  const textPath = join(sessionDir, 'handoff.txt');
  if (!record?.rendered?.sha256) return { name, reason: 'NO_RENDERED_HASH' };
  if (!existsSync(textPath)) return { name, record, reason: 'RENDERED_MISSING' };
  const text = readFileSync(textPath, 'utf8');
  if (sha256(lf(text)) !== record.rendered.sha256) return { name, record, reason: 'RENDERED_HASH_MISMATCH' };
  return { name, record, text, rendered_sha256: record.rendered.sha256 };
}

// Writes the record and its sidecar, checks it, and only then moves latest.json. A record whose
// body states a continuity regression (body.continuity, lib/continuity.mjs) is kept as evidence
// (RETAINED) and the pointer stays on the accepted record.
export function appendRecord(sessionDir, body) {
  // the chain fields are the record's own; a body cannot set them
  const { schema_version: _s, sequence: _n, continuation_from: _f, continuation_token_sha256: _t, ...content } = body;
  mkdirSync(join(sessionDir, 'records'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const prior = listRecords(sessionDir).at(-1) ?? null;
    const sequence = (prior?.sequence ?? 0) + 1;
    const name = `handoff-${String(sequence).padStart(4, '0')}.json`;
    const record = {
      schema_version: RECORD_SCHEMA,
      sequence,
      continuation_from: prior?.name ?? null,
      continuation_token_sha256: prior ? fileSha256(prior.path) : null,
      ...content,
    };
    const path = join(sessionDir, 'records', name);
    try {
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') continue; // another hook took this number; never overwrite a record
      throw error;
    }
    const hex = writeSidecar(path);
    appendLifecycle(sessionDir, { event: 'CAPTURED', record: name, sha256: hex });
    const records = listRecords(sessionDir);
    const check = checkRecord(records, records.findIndex((r) => r.name === name));
    if (!check.ok) {
      appendLifecycle(sessionDir, { event: 'REJECTED', record: name, reason: check.detail });
      return { name, path, sequence, sha256: hex, accepted: false, reason: check.detail };
    }
    if (content.continuity?.verdict === 'CONTINUITY_REGRESSION') {
      const c = content.continuity;
      appendLifecycle(sessionDir, { event: 'RETAINED', record: name, reason: c.reason, predecessor: c.predecessor?.name ?? null, detail: c.detail, rule: c.rule });
      return { name, path, sequence, sha256: hex, accepted: false, retained: true, reason: `${c.reason}: ${c.detail}` };
    }
    const priorAccepted = readLatest(sessionDir)?.current ?? null;
    writeLatest(sessionDir, { name, path }, priorAccepted);
    appendLifecycle(sessionDir, { event: 'ACCEPTED', record: name, verifier: RECORD_CHECK });
    if (priorAccepted) appendLifecycle(sessionDir, { event: 'SUPERSEDED', record: priorAccepted, by: name });
    return { name, path, sequence, sha256: hex, accepted: true };
  }
  throw new Error('could not allocate a hand-off record number');
}

export function saveCell(sessionDir, source) {
  const text = lf(source);
  const hex = sha256(text);
  mkdirSync(join(sessionDir, 'cells'), { recursive: true });
  const path = join(sessionDir, 'cells', `${hex}.js`);
  if (!existsSync(path)) writeFileSync(path, text);
  return { file: `cells/${hex}.js`, sha256: hex };
}

// Corrects forward, under the current continuity rule, the acceptance of records that were
// accepted although they do not cover what the record before them read (source coverage only:
// that is what the records alone establish). Walks the accepted history in order; appends one
// ACCEPTANCE_CORRECTED event per such record and never edits an earlier event. Returns the events.
export function correctAcceptances(sessionDir) {
  const records = listRecords(sessionDir);
  const lifecycle = readLifecycle(sessionDir);
  const corrected = correctedAcceptances(lifecycle);
  const accepted = lifecycle.filter((e) => e.event === 'ACCEPTED').map((e) => e.record);
  const events = [];
  let effective = null;
  for (const name of accepted) {
    const r = records.find((x) => x.name === name);
    const record = r ? readRecord(r.path) : null;
    if (!record) continue;
    if (corrected.has(name)) continue; // already corrected; the effective record stays as it was
    if (effective) {
      const cov = coverage(effective.record, record);
      if (!cov.covered) {
        const verdict = continuityVerdict(effective.record, record, { name: effective.name, sha256: effective.sha256 });
        const event = {
          event: 'ACCEPTANCE_CORRECTED',
          record: name,
          record_sha256: fileSha256(r.path),
          predecessor: effective.name,
          predecessor_sha256: effective.sha256,
          reason: 'PARTIAL_SOURCE_VIEW',
          detail: verdict.detail,
          rule: CONTINUITY_RULE,
        };
        appendLifecycle(sessionDir, event);
        events.push(event);
        continue;
      }
    }
    effective = { name, sha256: fileSha256(r.path), record };
  }
  return events;
}

export function verifyRecords(sessionDir) {
  const results = [];
  const records = listRecords(sessionDir);
  const byName = new Map(records.map((r) => [r.name, r]));
  records.forEach((r, i) => {
    const side = checkSidecar(r.path);
    results.push({ check: `${r.name} sidecar`, ...side });
    const chain = checkRecord(records, i);
    const cellFailure = !chain.ok && chain.detail.startsWith('cited artifact');
    results.push({ check: `${r.name} chain`, ok: chain.ok || chain.detail.startsWith('sidecar') || cellFailure, detail: chain.ok || cellFailure ? 'predecessor bound' : chain.detail });
    const record = readRecord(r.path);
    if (record?.artifacts) results.push({ check: `${r.name} cited cells`, ...checkArtifacts(record, sessionDir) });
    // the continuity verdict a record states, re-derived from the predecessor it names
    const c = record?.continuity;
    if (c && c.verdict !== 'NO_PREDECESSOR') {
      const p = c.predecessor?.name ? byName.get(c.predecessor.name) : null;
      if (!p || fileSha256(p.path) !== c.predecessor.sha256) {
        results.push({ check: `${r.name} continuity`, ok: false, detail: `predecessor ${c.predecessor?.name ?? 'none named'} is missing or no longer has its hash` });
      } else {
        const again = continuityVerdict(readRecord(p.path), record, c.predecessor);
        const ok = again.verdict === c.verdict && again.detail === c.detail;
        results.push({ check: `${r.name} continuity`, ok, detail: ok ? `${c.verdict} against ${c.predecessor.name}, re-derived` : `states ${c.verdict}, re-derived ${again.verdict}: ${again.detail}` });
      }
    }
  });
  if (!records.length) return results;
  const lifecycle = readLifecycle(sessionDir);
  // each acceptance correction, re-derived from the two records it names
  for (const e of lifecycle.filter((x) => x.event === 'ACCEPTANCE_CORRECTED')) {
    const [r, p] = [byName.get(e.record), byName.get(e.predecessor)];
    const intact = r && p && fileSha256(r.path) === e.record_sha256 && fileSha256(p.path) === e.predecessor_sha256;
    const cov = intact ? coverage(readRecord(p.path), readRecord(r.path)) : null;
    results.push({
      check: `${e.record} acceptance correction`,
      ok: Boolean(intact && !cov.covered),
      detail: !intact ? 'a record it names is missing or no longer has its hash' : cov.covered ? `${e.record} covers ${e.predecessor}: the correction is not supported` : `does not cover ${e.predecessor}: ${e.reason}, re-derived`,
    });
  }
  const latest = readLatest(sessionDir);
  if (!latest) {
    results.push({ check: 'latest.json', ok: false, detail: 'missing or unreadable' });
    return results;
  }
  const current = records.find((r) => r.name === latest.current);
  const hashOk = Boolean(current) && latest.handoff_sha256 === fileSha256(current.path);
  if (latest.schema_version !== LATEST_SCHEMA) {
    // a pointer written before acceptance existed: it named the newest record
    const ok = hashOk && current === records.at(-1);
    results.push({ check: 'latest.json', ok, detail: ok ? `${latest.current} (pre-acceptance pointer)` : `expected ${records.at(-1).name} with its current hash` });
    return results;
  }
  const corrected = correctedAcceptances(lifecycle);
  const accepted = records.filter((r) => lifecycle.some((e) => e.event === 'ACCEPTED' && e.record === r.name) && !corrected.has(r.name) && checkRecord(records, records.indexOf(r)).ok);
  const pointerCorrected = corrected.has(latest.current);
  const ok = hashOk && latest.status === 'ACCEPTED' && accepted.at(-1)?.name === latest.current;
  results.push({
    check: 'latest.json',
    ok,
    detail: ok
      ? `${latest.current} (accepted)`
      : pointerCorrected
        ? `${latest.current}'s acceptance is corrected; the next accepted record moves the pointer (newest effective: ${accepted.at(-1)?.name ?? 'none'})`
        : `expected the newest accepted record (${accepted.at(-1)?.name ?? 'none'}) with its current hash`,
  });
  return results;
}
