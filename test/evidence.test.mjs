import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseScopePaths, scopeAlignment } from '../lib/alignment.mjs';
import { canonicalJson, contentId } from '../lib/canonical.mjs';
import { appendEntries, parseEntries, verifyChangeLog } from '../lib/changelog.mjs';
import { claimsOf, classifyHandoff, occurrencesOf, openGaps, recipesOf, runtimeKeysOf, withoutSources } from '../lib/evidence.mjs';
import { fileSha256, lf, sha256 } from '../lib/files.mjs';
import { acceptedHandoff, appendRecord, listRecords, readLifecycle, saveCell, verifyRecords } from '../lib/records.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-handoff-evidence-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('records chain to their predecessor by hash, never overwrite, and move latest.json only once accepted', () => {
  withDir((dir) => {
    const a = appendRecord(dir, { session_id: 's1', note: 'first' });
    const b = appendRecord(dir, { session_id: 's1', note: 'second', sequence: 99, continuation_from: 'forged.json' });
    assert.equal(a.accepted && b.accepted, true);
    assert.deepEqual(
      listRecords(dir).map((r) => r.name),
      ['handoff-0001.json', 'handoff-0002.json']
    );
    const second = readJson(b.path);
    assert.equal(second.sequence, 2, 'a body cannot set the chain fields');
    assert.equal(second.continuation_from, 'handoff-0001.json');
    assert.equal(second.continuation_token_sha256, fileSha256(a.path));
    assert.equal(readFileSync(`${b.path}.sha256`, 'utf8'), `${b.sha256}  handoff-0002.json\n`);
    const latest = readJson(join(dir, 'latest.json'));
    assert.equal(latest.schema_version, 'codex-handoff-latest.v2');
    assert.equal(latest.current, 'handoff-0002.json');
    assert.equal(latest.handoff_sha256, b.sha256);
    assert.equal(latest.status, 'ACCEPTED');
    assert.equal(latest.prior, 'handoff-0001.json');
    assert.deepEqual(
      readLifecycle(dir).map((e) => `${e.event} ${e.record}`),
      ['CAPTURED handoff-0001.json', 'ACCEPTED handoff-0001.json', 'CAPTURED handoff-0002.json', 'ACCEPTED handoff-0002.json', 'SUPERSEDED handoff-0001.json']
    );
    assert.equal(readLifecycle(dir).at(-1).by, 'handoff-0002.json');
    assert.deepEqual(
      verifyRecords(dir).filter((r) => !r.ok),
      []
    );
  });
});

test('a record that fails its checks is kept but latest.json does not move to it', () => {
  withDir((dir) => {
    appendRecord(dir, { session_id: 's1' });
    const bad = appendRecord(dir, { note: 'no session id' });
    assert.equal(bad.accepted, false);
    assert.match(bad.reason, /no session_id/);
    assert.equal(readJson(join(dir, 'latest.json')).current, 'handoff-0001.json');
    assert.deepEqual(
      readLifecycle(dir).map((e) => e.event),
      ['CAPTURED', 'ACCEPTED', 'CAPTURED', 'REJECTED']
    );
    // latest.json correctly names the newest accepted record, not the newest record
    assert.ok(verifyRecords(dir).find((r) => r.check === 'latest.json').ok);
    // a later good record chains to the rejected one (history is kept) and is accepted
    const next = appendRecord(dir, { session_id: 's1' });
    assert.equal(readJson(next.path).continuation_from, 'handoff-0002.json');
    assert.equal(readJson(join(dir, 'latest.json')).prior, 'handoff-0001.json');
  });
});

test('a record is accepted only while every cell it cites is there with its hash', () => {
  withDir((dir) => {
    const cell = saveCell(dir, 'store("k", 1);\n');
    const good = appendRecord(dir, { session_id: 's1', artifacts: [{ role: 'store_cell', key: 'k', ...cell }] });
    assert.equal(good.accepted, true);
    const missing = appendRecord(dir, { session_id: 's1', artifacts: [{ role: 'store_cell', key: 'x', file: `cells/${'0'.repeat(64)}.js`, sha256: '0'.repeat(64) }] });
    assert.equal(missing.accepted, false);
    assert.match(missing.reason, /is missing/);
    const outside = appendRecord(dir, { session_id: 's1', artifacts: [{ file: '../latest.json', sha256: 'f'.repeat(64) }] });
    assert.match(outside.reason, /not a cell file named by its hash/);
    assert.equal(readJson(join(dir, 'latest.json')).current, good.name, 'latest.json stays on the accepted record');
    assert.ok(verifyRecords(dir).find((r) => r.check === `${good.name} cited cells`).ok);

    // a cited cell changed afterwards: reported, and latest.json no longer names an accepted record
    writeFileSync(join(dir, cell.file), 'store("k", 2);\n');
    const failed = verifyRecords(dir)
      .filter((r) => !r.ok)
      .map((r) => r.check);
    assert.ok(failed.includes(`${good.name} cited cells`));
    assert.ok(failed.includes('latest.json'));
  });
});

