import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendEntries, entryFields, parseEntries } from '../lib/changelog.mjs';
import { terminalEndpoints } from '../lib/extract.mjs';
import { blockRows, replaceBlock, syncIndex, verifyAll } from '../lib/indexblock.mjs';
import { REASON_RULE, REASON_RULE_SHA256, replacementReason } from '../lib/reasons.mjs';
import { appendRecord } from '../lib/records.mjs';

const BEGIN = '<!-- codex-handoff:begin (generated; edits inside are overwritten) -->';
const END = '<!-- codex-handoff:end -->';
const INDEX = (rows = '') => `# Index\n\n**Scope checked:** \`C:\\Work\\CODEAPI\`.\n\nHuman text.\n\n${BEGIN}\n${rows}${END}\n\n## Rules\n`;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-handoff-index-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(state, id, { at, cwd = 'C:\\Other', alignment, endpoints = [] }) {
  return appendRecord(join(state, id), {
    session_id: id,
    recorded_at: at,
    event: 'PreCompact',
    trigger: 'auto',
    source: { rollout: `C:/sessions/rollout-${id}.jsonl`, records_read: 100, cwd },
    alignment,
    handoff: { endpoints },
  });
}

const TASK = { class: 'TASK_NAME', scopes: ['C:\\Work\\CODEAPI'], evidence: { rollout_line: 13 } };
const ENDPOINT = { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', transport: '/term routes', lines: [2551, 2558] };

test('replaceBlock rewrites only the text between the markers', () => {
  const before = `# Index\r\n\r\nHuman text.\r\n${BEGIN}\r\nold\r\n${END}\r\n\r\n## Rules\r\n`;
  const { text, changed } = replaceBlock(before, 'line 1\nline 2');
  assert.equal(changed, true);
  assert.equal(text, `# Index\r\n\r\nHuman text.\r\n${BEGIN}\r\nline 1\r\nline 2\r\n${END}\r\n\r\n## Rules\r\n`);
  assert.equal(replaceBlock(text, 'line 1\nline 2').reason, 'unchanged');
});

test('replaceBlock leaves documents without exactly one pair of markers alone', () => {
  assert.match(replaceBlock('# Index\n', 'x').reason, /no codex-handoff markers/);
  assert.match(replaceBlock(`${BEGIN}\n${END}\n${END}\n`, 'x').reason, /exactly once/);
  assert.match(replaceBlock(`${END}\n${BEGIN}\n`, 'x').reason, /before the begin/);
});

test('syncIndex lists only aligned sessions, cites their evidence, and logs before it writes', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    record(state, 'aaaaaaaa-aligned', { at: '2026-10-02T15:47:24Z', alignment: TASK, endpoints: [ENDPOINT] });
    record(state, 'bbbbbbbb-other', { at: '2026-10-02T16:00:00Z', alignment: { class: 'NOT_ALIGNED', scopes: [] } });

    const first = syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    assert.equal(first.updated, true);
    const text = readFileSync(index, 'utf8');
    assert.ok(text.startsWith('# Index\n\n**Scope checked:**') && text.endsWith(`${END}\n\n## Rules\n`), 'outside the markers untouched');
    const rows = blockRows(text);
    assert.deepEqual([...rows.keys()], ['aaaaaaaa'], 'the unaligned session is not listed');
    const row = rows.get('aaaaaaaa');
    assert.ok(row.includes('task names CODEAPI (rollout line 13)'));
    assert.ok(row.includes('record 0001, sha256 `'));
    assert.ok(row.includes('`codeapi:NewSession` at `http://127.0.0.1:47339` (/term routes, rollout lines 2551, 2558)'));
    assert.deepEqual(
      parseEntries(readFileSync(log, 'utf8')).map((e) => e.text.split('\n')[0].split(' · ')[2]),
      ['BASELINE', 'ADDED']
    );
    assert.equal(syncIndex({ indexPath: index, changeLogPath: log, stateDir: state }).reason, 'unchanged');
  });
});

