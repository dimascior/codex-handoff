// Keeps one generated block in a human-maintained index document in step with the hand-off
// records, following the HeliosEntitlementAuthority evidence conventions:
// - a row is written only for a session whose newest record (sidecar-verified) shows work inside
//   the index's task paths, and the row cites that evidence: record and hash, rollout lines;
// - nothing is lost: every change is first appended to the change log (superseded rows kept
//   verbatim, entries hash-chained), then applied to the block;
// - the reason code of a replaced row is derived by comparing the two records (reasons.mjs); a
//   code logged earlier that the records contradict is corrected forward by a CORRECTION entry;
// - a continuation index with a sidecar records what the block was derived from.
// Only the text between the two markers is ever replaced; without both markers nothing is written.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { appendEntries, entryFields, parseEntries, verifyChangeLog } from './changelog.mjs';
import { CONTINUITY_RULE } from './continuity.mjs';
import { checkSidecar, fileSha256, lf, sha256, writeAtomic, writeSidecar } from './files.mjs';
import { readLifecycle, verifyRecords } from './records.mjs';
import { REASON_RULE, REASON_RULE_SHA256, rowReplacementReason } from './reasons.mjs';
import { locate } from './thread.mjs';

const BEGIN = /<!-- codex-handoff:begin\b[^>]*-->/g;
const END = /<!-- codex-handoff:end -->/g;
const CONTINUATION_SCHEMA = 'codex-handoff-index-continuation.v1';

function locateBlock(text) {
  const begins = [...text.matchAll(BEGIN)];
  const ends = [...text.matchAll(END)];
  if (!begins.length && !ends.length) return { reason: 'no codex-handoff markers in the index' };
  if (begins.length !== 1 || ends.length !== 1) return { reason: 'codex-handoff markers must each appear exactly once' };
  const start = begins[0].index + begins[0][0].length;
  const stop = ends[0].index;
  if (stop < start) return { reason: 'codex-handoff end marker comes before the begin marker' };
  return { start, stop, inner: text.slice(start, stop) };
}

export function replaceBlock(text, body) {
  const at = locateBlock(text);
  if (at.reason) return { text, reason: at.reason };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const inner = `${eol}${body.split(/\r?\n/).join(eol)}${eol}`;
  if (at.inner === inner) return { text, reason: 'unchanged' };
  return { text: text.slice(0, at.start) + inner + text.slice(at.stop), changed: true };
}

export const blockSha256 = (inner) => sha256(lf(inner));

// Table rows of the block, keyed by the session label in their first cell.
export function blockRows(inner) {
  const rows = new Map();
  for (const line of lf(inner).split('\n')) {
    const m = line.match(/^\| \[([^\]]+)\]/);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Two Codex windows can compact at the same moment: one writer at a time, stale locks expire.
function acquireLock(lockPath, waitMs = 3000, staleMs = 30000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) return false;
      sleep(50);
    }
  }
}

const short = (id) => String(id).slice(0, 8);

// The newest record of each session, checked against its sidecar and latest.json.
export function collectFromRecords(stateDir) {
  const listed = [];
  const skipped = [];
  if (!existsSync(stateDir)) return { listed, skipped };
  for (const name of readdirSync(stateDir)) {
    const dir = join(stateDir, name);
    const latestPath = join(dir, 'latest.json');
    if (!existsSync(latestPath)) {
      if (existsSync(join(dir, 'handoff.json'))) skipped.push({ session_id: name, reason: 'NO_RECORD' });
      continue;
    }
    try {
      const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
      const recordPath = join(dir, 'records', latest.current);
      const side = checkSidecar(recordPath);
      if (!side.ok || side.detail !== latest.handoff_sha256) {
        skipped.push({ session_id: name, reason: 'RECORD_HASH_MISMATCH', detail: side.detail });
        continue;
      }
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      const entry = {
        session_id: record.session_id ?? name,
        dir,
        record: { name: latest.current, path: recordPath, sha256: latest.handoff_sha256, recorded_at: record.recorded_at, event: record.event, trigger: record.trigger },
        source: record.source ?? {},
        alignment: record.alignment ?? { class: 'NOT_ALIGNED', scopes: [] },
        endpoints: record.handoff?.endpoints ?? [],
      };
      if (entry.alignment.class === 'NOT_ALIGNED') skipped.push({ session_id: entry.session_id, reason: 'NOT_ALIGNED' });
      else listed.push(entry);
    } catch (error) {
      skipped.push({ session_id: name, reason: 'UNREADABLE', detail: error.message });
    }
  }
  listed.sort((a, b) => String(b.record.recorded_at).localeCompare(String(a.record.recorded_at)));
  return { listed, skipped };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s) => `\`${cell(s)}\``;
const nameOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop();

// Thread lines as the reader finds them: plain line numbers for a thread kept in one rollout file,
// "file:line" (rollout file number in the thread, line in that file) when it spans several.
const segmentsOf = (source) => (Array.isArray(source?.segments) && source.segments.length > 1 ? source.segments : null);
function linesText(source, lines, label = 'rollout line') {
  const segs = segmentsOf(source);
  const list = [...new Set(lines)].sort((a, b) => a - b);
  if (!segs) return `${label}${list.length > 1 ? 's' : ''} ${list.join(', ')}`;
  const shown = list.map((n) => {
    const at = locate(segs, n);
    return `${at.segment + 1}:${at.line}`;
  });
  return `${label}${list.length > 1 ? 's' : ''} ${shown.join(', ')} (rollout file:line)`;
}

function alignmentText(a, source) {
  const names = (a.scopes ?? []).map(nameOf).join(', ');
  if (a.class === 'WORKSPACE') return `workspace inside ${names}`;
  const line = a.evidence?.rollout_line ? ` (${linesText(source, [a.evidence.rollout_line])})` : '';
  return a.class === 'TASK_PATH' ? `task names the path of ${names}${line}` : `task names ${names}${line}`;
}

function whenText(r) {
  const how = r.event === 'manual' ? 'manual snapshot' : r.event === 'PreCompact' ? `before compaction${r.trigger ? `, ${r.trigger}` : ''}` : 'at session start';
  const seq = r.name.match(/\d+/)?.[0] ?? r.name;
  return `${String(r.recorded_at).slice(0, 16).replace('T', ' ')} UTC (${how}); record ${seq}, sha256 ${code(r.sha256.slice(0, 12))}`;
}

// Records that bind CodeAPI windows group terminal endpoints by identity (window + terminal) and
// show the newest endpoint of each; older records list each locator as it was recorded.
function terminalsText(endpoints, source) {
  if (!endpoints.length) return 'none recorded';
  return endpoints
    .map((e) => {
      const lines = e.lines?.length ? `, ${linesText(source, e.lines)}` : '';
      if (!Array.isArray(e.transports)) return `${code(e.term)}${e.url ? ` at ${code(e.url)}` : ''} (${cell(e.transport)}${lines})`;
      const window = e.window?.id ? `CodeAPI window ${code(e.window.id.slice(0, 8))}` : 'CodeAPI window not identified';
      return `${code(e.term)} in ${window}, last seen at ${e.url ? code(e.url) : 'unknown'} (${cell(e.transports.join(', '))}${lines})`;
    })
    .join('; ');
}

export function renderRow(entry, indexPath) {
  const link = relative(dirname(indexPath), join(entry.dir, 'handoff.txt')).split(sep).join('/');
  const workspace = entry.source.cwd ? code(entry.source.cwd) : 'unknown';
  return `| [${short(entry.session_id)}](${link}) | ${workspace} | ${alignmentText(entry.alignment, entry.source)} | ${whenText(entry.record)} | ${terminalsText(entry.endpoints, entry.source)} |`;
}