test('the hand-off text latest.json vouches for is the one whose hash its record states', () => {
  withDir((dir) => {
    assert.equal(acceptedHandoff(dir).reason, 'NO_ACCEPTED_RECORD');
    const text = '[codex-handoff] state\r\nline 2\r\n';
    appendRecord(dir, { session_id: 's1', rendered: { file: 'handoff.txt', sha256: sha256(lf(text)) } });
    writeFileSync(join(dir, 'handoff.txt'), text);
    const accepted = acceptedHandoff(dir);
    assert.equal(accepted.text, text);
    assert.equal(accepted.name, 'handoff-0001.json');
    writeFileSync(join(dir, 'handoff.txt'), '[codex-handoff] edited\n');
    assert.equal(acceptedHandoff(dir).reason, 'RENDERED_HASH_MISMATCH');
    writeFileSync(join(dir, 'records', 'handoff-0001.json'), '{}\n');
    assert.equal(acceptedHandoff(dir).reason, 'RECORD_HASH_MISMATCH');
  });
});

test('cells are stored once under their own hash', () => {
  withDir((dir) => {
    const a = saveCell(dir, 'store("k", 1);\r\n');
    const b = saveCell(dir, 'store("k", 1);\n');
    assert.equal(a.file, b.file);
    assert.equal(readFileSync(join(dir, a.file), 'utf8'), 'store("k", 1);\n');
  });
});