test('a changed row is logged with its original kept verbatim, and dropped rows move to the change log', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    record(state, 'aaaaaaaa-one', { at: '2026-10-02T10:00:00Z', alignment: TASK });
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const original = blockRows(readFileSync(index, 'utf8')).get('aaaaaaaa');

    record(state, 'aaaaaaaa-one', { at: '2026-10-02T11:00:00Z', alignment: TASK, endpoints: [ENDPOINT] });
    record(state, 'cccccccc-two', { at: '2026-10-02T12:00:00Z', alignment: { class: 'WORKSPACE', scopes: ['C:\\Work\\CODEAPI'], evidence: { field: 'cwd', value: 'C:\\Work\\CODEAPI' } } });
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state, maxSessions: 1 });

    const entries = parseEntries(readFileSync(log, 'utf8'));
    const kinds = entries.map((e) => e.text.split('\n')[0].split(' · ')[2]);
    assert.deepEqual(kinds, ['BASELINE', 'ADDED', 'ADDED', 'REMOVED']);
    const removed = entries.at(-1).text;
    assert.ok(removed.includes(`    ${original}`), 'the superseded row is kept verbatim');
    assert.ok(removed.includes('not among the 1 newest aligned sessions'));
    assert.deepEqual([...blockRows(readFileSync(index, 'utf8')).keys()], ['cccccccc']);
  });
});

test('a replaced row states the reason its two records support; a logged code they contradict is corrected forward once', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    const session = 'aaaaaaaa-one';
    // two records of the same rollout records, written by different producers
    const body = (at, terminal, code) => ({
      session_id: session,
      recorded_at: at,
      event: 'manual',
      source: { rollout: 'C:/sessions/rollout-a.jsonl', records_read: 2634, cwd: 'C:\\Other' },
      producer: { code_sha256: code.repeat(64) },
      alignment: TASK,
      classification: { TERMINAL_RECIPES: terminal },
      handoff: { endpoints: [ENDPOINT] },
    });
    appendRecord(join(state, session), body('2026-10-02T10:00:00Z', 'VERIFIED', 'a'));
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const rowA = blockRows(readFileSync(index, 'utf8')).get('aaaaaaaa');
    const b = appendRecord(join(state, session), body('2026-10-02T11:00:00Z', 'OBSERVED', 'b'));

    // what the earlier rule logged for such a replacement: NEW_EVIDENCE, not derived
    appendEntries(
      log,
      [{ kind: 'REPLACED', at: '2026-10-02T11:00:00Z', session, evidence: `record \`${b.path}\` (sha256 \`${b.sha256}\`)`, reasonCode: 'NEW_EVIDENCE', original: rowA, forward: 'row as the earlier rule wrote it', blockBefore: 'e'.repeat(64), blockAfter: 'e'.repeat(64) }],
      { documentName: 'Index.md' }
    );
    const legacy = parseEntries(readFileSync(log, 'utf8')).at(-1).text;

    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const entries = parseEntries(readFileSync(log, 'utf8'));
    const fields = entries.map(entryFields);
    assert.deepEqual(
      fields.map((f) => `${f.kind} ${f.reasonCode}`),
      ['BASELINE CHANGE_LOG_CREATED', 'ADDED NEWLY_LISTED', 'REPLACED NEW_EVIDENCE', 'CORRECTION FALSE_VERIFICATION', 'REPLACED FALSE_VERIFICATION']
    );
    assert.equal(entries[2].text, legacy, 'the corrected entry is kept as written');
    assert.equal(fields[3].corrects, 3);
    assert.deepEqual(fields[3].original, ['Reason code: NEW_EVIDENCE', 'Rule: none recorded']);
    assert.deepEqual(fields[3].forward.map((r) => r.split(': ')[0]), ['Reason code', 'Reason', 'Rule']);
    assert.equal(fields[3].forward[0], 'Reason code: FALSE_VERIFICATION');
    assert.equal(fields[3].forward[2], `Rule: ${REASON_RULE}`);
    assert.equal(fields[3].reasonRuleSha256, REASON_RULE_SHA256);
    assert.match(entries[3].text, /rollout records read 2634 → 2634 \(same rollout file\); inputs changed: none; classification: TERMINAL_RECIPES VERIFIED → OBSERVED/);
    assert.equal(fields[4].reasonRule, REASON_RULE);
    assert.ok(entries[4].text.includes('replaces record `'));

    // each contradicted code is corrected once
    assert.equal(syncIndex({ indexPath: index, changeLogPath: log, stateDir: state }).reason, 'unchanged');
    assert.equal(parseEntries(readFileSync(log, 'utf8')).length, 5);
    assert.deepEqual(
      verifyAll({ stateDir: state, indexPath: index, changeLogPath: log }).filter((r) => !r.ok),
      []
    );
  });
});

