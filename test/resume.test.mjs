// End to end through the hooks: a thread resumed into a new rollout file (thread 01a0fcec,
// 2026-10-03 16:00:29Z). claude-devtools' export is replaced by a stand-in that copies the export
// document a test wrote as the "rollout" file. Every path (Codex home, state with its config,
// Helios root) is under a temporary directory: nothing here can reach live state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lf, sha256 } from '../lib/files.mjs';
import { readLatest, readLifecycle, readRecord, verifyRecords } from '../lib/records.mjs';

const CLI = fileURLToPath(new URL('../bin/handoff.mjs', import.meta.url));
const T = '01a0fcec-f1d6-7d43-99e1-54ce88dbb954';
const FAKE_TSX = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  'const rollout = args[1];',
  "const out = args[args.indexOf('--out') + 1];",
  "const until = args.includes('--until-line') ? Number(args[args.indexOf('--until-line') + 1]) : null;",
  "const doc = JSON.parse(readFileSync(rollout, 'utf8'));",
  'doc.file = rollout;',
  'if (until) {',
  '  const keep = (e) => e.lineNumber < until;',
  '  Object.assign(doc, { untilLine: until, records: until - 1, session: { ...doc.session, timeline: doc.session.timeline.filter(keep), executions: doc.session.executions.filter(keep) } });',
  '}',
  'writeFileSync(out, JSON.stringify(doc));',
].join('\n');

const ts = (day, line) => `2026-10-${day}T1${day === '02' ? 1 : 6}:${String(line % 60).padStart(2, '0')}:00.000Z`;
const singleCall = (cmd) => `const cmd = \`${cmd}\`;\nconst r = await tools.exec_command({cmd, shell:"bash"});\ntext(r);\n`;
const WRITE_CMD = `powershell.exe -NoProfile -Command "Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47338/term/codeapi:NewSession/write' -ContentType 'application/json' -Body (ConvertTo-Json -Compress @{data='Get-Location'})"`;
const wroteReply = JSON.stringify({ exit_code: 0, output: '\r\nid                  wrote\r\n--                  -----\r\ncodeapi:NewSession  12\r\n' });
const DOC_A = {
  schema: 'codex-export.v1',
  untilLine: null,
  records: 14,
  session: {
    metadata: { threadId: T, cwd: 'C:\\Users\\accountName\\Desktop\\Powershell ToolKit' },
    timeline: [
      { kind: 'user_message', lineNumber: 2, timestamp: ts('02', 2), text: 'Explore the catalog through the existing PTY.' },
      { kind: 'compaction', lineNumber: 5, timestamp: ts('02', 5) },
      { kind: 'agent_message', lineNumber: 12, timestamp: ts('02', 12), text: 'The PTY answered; next, the runtime command.' },
    ],
    executions: [{ id: 'call_w', kind: 'code_cell', lineNumber: 10, timestamp: ts('02', 10), input: singleCall(WRITE_CMD), output: wroteReply, status: 'completed', evidence: {} }],
  },
};
const DOC_B = {
  schema: 'codex-export.v1',
  untilLine: null,
  records: 8,
  session: {
    metadata: { threadId: T, cwd: 'C:\\Users\\accountName\\Desktop\\Powershell ToolKit' },
    timeline: [
      { kind: 'user_message', lineNumber: 2, timestamp: ts('03', 2), text: 'Continue the codex-handoff work.' },
      { kind: 'agent_message', lineNumber: 4, timestamp: ts('03', 4), text: 'Re-establishing the baseline.' },
    ],
    executions: [],
  },
};