test('canonical JSON sorts keys at every level, so identities do not depend on field order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: null, y: 'x' }], c: true } }), '{"a":{"c":true,"d":[2,{"y":"x","z":null}]},"b":1}');
  assert.equal(contentId({ a: 1, b: 2 }), contentId({ b: 2, a: 1 }));
  assert.match(contentId({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test('the change log appends hash-linked entries and keeps rows verbatim', () => {
  withDir((dir) => {
    const log = join(dir, 'change.log.md');
    const row = '| [abc](x) | `C:\\W` | task names W (rollout line 3) | t | none recorded |';
    appendEntries(log, [{ kind: 'BASELINE', at: '2026-10-02T00:00:00Z', reasonCode: 'CHANGE_LOG_CREATED', original: [], blockBefore: 'a'.repeat(64), blockAfter: 'a'.repeat(64) }], { documentName: 'Index.md' });
    appendEntries(log, [{ kind: 'ADDED', at: '2026-10-02T00:01:00Z', session: 'abc', reasonCode: 'NEW_EVIDENCE', original: null, forward: row, blockBefore: 'a'.repeat(64), blockAfter: 'b'.repeat(64) }], { documentName: 'Index.md' });
    const text = readFileSync(log, 'utf8');
    assert.ok(text.startsWith('# Change log: Index.md\n'));
    const entries = parseEntries(text);
    assert.deepEqual(
      entries.map((e) => e.sequence),
      [1, 2]
    );
    assert.equal(entries[1].prev, entries[0].sha256);
    assert.ok(entries[1].text.includes(`    ${row}`));
    assert.ok(entries[1].text.includes('- Reason code: NEW_EVIDENCE'));
    assert.deepEqual(
      verifyChangeLog(log).filter((r) => !r.ok),
      []
    );
    writeFileSync(log, text.replace('ADDED', 'CHANGED'));
    assert.ok(verifyChangeLog(log).some((r) => !r.ok && r.check === 'change log sidecar'));
  });
});

test('the index declares its task paths on its Scope checked line', () => {
  const index = '**Scope checked:** `C:\\Users\\me\\Desktop\\CODEAPI`, `C:\\Users\\me\\Desktop\\HeliosEvidenceCatalog`, and `C:\\Users\\me\\Desktop\\MythosJustAFable`.  \n';
  assert.deepEqual(parseScopePaths(index), ['C:\\Users\\me\\Desktop\\CODEAPI', 'C:\\Users\\me\\Desktop\\HeliosEvidenceCatalog', 'C:\\Users\\me\\Desktop\\MythosJustAFable']);
  assert.deepEqual(parseScopePaths('# no scope here'), []);
});

test('alignment takes the strongest evidence: workspace, then a named path, then a named directory', () => {
  const scope = ['C:\\Users\\me\\Desktop\\CODEAPI', 'C:\\Users\\me\\Desktop\\HeliosEvidenceCatalog'];
  assert.equal(scopeAlignment({ cwd: 'c:\\users\\me\\desktop\\heliosevidencecatalog\\src', userMessages: [] }, scope).class, 'WORKSPACE');
  const byPath = scopeAlignment({ cwd: 'C:\\Elsewhere', userMessages: [{ lineNumber: 7, text: 'read C:/Users/me/Desktop/CODEAPI/docs/API.md' }] }, scope);
  assert.deepEqual(byPath, { class: 'TASK_PATH', scopes: ['C:\\Users\\me\\Desktop\\CODEAPI'], evidence: { rollout_line: 7 } });
  const byName = scopeAlignment({ cwd: 'C:\\Elsewhere', userMessages: [{ lineNumber: 13, text: 'Locate the local CodeAPI and the catalog' }] }, scope);
  assert.deepEqual(byName, { class: 'TASK_NAME', scopes: ['C:\\Users\\me\\Desktop\\CODEAPI'], evidence: { rollout_line: 13 } });
  // a sibling directory or a longer name is not the scope path
  assert.equal(scopeAlignment({ cwd: 'C:\\Users\\me\\Desktop\\CODEAPI-clone', userMessages: [{ lineNumber: 2, text: 'work in CODEAPI-clone' }] }, scope).class, 'NOT_ALIGNED');
  assert.equal(scopeAlignment({ cwd: 'C:\\Work', userMessages: [] }, []).class, 'NOT_ALIGNED');
});

const HANDOFF = {
  sessionId: 's1',
  task: [{ lineNumber: 13 }],
  position: { agentMessages: [{ lineNumber: 2480 }] },
  terminal: {
    recipes: {
      write: { lineNumber: 2081, cellId: 'c1', cellSha256: 'aa', lineSha256: 'l1', timestamp: 't', term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', line: 'return codeApiTerm.write("codeapi:NewSession",x,{enter:false})' },
      enter: { lineNumber: 2081, cellId: 'c1', cellSha256: 'aa', lineSha256: 'l1', timestamp: 't', term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', line: 'return codeApiTerm.write("codeapi:NewSession","\\r",{enter:false})' },
      read: { lineNumber: 2558, cellId: 'c2', cellSha256: 'bb', lineSha256: 'l2', timestamp: 't2', term: 'codeapi:NewSession', url: 'http://127.0.0.1:47339', line: "curl.exe 'http://127.0.0.1:47339/term/codeapi:NewSession/read'", wrote: undefined },
    },
    cell: { source: 'x' },
  },
  store: [
    { key: 'helper', lastStoreLine: 8080, workingLoadLines: [8087, 11336], usage: ['const v = load("helper");'], source: 'store("helper", f)' },
    { key: 'fresh', lastStoreLine: 11200, workingLoadLines: [11210], usage: [] },
    { key: 'stale', lastStoreLine: 9000, workingLoadLines: [9001], usage: [] },
  ],
  compactionLines: [8767, 10242, 11085],
  sandbox: [],
  helios: { chainPredecessor: { correlationId: 'corr-1', at: 't' } },
  references: [{ exists: true }, { exists: false }],
  alignment: { class: 'TASK_NAME', scopes: ['C:\\W'], evidence: { rollout_line: 13 } },
};

test('physical occurrences come first: one per cell execution, and recipes only refer to them', () => {
  const occurrences = occurrencesOf(HANDOFF);
  assert.equal(occurrences.length, 2, 'the write and Enter calls share one cell execution');
  assert.deepEqual(occurrences[0].call_line_sha256, ['l1']);
  // each call keeps its physical form inside the occurrence
  assert.deepEqual(
    occurrences[0].calls.map((c) => [c.kind, c.physical_transport, c.observed_endpoint]),
    [
      ['write', 'EXTENSION_EXEC_WRITE', '127.0.0.1:47339'],
      ['enter', 'EXTENSION_EXEC_ENTER', '127.0.0.1:47339'],
    ]
  );
  const recipes = recipesOf(HANDOFF);
  // semantic recipes, whichever transport carried them
  assert.deepEqual(
    recipes.map((r) => [r.recipe_id, r.physical_transport]),
    [
      ['codeapi.terminal.write', 'EXTENSION_EXEC_WRITE'],
      ['codeapi.terminal.enter', 'EXTENSION_EXEC_ENTER'],
      ['codeapi.terminal.read', 'REST_TERM_READ'],
    ]
  );
  for (const r of recipes) {
    assert.equal(r.status, 'OBSERVED', 'one witness (the cell result) is not VERIFIED');
    assert.ok(occurrences.some((o) => o.occurrence_id === r.derived_from[0]));
    assert.equal(r.runtime.currency, 'REVALIDATE_ON_INJECT');
    assert.equal(r.runtime.capture_endpoint, 'http://127.0.0.1:47339');
    assert.equal(r.runtime.terminal_pid, 'UNRESOLVED');
  }
});

test('store keys show compaction persistence only where the record proves a later working load', () => {
  const keys = Object.fromEntries(runtimeKeysOf(HANDOFF, { store: { helper: { file: 'cells/h.js', sha256: 'h' } } }).map((k) => [k.key, k]));
  assert.deepEqual(keys.helper.persistence.after_compaction, {
    status: 'OBSERVED',
    basis: 'a cell that loaded the key completed after a compaction',
    compactions_crossed: 3,
    last_compaction_line: 11085,
    load_line: 11336,
  });
  assert.equal(keys.fresh.persistence.after_compaction.status, 'UNKNOWN', 'no compaction since the store');
  assert.equal(keys.stale.persistence.after_compaction.status, 'UNRESOLVED', 'compacted since, no later load recorded');
  assert.equal(keys.helper.persistence.after_restart.status, 'UNKNOWN');
  assert.equal(keys.helper.value_sha256.availability, 'NOT_CAPTURED_BY_PRODUCER');
  assert.deepEqual(keys.helper.restore.storing_cell, { file: 'cells/h.js', sha256: 'h' });
  assert.deepEqual(keys.fresh.restore.storing_cell, { availability: 'EXPECTED_NOT_CAPTURED' });
});

test('claims carry authority and typed provenance; nothing is promoted beyond its witness', () => {
  assert.deepEqual(classifyHandoff(HANDOFF), {
    TERMINAL_RECIPES: 'OBSERVED',
    STORE_KEYS: 'OBSERVED',
    SANDBOX_LIMITS: 'NONE_RECORDED',
    HELIOS_CHAIN: 'OBSERVED',
    // a Helios state captured without the gate contract (as producers before it did)
    HELIOS_CONTRACT: 'NOT_CAPTURED_BY_PRODUCER',
    STANDING_REFERENCES: 'PARTIAL',
    SCOPE_ALIGNMENT: 'TASK_NAME',
  });
  const claims = claimsOf(HANDOFF);
  const authorityOf = (prefix) => claims.find((c) => c.claim.startsWith(prefix)).authority;
  assert.equal(authorityOf('user task'), 'DECLARED');
  assert.equal(authorityOf("Codex's account"), 'DECLARED');
  assert.equal(authorityOf('terminal write'), 'OBSERVED');
  assert.equal(authorityOf('works within'), 'DERIVED');
  assert.deepEqual(claims.find((c) => c.claim === 'Helios chain predecessor').provenance, [{ type: 'HELIOS_SESSION_LEDGER', correlation_id: 'corr-1', recorded_at: 't' }]);
  assert.ok(claims.every((c) => c.provenance.length && c.provenance.every((p) => p.type)));
  assert.deepEqual(
    openGaps(HANDOFF).map((g) => g.id),
    ['G1', 'G2', 'G3', 'G4', 'G5']
  );
  const copy = withoutSources(HANDOFF, { terminal: { file: 'cells/t.js', sha256: 't' }, store: { helper: { file: 'cells/s.js', sha256: 's' } } });
  assert.equal(copy.terminal.cell.source, undefined);
  assert.equal(copy.store[0].source_file, 'cells/s.js');
  assert.equal(HANDOFF.store[0].source, 'store("helper", f)', 'the original is not changed');
});