export function renderBlock(rows, { changeLogName, changeLogLink }) {
  return [
    `_Written by the codex-handoff hooks from their hand-off records. Listed: sessions whose records show work inside this index's scope (workspace or task text). Session evidence, not policy: recheck runtime identities (port, terminal, PID) before relying on them. Every change to this block is kept in [${changeLogName}](${encodeURI(changeLogLink)})._`,
    '',
    '| Session | Workspace | Task-path evidence | Last hand-off | Terminal last seen working |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| none yet | | | | |']),
  ].join('\n');
}

function evidenceText(entry, previous = null) {
  const lines = entry.endpoints.flatMap((e) => e.lines ?? []);
  const segs = segmentsOf(entry.source);
  const rollout = segs
    ? `rollout files ${segs.map((s, i) => `${i + 1}: \`${s.rollout}\` (${s.records_read ?? '?'} records read)`).join(', ')}`
    : `rollout \`${entry.source.rollout ?? 'unknown'}\` (${entry.source.records_read ?? '?'} records read)`;
  return [
    `record \`${entry.record.path}\` (sha256 \`${entry.record.sha256}\`)`,
    rollout,
    `alignment ${entry.alignment.class}: ${alignmentText(entry.alignment, entry.source)}`,
    lines.length
      ? segs
        ? `terminal calls at ${linesText(entry.source, lines)}`
        : `terminal calls at rollout lines ${[...new Set(lines)].sort((a, b) => a - b).join(', ')}`
      : 'no working terminal call recorded',
    ...(previous ? [`replaces record \`${previous.path}\` (sha256 \`${previous.sha256}\`)`] : []),
  ].join('; ');
}

const rowValue = (rows, label) => rows.find((r) => r.startsWith(`${label}: `))?.slice(label.length + 2) ?? null;

// The statement in force for each replaced row: the newest CORRECTION's forward value, else the
// entry's own (code, reason and the rule that stated them; entries without "Derived by" predate
// derivation and state a code only). CORRECTION entries are never evaluated as statements of
// their own; they only supersede the entry they name.
function statementsInForce(fields) {
  return fields
    .filter((f) => f.kind === 'REPLACED' && f.reasonCode && f.record && f.original.length)
    .map((f) => {
      const latest = fields.filter((c) => c.kind === 'CORRECTION' && c.corrects === f.sequence).at(-1);
      const stated = latest
        ? { code: latest.reasonCode, reason: rowValue(latest.forward, 'Reason'), rule: rowValue(latest.forward, 'Rule') ?? latest.reasonRule }
        : { code: f.reasonCode, reason: f.reasonRule ? f.reason : null, rule: f.reasonRule };
      return { f, stated };
    });
}

// A statement re-derived under the current rule from the two records it rests on, each checked
// against the hash the entry states. A rule change alone is no contradiction: only a different
// code or reason is (DIFFERS). Missing or changed records make it UNAVAILABLE: nothing is derived
// from evidence that is not there.
function rederive({ f, stated }) {
  // a statement under the current reason rule, or one corrected under the continuity rule (it is
  // checked by verifyAcceptanceCorrections, not re-derived as a reason)
  if (stated.rule === REASON_RULE || stated.rule === CONTINUITY_RULE) return { status: 'CURRENT_RULE' };
  if (!existsSync(f.record.path) || fileSha256(f.record.path) !== f.record.sha256) return { status: 'UNAVAILABLE', detail: `record ${f.record.path} is missing or no longer has its hash` };
  const why = rowReplacementReason(f.original[0], { dir: dirname(dirname(f.record.path)), path: f.record.path, sha256: f.record.sha256 }, f.previous);
  if (why.code === 'UNRESOLVED') return { status: 'UNAVAILABLE', detail: why.detail };
  const agrees = why.code === stated.code && (stated.reason === null || stated.reason === why.detail);
  return { status: agrees ? 'AGREES' : 'DIFFERS', why };
}