test('a reason stated under an earlier rule is re-derived, and one the records do not support is corrected once', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    const session = 'aaaaaaaa-one';
    const body = (at, rollout, records) => ({
      session_id: session,
      recorded_at: at,
      event: 'manual',
      source: { rollout, records_read: records, cwd: 'C:\\Other' },
      producer: { code_sha256: 'a'.repeat(64) },
      alignment: TASK,
      classification: { TERMINAL_RECIPES: 'OBSERVED' },
      handoff: { endpoints: [ENDPOINT] },
    });
    appendRecord(join(state, session), body('2026-10-02T21:18:40Z', 'C:/sessions/rollout-a.jsonl', 2634));
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const rowA = blockRows(readFileSync(index, 'utf8')).get('aaaaaaaa');
    // the same rollout file as the SessionStart hook names it (extended-length form)
    const b = appendRecord(join(state, session), body('2026-10-03T01:15:08Z', '\\\\?\\C:\\sessions\\rollout-a.jsonl', 2640));
    const v2 = 'codex-handoff reason rule v2 (derived from the records)';
    const v2Reason = 'rollout records read 2634 → 2640 (different rollout file); inputs changed: rollout records; classification: unchanged; producer: unchanged (code aaaaaaaaaaaa)';
    appendEntries(
      log,
      [{ kind: 'REPLACED', at: '2026-10-03T01:15:08Z', session, evidence: `record \`${b.path}\` (sha256 \`${b.sha256}\`)`, reasonCode: 'NEW_EVIDENCE', reasonRule: v2, reason: v2Reason, original: rowA, forward: 'row as rule v2 wrote it', blockBefore: 'e'.repeat(64), blockAfter: 'e'.repeat(64) }],
      { documentName: 'Index.md' }
    );

    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const entries = parseEntries(readFileSync(log, 'utf8'));
    const fields = entries.map(entryFields);
    assert.deepEqual(
      fields.map((f) => `${f.kind} ${f.reasonCode}`),
      ['BASELINE CHANGE_LOG_CREATED', 'ADDED NEWLY_LISTED', 'REPLACED NEW_EVIDENCE', 'CORRECTION NEW_EVIDENCE', 'REPLACED NEW_EVIDENCE']
    );
    assert.equal(fields[3].corrects, 3);
    assert.deepEqual(fields[3].original, ['Reason code: NEW_EVIDENCE', `Reason: ${v2Reason}`, `Rule: ${v2}`]);
    assert.deepEqual(fields[3].forward, ['Reason code: NEW_EVIDENCE', `Reason: ${v2Reason.replace('different rollout file', 'same rollout file')}`, `Rule: ${REASON_RULE}`]);
    assert.match(fields[3].reason, new RegExp(`stated under ${v2.replace(/[()]/g, '\\$&')}`));

    assert.equal(syncIndex({ indexPath: index, changeLogPath: log, stateDir: state }).reason, 'unchanged');
    assert.equal(parseEntries(readFileSync(log, 'utf8')).length, 5);
    assert.deepEqual(
      verifyAll({ stateDir: state, indexPath: index, changeLogPath: log }).filter((r) => !r.ok),
      []
    );
  });
});

