import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendEntries, entryFields, parseEntries } from '../lib/changelog.mjs';
import { CONTINUITY_RULE, continuityVerdict, coverage } from '../lib/continuity.mjs';
import { fileSha256 } from '../lib/files.mjs';
import { syncIndex, verifyAll } from '../lib/indexblock.mjs';
import { pathIdentity } from '../lib/paths.mjs';
import { appendRecord, correctAcceptances, effectiveAccepted, readLatest, readLifecycle, readRecord, verifyRecords } from '../lib/records.mjs';

const SESSION = '01a0fcec-f1d6-7d43-99e1-54ce88dbb954';
const A = 'C:\\Users\\accountName\\.codex\\sessions\\2026\\10\\02\\rollout-2026-10-02T10-03-01-01a0fcec-f1d6-7d43-99e1-54ce88dbb954.jsonl';
const B = 'C:\\Users\\accountName\\.codex\\sessions\\2026\\10\\03\\rollout-2026-10-03T12-00-29-01a0fcec-f1d6-7d43-99e1-54ce88dbb954_01a1027e-d557-7bc2-b2f0-8479df4871d6.jsonl';
const W = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';
const ALIGNED = { class: 'TASK_NAME', scopes: ['C:\\Users\\accountName\\Desktop\\HeliosEvidenceCatalog'], evidence: { rollout_line: 13 } };
const recipe = (kind, occurrence) => ({ recipe_id: `codeapi.terminal.${kind}`, derived_from: [occurrence], runtime: { terminal_id: 'codeapi:NewSession', codeapi_window_id: W } });

// A record body as save() writes it; `segments` makes it a thread record (schema v3).
function body({ rollout = A, records, segments = null, recipes = [recipe('write', 'occ-w'), recipe('read', 'occ-r')], windows = [W], keys = ['codeapi_sha256_fn', 'codeapi_helper_src'], storeTotal = null, sandbox = ['crypto', 'btoa'], alignment = ALIGNED, recordedAt = '2026-10-03T03:41:25Z' } = {}) {
  return {
    session_id: SESSION,
    recorded_at: recordedAt,
    event: 'PreCompact',
    source: { rollout, rollout_identity: pathIdentity(rollout), records_read: records, cwd: 'c:\\Users\\accountName\\Desktop\\Powershell ToolKit', ...(segments ? { segments } : {}) },
    alignment,
    recipes,
    codeapi_windows: windows.map((id) => ({ codeapi_window_id: id, port: 47338 })),
    runtime_keys: keys.map((key, i) => ({ key, stored_at_line: 2000 + i })),
    handoff: { sandbox: sandbox.map((name) => ({ name })), storeTotal: storeTotal ?? keys.length, endpoints: [] },
    rendered: { file: 'handoff.txt', sha256: '0'.repeat(64) },
  };
}
const seg = (rollout, records, offset) => ({ rollout, rollout_identity: pathIdentity(rollout), records_read: records, lines: records, line_offset: offset });
// 0006 read the first rollout file; 0007 read only the file the resume started (8 records).
const R0006 = body({ records: 3358 });
const R0007 = body({ rollout: B, records: 8, recipes: [], windows: [], keys: [], sandbox: [], alignment: { class: 'NOT_ALIGNED', scopes: [] } });
const THREAD = body({ rollout: B, records: 4183, segments: [seg(A, 3694, 0), seg(B, 489, 3694)], recipes: [recipe('write', 'occ-w'), recipe('read', 'occ-r2')], keys: ['codeapi_helper_src', 'sha256_src'], storeTotal: 12 });