// One CORRECTION entry for each statement the records contradict under the current rule; the
// corrected entry is never changed.
function reasonCorrections(logged, at, blockSha) {
  const out = [];
  for (const s of statementsInForce(logged.map(entryFields))) {
    const r = rederive(s);
    if (r.status !== 'DIFFERS') continue;
    const { f, stated } = s;
    const entryNo = String(f.sequence).padStart(4, '0');
    const earlier = stated.rule ? `stated under ${stated.rule}` : 'stated by a rule that gave every replacement by a newer record NEW_EVIDENCE';
    out.push({
      kind: 'CORRECTION',
      at,
      corrects: f.sequence,
      session: f.session,
      evidence: `record \`${f.record.path}\` (sha256 \`${f.record.sha256}\`), replacing record \`${r.why.from.path}\` (sha256 \`${r.why.from.sha256}\`)`,
      reasonCode: r.why.code,
      reasonRule: REASON_RULE,
      reasonRuleSha256: REASON_RULE_SHA256,
      reason: `${r.why.detail}. Entry ${entryNo}'s statement was ${earlier}; the records support the forward value`,
      original: [`Reason code: ${stated.code}`, ...(stated.reason ? [`Reason: ${stated.reason}`] : []), `Rule: ${stated.rule ?? 'none recorded'}`],
      forward: [`Reason code: ${r.why.code}`, `Reason: ${r.why.detail}`, `Rule: ${REASON_RULE}`],
      blockBefore: blockSha,
      blockAfter: blockSha,
    });
  }
  return out;
}

// The record a change-log entry rested on: the record its evidence names (ADDED, REPLACED), or, for
// a REMOVED entry, the record the session's journal had accepted at that moment (its last ACCEPTED
// event up to the entry's time). Null when the entry rests on no record.
function basisRecord(f, stateDir) {
  if ((f.kind === 'ADDED' || f.kind === 'REPLACED') && f.record) {
    return { dir: dirname(dirname(f.record.path)), name: basename(f.record.path), path: f.record.path, sha256: f.record.sha256 };
  }
  if (f.kind !== 'REMOVED' || !f.session || !f.at || !existsSync(stateDir)) return null;
  const dirs = readdirSync(stateDir).filter((name) => name.startsWith(f.session) && existsSync(join(stateDir, name, 'records')));
  if (dirs.length !== 1) return null;
  const dir = join(stateDir, dirs[0]);
  const accepted = readLifecycle(dir).filter((e) => e.event === 'ACCEPTED' && e.at <= f.at).at(-1);
  if (!accepted) return null;
  const path = join(dir, 'records', accepted.record);
  return existsSync(path) ? { dir, name: accepted.record, path, sha256: fileSha256(path) } : null;
}

// Entries that rested on a record whose acceptance the session's journal has since corrected
// (ACCEPTANCE_CORRECTED, lib/records.mjs), each with that correction event.
function entriesOnCorrectedRecords(fields, stateDir) {
  const out = [];
  for (const f of fields) {
    if (!['ADDED', 'REPLACED', 'REMOVED'].includes(f.kind)) continue;
    const basis = basisRecord(f, stateDir);
    if (!basis) continue;
    const event = readLifecycle(basis.dir).find((e) => e.event === 'ACCEPTANCE_CORRECTED' && e.record === basis.name);
    if (event) out.push({ f, basis, event });
  }
  return out;
}

const hasContinuityCorrection = (fields, sequence) => fields.some((c) => c.kind === 'CORRECTION' && c.corrects === sequence && c.reasonRule === CONTINUITY_RULE);