test('verifyAll passes on untouched output and catches tampering of each artifact', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    const r1 = record(state, 'aaaaaaaa-one', { at: '2026-10-02T10:00:00Z', alignment: TASK });
    record(state, 'aaaaaaaa-one', { at: '2026-10-02T11:00:00Z', alignment: TASK });
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const check = () => verifyAll({ stateDir: state, indexPath: index, changeLogPath: log });
    assert.deepEqual(
      check().filter((r) => !r.ok),
      []
    );

    // a hand edit inside the generated block
    writeFileSync(index, readFileSync(index, 'utf8').replace('| [aaaaaaaa]', '| [edited]'));
    assert.ok(check().some((r) => !r.ok && r.check === 'index block matches the continuation index'));

    // a rewritten record breaks its sidecar and the next record's chain token
    writeFileSync(r1.path, readFileSync(r1.path, 'utf8').replace('"PreCompact"', '"manual"'));
    const failed = check().filter((r) => !r.ok).map((r) => r.check);
    assert.ok(failed.includes('aaaaaaaa handoff-0001.json sidecar'));
    assert.ok(failed.includes('aaaaaaaa handoff-0002.json chain'));

    // an edited change log entry breaks the sidecar and the following entry's link
    writeFileSync(log, readFileSync(log, 'utf8').replace('BASELINE', 'BASELINE (edited)'));
    const logFailures = check().filter((r) => !r.ok).map((r) => r.check);
    assert.ok(logFailures.includes('change log sidecar'));
    assert.ok(logFailures.includes('change log entry 0002'));
  });
});

const TOOLKIT = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';
const bound = (line) => ({ codeapi_window_id: TOOLKIT, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: line });

test('terminalEndpoints groups by window identity, not by locator, and keeps the newest endpoint', () => {
  // session 01a0fcec: the Toolkit window on 47339 (via /exec), then the same window on 47338
  const recipes = {
    write: { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', transport: 'EXTENSION_EXEC', line: 'return codeApiTerm.write("codeapi:NewSession",x)', lineNumber: 2081, window: bound(1959) },
    write_enter: { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47338', transport: 'REST_TERM', line: '…/term/codeapi:NewSession/write', lineNumber: 2719, window: bound(2666) },
    read: { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47338', transport: 'REST_TERM', line: '…/term/codeapi:NewSession/read', lineNumber: 2734, window: bound(2666) },
    enter: { term: 'codex', url: 'http://127.0.0.1:47341', line: "Invoke-RestMethod -Uri 'http://127.0.0.1:47341/term/codex/write'", lineNumber: 900, window: { codeapi_window_id: null, basis: 'NO_PRECEDING_SESSION_OBSERVATION' } },
  };
  assert.deepEqual(terminalEndpoints({ recipes }), [
    { term: 'codex', window: null, url: 'http://127.0.0.1:47341', urls: ['http://127.0.0.1:47341'], transports: ['/term routes'], lines: [900] },
    {
      term: 'codeapi:NewSession',
      window: { id: TOOLKIT, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: 2666 },
      url: 'http://127.0.0.1:47338',
      urls: ['http://127.0.0.1:47339', 'http://127.0.0.1:47338'],
      transports: ['codeApiTerm via /exec', '/term routes'],
      lines: [2081, 2719, 2734],
    },
  ]);
});

test('an index row names the window and its newest endpoint, not every port it once had', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    writeFileSync(index, INDEX());
    const endpoints = terminalEndpoints({
      recipes: {
        write: { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', transport: 'EXTENSION_EXEC', lineNumber: 2081, window: bound(1959) },
        read: { term: 'codeapi:NewSession', url: 'http://127.0.0.1:47338', transport: 'REST_TERM', lineNumber: 2734, window: bound(2666) },
      },
    });
    record(state, 'aaaaaaaa-one', { at: '2026-10-03T01:24:39Z', alignment: TASK, endpoints });
    syncIndex({ indexPath: index, changeLogPath: join(dir, 'change.log.md'), stateDir: state });
    const row = blockRows(readFileSync(index, 'utf8')).get('aaaaaaaa');
    assert.ok(row.includes('`codeapi:NewSession` in CodeAPI window `8030da57`, last seen at `http://127.0.0.1:47338` (codeApiTerm via /exec, /term routes, rollout lines 2081, 2734)'), row);
    assert.ok(!row.includes('at `http://127.0.0.1:47339`'), 'the window\u2019s older port is not shown as an endpoint');
  });
});

test('a rule change alone appends nothing; a statement whose records changed is reported, not re-derived', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    const session = 'aaaaaaaa-one';
    const body = (at, records) => ({ session_id: session, recorded_at: at, event: 'manual', source: { rollout: 'C:/sessions/rollout-a.jsonl', records_read: records, cwd: 'C:\\Other' }, producer: { code_sha256: 'a'.repeat(64) }, alignment: TASK, classification: { TERMINAL_RECIPES: 'OBSERVED' }, handoff: { endpoints: [ENDPOINT] } });
    const a = appendRecord(join(state, session), body('2026-10-02T21:18:40Z', 2634));
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const rowA = blockRows(readFileSync(index, 'utf8')).get('aaaaaaaa');
    const b = appendRecord(join(state, session), body('2026-10-03T01:24:39Z', 2752));
    // the same derivation, stated under an earlier rule
    const same = replacementReason(JSON.parse(readFileSync(a.path, 'utf8')), JSON.parse(readFileSync(b.path, 'utf8')));
    appendEntries(
      log,
      [{ kind: 'REPLACED', at: '2026-10-03T01:24:39Z', session, evidence: `record \`${b.path}\` (sha256 \`${b.sha256}\`); replaces record \`${a.path}\` (sha256 \`${a.sha256}\`)`, reasonCode: same.code, reasonRule: 'codex-handoff reason rule v0 (test)', reason: same.detail, original: rowA, forward: 'row', blockBefore: 'e'.repeat(64), blockAfter: 'e'.repeat(64) }],
      { documentName: 'Index.md' }
    );
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const kinds = () => parseEntries(readFileSync(log, 'utf8')).map((e) => entryFields(e).kind);
    assert.deepEqual(kinds(), ['BASELINE', 'ADDED', 'REPLACED', 'REPLACED'], 'the earlier-rule statement agrees: no CORRECTION');
    const statements = () => verifyAll({ stateDir: state, indexPath: index, changeLogPath: log }).find((r) => r.check === 'change log statements re-derived');
    assert.deepEqual([statements().ok, statements().detail], [true, '2 statement(s): 1 under the current rule, 1 re-derived and agreeing']);

    // the replaced record no longer has the hash the entry states: nothing is derived from it
    writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('"manual"', '"edited"'));
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    assert.deepEqual(kinds(), ['BASELINE', 'ADDED', 'REPLACED', 'REPLACED'], 'no correction from changed evidence');
    assert.equal(statements().ok, false);
    assert.match(statements().detail, /1 not re-derivable \(entry 0003: record .* no longer has the hash the entry states\)/);
  });
});