function withState(fn) {
  const root = mkdtempSync(join(tmpdir(), 'codex-handoff-continuity-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a record that read only the resumed rollout file is a partial view, not a successor: CONTINUITY_REGRESSION', () => {
  const v = continuityVerdict(R0006, R0007, { name: 'handoff-0006.json', sha256: 'a'.repeat(64) });
  assert.equal(v.verdict, 'CONTINUITY_REGRESSION');
  assert.equal(v.reason, 'PARTIAL_SOURCE_VIEW');
  assert.deepEqual(v.coverage.missing.map((m) => m.rollout_identity), [pathIdentity(A)]);
  assert.match(v.detail, /does not read .*rollout-2026-10-02T10-03-01-01a0fcec.* \(3358 records in the predecessor\)/);
  // its absences are named, never read as "these facts ceased to exist"
  const missing = v.primitives.missing.map((m) => `${m.kind}:${m.id}`);
  for (const id of ['terminal_recipe:codeapi.terminal.write', 'codeapi_window:' + W, 'store_key:codeapi_sha256_fn', 'sandbox_limit:crypto', 'task_path_alignment:TASK_NAME']) {
    assert.ok(missing.includes(id), `${id} listed as missing`);
  }
});

test('a thread record covers its predecessor: preserved, refreshed and superseded primitives, nothing missing', () => {
  const v = continuityVerdict(R0006, THREAD, { name: 'handoff-0006.json', sha256: 'a'.repeat(64) });
  assert.equal(v.verdict, 'CONTINUOUS');
  // write recipe, window, two sandbox limits and the alignment preserved; the read recipe and
  // codeapi_helper_src seen again in newer occurrences; codeapi_sha256_fn displaced by newer keys
  assert.deepEqual(v.primitives.counts, { PRESERVED: 5, REFRESHED: 2, SUPERSEDED: 1, MISSING: 0 });
  assert.match(v.detail, /^covers the 1 rollout file its predecessor read/);
  // the same file read less far is not covered either
  assert.equal(coverage(R0006, body({ records: 3000 })).covered, false);
  // a primitive lost while the source is covered is still a regression
  const lost = continuityVerdict(R0006, body({ records: 3400, sandbox: ['btoa'] }));
  assert.deepEqual([lost.verdict, lost.reason], ['CONTINUITY_REGRESSION', 'PRIMITIVE_LOST']);
  // a store key no longer carried is superseded only when newer keys displaced it
  const dropped = continuityVerdict(R0006, body({ records: 3400, keys: ['codeapi_helper_src'], storeTotal: 1 }));
  assert.deepEqual(dropped.primitives.missing.map((m) => m.id), ['codeapi_sha256_fn']);
});

test('a structurally valid record that regresses is RETAINED: kept, journaled, and the pointer stays', () => {
  withState((dir) => {
    appendRecord(dir, R0006);
    const prior = effectiveAccepted(dir);
    const regressed = { ...R0007, continuity: continuityVerdict(prior.record, R0007, { name: prior.name, sha256: prior.sha256 }) };
    const result = appendRecord(dir, regressed);
    assert.deepEqual([result.accepted, result.retained], [false, true]);
    assert.match(result.reason, /^PARTIAL_SOURCE_VIEW: /);
    assert.equal(readLatest(dir).current, 'handoff-0001.json');
    const events = readLifecycle(dir).filter((e) => e.record === 'handoff-0002.json').map((e) => e.event);
    assert.deepEqual(events, ['CAPTURED', 'RETAINED']);
    assert.equal(effectiveAccepted(dir).name, 'handoff-0001.json');
    // its verdict is re-derived from the two records by verify
    const checks = verifyRecords(dir);
    assert.ok(checks.find((c) => c.check === 'handoff-0002.json continuity').ok);
    assert.ok(checks.find((c) => c.check === 'latest.json').ok);
  });
});

test('acceptances an earlier rule allowed are corrected forward, re-derived by verify, and the next covering record takes the pointer', () => {
  withState((dir) => {
    for (const b of [body({ records: 2640 }), R0006, R0007, body({ rollout: B, records: 368, recipes: [], windows: [], keys: [], sandbox: [] })]) appendRecord(dir, b);
    assert.equal(readLatest(dir).current, 'handoff-0004.json', 'accepted under the structural checks alone');
    const journal = readFileSync(join(dir, 'lifecycle.jsonl'), 'utf8');

    const events = correctAcceptances(dir);
    assert.deepEqual(events.map((e) => [e.record, e.predecessor, e.reason]), [
      ['handoff-0003.json', 'handoff-0002.json', 'PARTIAL_SOURCE_VIEW'],
      ['handoff-0004.json', 'handoff-0002.json', 'PARTIAL_SOURCE_VIEW'],
    ]);
    assert.ok(readFileSync(join(dir, 'lifecycle.jsonl'), 'utf8').startsWith(journal), 'the journal is only appended to');
    assert.deepEqual(correctAcceptances(dir), [], 'and only once');
    assert.equal(effectiveAccepted(dir).name, 'handoff-0002.json');

    let checks = verifyRecords(dir);
    assert.ok(checks.find((c) => c.check === 'handoff-0003.json acceptance correction').ok);
    const pointer = checks.find((c) => c.check === 'latest.json');
    assert.equal(pointer.ok, false);
    assert.match(pointer.detail, /acceptance is corrected/);

    const prior = effectiveAccepted(dir);
    const next = { ...THREAD, continuity: continuityVerdict(prior.record, THREAD, { name: prior.name, sha256: prior.sha256 }) };
    assert.equal(appendRecord(dir, next).accepted, true);
    assert.equal(readLatest(dir).current, 'handoff-0005.json');
    assert.deepEqual(readLifecycle(dir).at(-1), { ...readLifecycle(dir).at(-1), event: 'SUPERSEDED', record: 'handoff-0004.json', by: 'handoff-0005.json' });
    checks = verifyRecords(dir);
    assert.ok(checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join('; '));
    assert.equal(readRecord(join(dir, 'records', 'handoff-0005.json')).continuity.predecessor.name, 'handoff-0002.json');
  });
});

test('a correction the records do not support fails verify', () => {
  withState((dir) => {
    appendRecord(dir, body({ records: 100 }));
    appendRecord(dir, body({ records: 200 }));
    // a hand-written correction claiming that 0002, which covers 0001, regressed
    const forged = {
      at: '2026-10-03T17:00:00Z',
      event: 'ACCEPTANCE_CORRECTED',
      record: 'handoff-0002.json',
      record_sha256: fileSha256(join(dir, 'records', 'handoff-0002.json')),
      predecessor: 'handoff-0001.json',
      predecessor_sha256: fileSha256(join(dir, 'records', 'handoff-0001.json')),
      reason: 'PARTIAL_SOURCE_VIEW',
    };
    writeFileSync(join(dir, 'lifecycle.jsonl'), `${readFileSync(join(dir, 'lifecycle.jsonl'), 'utf8')}${JSON.stringify(forged)}\n`);
    const check = verifyRecords(dir).find((c) => c.check === 'handoff-0002.json acceptance correction');
    assert.equal(check.ok, false);
    assert.match(check.detail, /covers handoff-0001\.json: the correction is not supported/);
  });
});

// The index flow of thread 01a0fcec: a row listed from the full record, removed when a partial
// record became the pointer (NOT_ALIGNED), added again from the next partial record, then replaced
// by a thread record. The two entries that rested on partial records are corrected forward once.
test('change-log entries that rested on a corrected record get one CORRECTION each; the entries stay as written', () => {
  withState((root) => {
    const state = join(root, 'state');
    const dir = join(state, SESSION);
    mkdirSync(dir, { recursive: true });
    const index = join(root, 'index.md');
    const log = join(root, 'change.log.md');
    writeFileSync(index, '# Index\n<!-- codex-handoff:begin -->\nold\n<!-- codex-handoff:end -->\n');
    const opts = { indexPath: index, changeLogPath: log, stateDir: state, lockPath: join(root, 'lock') };

    appendRecord(dir, R0006);
    syncIndex(opts); // BASELINE + ADDED (record 0001)
    appendRecord(dir, R0007);
    // the removal and the acceptance it rested on, in the order the hooks wrote them
    const lifecycle = readLifecycle(dir).map((e, i) => ({ ...e, at: `2026-10-03T16:00:${String(10 + i).padStart(2, '0')}Z` }));
    writeFileSync(join(dir, 'lifecycle.jsonl'), lifecycle.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const removedAt = lifecycle.at(-1).at;
    const blockBefore = parseEntries(readFileSync(log, 'utf8')).length;
    appendEntries(log, [{ kind: 'REMOVED', at: removedAt, session: SESSION.slice(0, 8), reasonCode: 'NOT_ALIGNED', reason: 'NOT_ALIGNED', original: '| [01a0fcec](x) | row |', forward: null, blockBefore: 'b', blockAfter: 'c' }], { documentName: 'index.md' });
    assert.ok(blockBefore > 0);

    const corrected = correctAcceptances(dir);
    assert.deepEqual(corrected.map((e) => e.record), ['handoff-0002.json']);
    const prior = effectiveAccepted(dir);
    appendRecord(dir, { ...THREAD, continuity: continuityVerdict(prior.record, THREAD, { name: prior.name, sha256: prior.sha256 }) });

    syncIndex(opts);
    const fields = parseEntries(readFileSync(log, 'utf8')).map(entryFields);
    const corrections = fields.filter((f) => f.kind === 'CORRECTION' && f.reasonRule === CONTINUITY_RULE);
    const removed = fields.find((f) => f.kind === 'REMOVED');
    assert.deepEqual(corrections.map((c) => [c.corrects, c.reasonCode]), [[removed.sequence, 'PARTIAL_SOURCE_VIEW']]);
    assert.match(corrections[0].reason, /rested on record handoff-0002\.json, which does not read/);
    assert.deepEqual(removed.original, ['| [01a0fcec](x) | row |'], 'the corrected entry is unchanged');

    const before = readFileSync(log, 'utf8');
    syncIndex(opts);
    assert.equal(readFileSync(log, 'utf8'), before, 'corrected once');
    const results = verifyAll({ stateDir: state, indexPath: index, changeLogPath: log });
    const onCorrected = results.find((r) => r.check === 'change log entries on corrected records');
    assert.ok(onCorrected.ok, onCorrected.detail);
    assert.match(onCorrected.detail, /1 entry rested on a record whose acceptance was corrected/);
  });
});