// One CORRECTION entry for each entry that rested on a record whose acceptance was corrected: the
// entry stays as written; the correction says why its statement does not describe the session.
function acceptanceCorrections(logged, stateDir, at, blockSha) {
  const fields = logged.map(entryFields);
  const out = [];
  for (const { f, basis, event } of entriesOnCorrectedRecords(fields, stateDir)) {
    if (hasContinuityCorrection(fields, f.sequence)) continue;
    const entryNo = String(f.sequence).padStart(4, '0');
    const stated = `${f.kind}, ${f.reasonCode ?? 'no reason code'}`;
    out.push({
      kind: 'CORRECTION',
      at,
      corrects: f.sequence,
      session: f.session,
      evidence: `record \`${basis.path}\` (sha256 \`${basis.sha256}\`); session lifecycle ACCEPTANCE_CORRECTED at ${event.at} against record ${event.predecessor} (sha256 \`${event.predecessor_sha256}\`)`,
      reasonCode: event.reason,
      reasonRule: CONTINUITY_RULE,
      reason: `Entry ${entryNo} (${stated}) rested on record ${basis.name}, which ${event.detail}. Under ${CONTINUITY_RULE} that record does not replace ${event.predecessor} as the accepted hand-off, so the entry's statement does not describe the session; the session's next entry gives the row's forward value`,
      original: [`Kind: ${f.kind}`, ...(f.reasonCode ? [`Reason code: ${f.reasonCode}`] : []), ...(f.reason ? [`Reason: ${f.reason}`] : []), `Rule: ${f.reasonRule ?? 'none recorded'}`],
      forward: [`Reason code: ${event.reason}`, `Reason: rested on record ${basis.name}, which is not the accepted hand-off (${event.detail})`, `Rule: ${CONTINUITY_RULE}`],
      blockBefore: blockSha,
      blockAfter: blockSha,
    });
  }
  return out;
}

// For verify: every entry that rested on a record whose acceptance was corrected has its correction.
export function verifyAcceptanceCorrections(logPath, stateDir) {
  const fields = parseEntries(readFileSync(logPath, 'utf8')).map(entryFields);
  const affected = entriesOnCorrectedRecords(fields, stateDir);
  const missing = affected.filter(({ f }) => !hasContinuityCorrection(fields, f.sequence));
  const entryNo = (x) => String(x.f.sequence).padStart(4, '0');
  return {
    check: 'change log entries on corrected records',
    ok: !missing.length,
    detail: missing.length
      ? `${missing.length} without a correction (entries ${missing.map(entryNo).join(', ')}; 'handoff.mjs index' appends them)`
      : `${affected.length} entr${affected.length === 1 ? 'y' : 'ies'} rested on a record whose acceptance was corrected${affected.length ? `, each corrected forward (entries ${affected.map(entryNo).join(', ')})` : ''}`,
  };
}

// For verify: every statement in force, re-derived without writing anything.
export function verifyStatements(logPath) {
  const results = statementsInForce(parseEntries(readFileSync(logPath, 'utf8')).map(entryFields)).map((s) => ({ s, r: rederive(s) }));
  const count = (status) => results.filter((x) => x.r.status === status);
  const differs = count('DIFFERS');
  const unavailable = count('UNAVAILABLE');
  const entryNo = (x) => String(x.s.f.sequence).padStart(4, '0');
  const parts = [`${results.length} statement(s): ${count('CURRENT_RULE').length} under the current rule, ${count('AGREES').length} re-derived and agreeing`];
  if (differs.length) parts.push(`${differs.length} differing (entries ${differs.map(entryNo).join(', ')}; 'handoff.mjs index' appends their corrections)`);
  if (unavailable.length) parts.push(`${unavailable.length} not re-derivable (${unavailable.map((x) => `entry ${entryNo(x)}: ${x.r.detail}`).join('; ')})`);
  return { check: 'change log statements re-derived', ok: !differs.length && !unavailable.length, detail: parts.join(', ') };
}