test('the continuation index is a projection: deleted, it is rebuilt from the records', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    const index = join(dir, 'Index.md');
    const log = join(dir, 'change.log.md');
    writeFileSync(index, INDEX());
    record(state, 'aaaaaaaa-one', { at: '2026-10-02T10:00:00Z', alignment: TASK, endpoints: [ENDPOINT] });
    syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    const before = readFileSync(index, 'utf8');
    const continuation = join(state, 'index', 'continuation-index.json');
    const listedBefore = JSON.parse(readFileSync(continuation, 'utf8')).listed;
    rmSync(continuation);
    const result = syncIndex({ indexPath: index, changeLogPath: log, stateDir: state });
    assert.equal(result.updated, false);
    assert.equal(readFileSync(index, 'utf8'), before, 'the block is unchanged');
    assert.deepEqual(JSON.parse(readFileSync(continuation, 'utf8')).listed, listedBefore);
    assert.deepEqual(
      verifyAll({ stateDir: state, indexPath: index, changeLogPath: log }).filter((r) => !r.ok),
      []
    );
  });
});

test('records without a session dir entry are reported, not listed', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    mkdirSync(join(state, 'legacy'), { recursive: true });
    writeFileSync(join(state, 'legacy', 'handoff.json'), '{}');
    const index = join(dir, 'Index.md');
    writeFileSync(index, INDEX());
    syncIndex({ indexPath: index, changeLogPath: join(dir, 'change.log.md'), stateDir: state });
    const continuation = JSON.parse(readFileSync(join(state, 'index', 'continuation-index.json'), 'utf8'));
    assert.deepEqual(continuation.not_listed, [{ session_id: 'legacy', reason: 'NO_RECORD' }]);
  });
});