function world() {
  const root = mkdtempSync(join(tmpdir(), 'codex-handoff-resume-'));
  const devtools = join(root, 'devtools');
  mkdirSync(join(devtools, 'scripts'), { recursive: true });
  mkdirSync(join(devtools, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(devtools, 'scripts', 'codex-export.ts'), '// stand-in: the tsx stand-in does the export\n');
  writeFileSync(join(devtools, 'node_modules', 'tsx', 'dist', 'cli.mjs'), FAKE_TSX);
  const home = join(root, 'codex');
  for (const day of ['02', '03']) mkdirSync(join(home, 'sessions', '2026', '10', day), { recursive: true });
  const state = join(root, 'state');
  const env = { ...process.env, CODEX_HOME: home, CODEX_HANDOFF_DEVTOOLS: devtools, CODEX_HANDOFF_HELIOS_ROOT: join(root, 'no-helios'), CODEX_HANDOFF_CODEAPI_PORTS: 'off', CODEX_HANDOFF_STATE: state };
  return {
    root,
    state,
    dir: join(state, T),
    a: join(home, 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-03-01-${T}.jsonl`),
    b: join(home, 'sessions', '2026', '10', '03', `rollout-2026-10-03T12-00-29-${T}_01a1027e-d557-7bc2-b2f0-8479df4871d6.jsonl`),
    hook: (command, input) => execFileSync(process.execPath, [CLI, command], { input: JSON.stringify(input), encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }),
  };
}

const context = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

test('a resume into a new rollout file is handed the whole thread, the first file’s terminal recipe included', () => {
  const w = world();
  try {
    writeFileSync(w.a, JSON.stringify(DOC_A));
    w.hook('snapshot', { session_id: T, transcript_path: w.a, trigger: 'auto' });
    assert.equal(readLatest(w.dir).current, 'handoff-0001.json');

    writeFileSync(w.b, JSON.stringify(DOC_B)); // the resume starts a new file for the same thread
    const text = context(w.hook('inject', { session_id: T, transcript_path: w.b, source: 'resume' }));
    assert.match(text, /rebuilt at session start \(resume\) after 1 context compaction\(s\) \(session record across 2 rollout files, up to rollout 2 line 8/);
    assert.match(text, /write text \(cell at rollout 1 line 10, [^)]*\): const cmd = `powershell\.exe/);
    assert.match(text, /\(rollout 2 line 2\): "Continue the codex-handoff work\."/);

    const record = readRecord(join(w.dir, 'records', 'handoff-0002.json'));
    assert.equal(record.schema_version, 'codex-handoff-record.v3');
    assert.deepEqual(record.source.segments.map((s) => [s.line_offset, s.records_read]), [
      [0, 14],
      [14, 8],
    ]);
    assert.deepEqual([record.continuity.verdict, record.continuity.predecessor.name], ['CONTINUOUS', 'handoff-0001.json']);
    const injected = readLifecycle(w.dir).filter((e) => e.event === 'INJECTED');
    assert.deepEqual([injected.at(-1).record, injected.at(-1).source], ['handoff-0002.json', 'resume']);
    const checks = verifyRecords(w.dir);
    assert.ok(checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join('; '));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('when only the new file can be read, its snapshot is kept but not used: the accepted hand-off is injected, with a note', () => {
  const w = world();
  try {
    writeFileSync(w.a, JSON.stringify(DOC_A));
    w.hook('snapshot', { session_id: T, transcript_path: w.a, trigger: 'auto' });
    writeFileSync(w.b, JSON.stringify(DOC_B));
    w.hook('inject', { session_id: T, transcript_path: w.b, source: 'resume' });
    const accepted = readFileSync(join(w.dir, 'handoff.txt'), 'utf8');

    // the first file goes missing: the thread view is the new file alone, a partial view
    renameSync(w.a, join(w.root, 'moved-away.jsonl'));
    const text = context(w.hook('inject', { session_id: T, transcript_path: w.b, source: 'resume' }));
    assert.match(text, /^\[codex-handoff\] The snapshot taken at this session start \(handoff-0003\.json\) was kept as evidence but not used: PARTIAL_SOURCE_VIEW: does not read /);
    assert.ok(text.endsWith(accepted), 'followed by the accepted hand-off, unchanged');

    assert.equal(readLatest(w.dir).current, 'handoff-0002.json');
    assert.equal(sha256(lf(readFileSync(join(w.dir, 'handoff.txt'), 'utf8'))), readRecord(join(w.dir, 'records', 'handoff-0002.json')).rendered.sha256);
    const events = readLifecycle(w.dir);
    assert.deepEqual(events.filter((e) => e.record === 'handoff-0003.json').map((e) => e.event), ['CAPTURED', 'RETAINED']);
    const last = events.at(-1);
    assert.deepEqual([last.event, last.record], ['INJECTED', 'handoff-0002.json']);
    assert.equal(last.injected_sha256, sha256(lf(text)));
    const checks = verifyRecords(w.dir);
    assert.ok(checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join('; '));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