function writeContinuation(stateDir, state, newHistory) {
  const dir = join(stateDir, 'index');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'continuation-index.json');
  let history = [];
  if (existsSync(path)) {
    try {
      history = JSON.parse(readFileSync(path, 'utf8')).history ?? [];
    } catch {
      history = []; // the change log keeps the full history regardless
    }
  }
  writeAtomic(path, `${JSON.stringify({ schema_version: CONTINUATION_SCHEMA, ...state, history: [...history, ...newHistory] }, null, 2)}\n`);
  writeSidecar(path);
}

export function syncIndex({ indexPath, changeLogPath, stateDir, maxSessions = 5, lockPath }) {
  if (!existsSync(indexPath)) return { updated: false, reason: `index not found: ${indexPath}` };
  if (!acquireLock(lockPath ?? join(stateDir, 'index.lock'))) return { updated: false, reason: 'index is locked by another codex-handoff run' };
  try {
    const text = readFileSync(indexPath, 'utf8');
    const at = locateBlock(text);
    if (at.reason) return { updated: false, reason: at.reason };
    const oldRows = blockRows(at.inner);
    const { listed, skipped } = collectFromRecords(stateDir);
    const shown = listed.slice(0, maxSessions);
    const newRows = new Map(shown.map((e) => [short(e.session_id), { row: renderRow(e, indexPath), entry: e }]));
    const changeLogLink = relative(dirname(indexPath), changeLogPath).split(sep).join('/');
    const body = renderBlock([...newRows.values()].map((v) => v.row), { changeLogName: basename(changeLogPath), changeLogLink });
    const replaced = replaceBlock(text, body);
    const blockBefore = blockSha256(at.inner);
    const blockAfter = replaced.changed ? blockSha256(locateBlock(replaced.text).inner) : blockBefore;

    const at0 = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const entries = [];
    // Reason codes: CHANGE_LOG_CREATED; NEWLY_LISTED for an added row; for a replaced row the
    // code derived from its two records (reasons.mjs); for removals BEYOND_MAX_SESSIONS or the
    // reason the session is no longer listed (NOT_ALIGNED, NO_RECORD, RECORD_HASH_MISMATCH,
    // UNREADABLE).
    if (!existsSync(changeLogPath)) {
      entries.push({ kind: 'BASELINE', at: at0, original: [...oldRows.values()], reasonCode: 'CHANGE_LOG_CREATED', reason: 'block as found when the change log was created', blockBefore, blockAfter: blockBefore });
    } else {
      const logged = parseEntries(readFileSync(changeLogPath, 'utf8'));
      entries.push(...reasonCorrections(logged, at0, blockBefore), ...acceptanceCorrections(logged, stateDir, at0, blockBefore));
    }
    for (const [key, { row, entry }] of newRows) {
      const old = oldRows.get(key);
      if (old === row) continue;
      if (!old) {
        entries.push({ kind: 'ADDED', at: at0, session: entry.session_id, reasonCode: 'NEWLY_LISTED', evidence: evidenceText(entry), original: null, forward: row, blockBefore, blockAfter });
        continue;
      }
      const why = rowReplacementReason(old, { dir: entry.dir, path: entry.record.path, sha256: entry.record.sha256 });
      entries.push({
        kind: 'REPLACED',
        at: at0,
        session: entry.session_id,
        reasonCode: why.code,
        reasonRule: REASON_RULE,
        reasonRuleSha256: REASON_RULE_SHA256,
        reason: why.detail,
        evidence: evidenceText(entry, why.from),
        original: old,
        forward: row,
        blockBefore,
        blockAfter,
      });
    }
    for (const [key, old] of oldRows) {
      if (newRows.has(key)) continue;
      const beyond = listed.find((e) => short(e.session_id) === key);
      const skip = skipped.find((s) => short(s.session_id) === key);
      const reasonCode = beyond ? 'BEYOND_MAX_SESSIONS' : (skip?.reason ?? 'NO_RECORD');
      const reason = beyond ? `not among the ${maxSessions} newest aligned sessions` : skip ? `${skip.reason}${skip.detail ? `: ${skip.detail}` : ''}` : 'no hand-off record for this session';
      entries.push({ kind: 'REMOVED', at: at0, session: key, reasonCode, reason, original: old, forward: null, blockBefore, blockAfter });
    }
    // The continuation index is a projection of the records: rebuilt when missing, even if the
    // block itself is unchanged.
    const continuationMissing = !existsSync(join(stateDir, 'index', 'continuation-index.json'));
    if (!replaced.changed && !entries.length && !continuationMissing) return { updated: false, reason: 'unchanged' };

    // History first: the change log holds every superseded row before the block changes.
    const head = entries.length ? appendEntries(changeLogPath, entries, { documentName: basename(indexPath) }) : null;
    if (replaced.changed) {
      const tmp = `${indexPath}.codex-handoff-${process.pid}.tmp`;
      writeFileSync(tmp, replaced.text);
      renameSync(tmp, indexPath);
    }
    const logHead = head ?? parseEntries(readFileSync(changeLogPath, 'utf8')).at(-1) ?? null;
    writeContinuation(
      stateDir,
      {
        index_path: indexPath,
        index_sha256: fileSha256(indexPath),
        block_sha256: blockAfter,
        change_log: changeLogPath,
        change_log_head: logHead ? { sequence: logHead.sequence, entry_sha256: logHead.sha256 } : null,
        max_sessions: maxSessions,
        listed: shown.map((e) => ({ session_id: e.session_id, record: e.record.path, record_sha256: e.record.sha256, alignment: e.alignment.class })),
        not_listed: [
          ...listed.slice(maxSessions).map((e) => ({ session_id: e.session_id, reason: 'BEYOND_MAX_SESSIONS' })),
          ...skipped,
        ],
        updated_at: at0,
      },
      entries.map((e) => ({ at: e.at, kind: e.kind, session: e.session ?? null, ...(e.corrects ? { corrects: e.corrects } : {}), ...(e.reasonCode ? { reason_code: e.reasonCode } : {}) }))
    );
    return {
      updated: Boolean(replaced.changed),
      entries: entries.length,
      reason: replaced.changed || entries.length ? undefined : 'block unchanged; continuation index rebuilt from the records',
    };
  } finally {
    rmSync(lockPath ?? join(stateDir, 'index.lock'), { force: true });
  }
}

// Re-derives everything the hooks wrote: record chains, the change log chain, and whether the
// index block is still the one the continuation index records (no hand edits inside it).
export function verifyAll({ stateDir, indexPath, changeLogPath }) {
  const results = [];
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir)) {
      const dir = join(stateDir, name);
      if (!existsSync(join(dir, 'records'))) continue;
      for (const r of verifyRecords(dir)) results.push({ ...r, check: `${short(name)} ${r.check}` });
    }
  }
  if (changeLogPath && existsSync(changeLogPath)) {
    results.push(...verifyChangeLog(changeLogPath), verifyStatements(changeLogPath), verifyAcceptanceCorrections(changeLogPath, stateDir));
  }
  const continuation = join(stateDir, 'index', 'continuation-index.json');
  if (existsSync(continuation)) {
    results.push({ check: 'continuation index sidecar', ...checkSidecar(continuation) });
    try {
      const state = JSON.parse(readFileSync(continuation, 'utf8'));
      const at = indexPath && existsSync(indexPath) ? locateBlock(readFileSync(indexPath, 'utf8')) : { reason: 'index not found' };
      const ok = !at.reason && blockSha256(at.inner) === state.block_sha256;
      results.push({ check: 'index block matches the continuation index', ok, detail: at.reason ?? (ok ? state.block_sha256 : 'the block was changed outside the hooks') });
    } catch (error) {
      results.push({ check: 'continuation index parses', ok: false, detail: error.message });
    }
  }
  return results;
}
