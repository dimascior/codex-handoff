import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildHandoff } from '../lib/extract.mjs';
import { renderHandoff } from '../lib/render.mjs';
import { candidateFiles, lineRef, locate, mergeSegments, newestRollout, sessionsRootOf, threadView } from '../lib/thread.mjs';

const T = '01a0fcec-f1d6-7d43-99e1-54ce88dbb954';
const SEG = '01a1027e-d557-7bc2-b2f0-8479df4871d6';
const OTHER = '01a0ff01-7c17-7db1-918a-1f37a54dec44';

// A sessions tree like Codex's: sessions/YYYY/MM/DD/rollout-<time>-<thread>[_<segment>].jsonl
function sessionsTree() {
  const home = mkdtempSync(join(tmpdir(), 'codex-handoff-sessions-'));
  const sessions = join(home, 'sessions');
  const file = (day, name) => {
    mkdirSync(join(sessions, '2026', '10', day), { recursive: true });
    const path = join(sessions, '2026', '10', day, name);
    writeFileSync(path, '{}\n');
    return path;
  };
  const paths = {
    a: file('02', `rollout-2026-10-02T10-03-01-${T}.jsonl`),
    b: file('03', `rollout-2026-10-03T12-00-29-${T}_${SEG}.jsonl`),
    other: file('02', `rollout-2026-10-02T19-44-42-${OTHER}.jsonl`),
  };
  writeFileSync(join(sessions, 'notes.txt'), 'not a rollout');
  return { home, sessions, paths };
}

const ts = (day, line) => `2026-10-${day}T${String(10 + Math.floor(line / 60)).padStart(2, '0')}:${String(line % 60).padStart(2, '0')}:00.000Z`;
const cell = (id, lineNumber, day, input, output) => ({ id, kind: 'code_cell', lineNumber, timestamp: ts(day, lineNumber), input, output, status: 'completed', evidence: {} });
const execResult = (output) => JSON.stringify({ exit_code: 0, output });
const singleCall = (cmd) => `const cmd = \`${cmd}\`;\nconst r = await tools.exec_command({cmd, shell:"bash"});\ntext(r);\n`;
const WRITE_CMD = `powershell.exe -NoProfile -Command "Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47338/term/codex/write' -ContentType 'application/json' -Body (ConvertTo-Json -Compress @{data='dir'})"`;
const SESSION_CMD = `curl.exe -sS http://127.0.0.1:47338/session`;
const WINDOW = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';

// Export documents as claude-devtools' codex-export.v1 gives them (line numbers per file).
const docA = (file) => ({
  schema: 'codex-export.v1',
  file,
  untilLine: null,
  records: 30,
  session: {
    metadata: { threadId: T, cwd: 'C:\\work' },
    timeline: [
      { kind: 'user_message', lineNumber: 2, timestamp: ts('02', 2), text: 'Explore the catalog through the PTY.' },
      { kind: 'compaction', lineNumber: 5, timestamp: ts('02', 5) },
      { kind: 'agent_message', lineNumber: 28, timestamp: ts('02', 28), text: 'The window answered on 47338.' },
    ],
    executions: [cell('s', 25, '02', singleCall(SESSION_CMD), execResult(`{"serverPort":47338,"codeapiWindowId":"${WINDOW}"}`))],
  },
});
const docB = (file) => ({
  schema: 'codex-export.v1',
  file,
  untilLine: null,
  records: 8,
  session: {
    metadata: { threadId: T, cwd: 'C:\\work' },
    timeline: [
      { kind: 'user_message', lineNumber: 2, timestamp: ts('03', 2), text: 'Continue after the restart.' },
      { kind: 'compaction', lineNumber: 6, timestamp: ts('03', 6) },
    ],
    executions: [cell('w', 3, '03', singleCall(WRITE_CMD), execResult('\r\nid    wrote\r\n--    -----\r\ncodex   3\r\n'))],
  },
});

function exporterFor(paths, overrides = {}) {
  const calls = [];
  const exporter = (_config, path, untilLine) => {
    calls.push({ path, untilLine });
    if (overrides[path] instanceof Error) throw overrides[path];
    const doc = overrides[path] ?? (path === paths.a ? docA(path) : path === paths.b ? docB(path) : { schema: 'codex-export.v1', file: path, records: 3, session: { metadata: { threadId: OTHER }, timeline: [], executions: [] } });
    if (!untilLine) return doc;
    const keep = (e) => e.lineNumber < untilLine;
    return { ...doc, untilLine, records: untilLine - 1, session: { ...doc.session, timeline: doc.session.timeline.filter(keep), executions: doc.session.executions.filter(keep) } };
  };
  return { exporter, calls };
}

const withTree = (fn) => {
  const tree = sessionsTree();
  try {
    return fn(tree);
  } finally {
    rmSync(tree.home, { recursive: true, force: true });
  }
};

test('candidate files: every rollout file under YYYY/MM/DD whose name has the thread id, and nothing else', () => {
  withTree(({ sessions, paths }) => {
    assert.deepEqual(candidateFiles([sessions], T).sort(), [paths.a, paths.b].sort());
    assert.equal(sessionsRootOf(paths.b), sessions);
    assert.equal(sessionsRootOf('C:\\elsewhere\\rollout.jsonl'), null);
    assert.equal(newestRollout([sessions], T), paths.b);
    assert.deepEqual(candidateFiles([sessions], null), []);
  });
});

test('a thread kept in one file passes through unchanged', () => {
  withTree(({ paths }) => {
    const { exporter } = exporterFor(paths);
    const view = threadView({}, { transcript: paths.other, threadId: OTHER, exporter });
    assert.deepEqual(view.doc, exporter({}, paths.other));
    assert.equal(view.segments.length, 1);
    assert.equal(view.segments[0].line_offset, 0);
    assert.equal(lineRef(view.segments, 7), 'line 7');
  });
});

test('a resumed thread is read whole: its files in order, thread lines across them, every line mapped back', () => {
  withTree(({ paths }) => {
    const { exporter } = exporterFor(paths);
    // the hook names the new file; the thread's history is in the first one
    const view = threadView({}, { transcript: paths.b, threadId: T, exporter });
    assert.deepEqual(
      view.segments.map((s) => [s.rollout, s.line_offset, s.lines, s.records_read]),
      [
        [paths.a, 0, 30, 30],
        [paths.b, 30, 8, 8],
      ]
    );
    assert.deepEqual(view.excluded, [], "the other thread's file is not even a candidate");
    assert.equal(view.doc.records, 38);
    assert.equal(view.doc.file, paths.b);
    const lines = view.doc.session.timeline.map((e) => e.lineNumber);
    assert.deepEqual(lines, [2, 5, 28, 32, 36]);
    assert.deepEqual(locate(view.segments, 32), { segment: 1, line: 2 });
    assert.deepEqual(locate(view.segments, 28), { segment: 0, line: 28 });
    assert.equal(lineRef(view.segments, 33), 'rollout 2 line 3');
  });
});

test("membership comes from the export's thread id, not the file name; failures and later files are listed", () => {
  withTree(({ sessions, paths }) => {
    const impostor = join(sessions, '2026', '10', '03', `rollout-2026-10-03T13-00-00-${T}_ffff.jsonl`);
    writeFileSync(impostor, '{}\n');
    const broken = join(sessions, '2026', '10', '03', `rollout-2026-10-03T14-00-00-${T}_eeee.jsonl`);
    writeFileSync(broken, '{}\n');
    const { exporter } = exporterFor(paths, { [impostor]: { schema: 'codex-export.v1', file: impostor, records: 2, session: { metadata: { threadId: OTHER }, timeline: [], executions: [] } }, [broken]: new Error('zstd frame truncated') });
    const view = threadView({}, { transcript: paths.b, threadId: T, exporter });
    assert.deepEqual(view.segments.map((s) => s.rollout), [paths.a, paths.b]);
    const why = Object.fromEntries(view.excluded.map((e) => [e.rollout, e.reason]));
    assert.equal(why[impostor], 'OTHER_THREAD');
    assert.equal(why[broken], 'EXPORT_FAILED');
    // a dry run over the first file does not see what came after it
    const dry = threadView({}, { transcript: paths.a, threadId: T, exporter });
    assert.deepEqual(dry.segments.map((s) => s.rollout), [paths.a]);
    assert.equal(Object.fromEntries(dry.excluded.map((e) => [e.rollout, e.reason]))[paths.b], 'STARTS_AFTER_TRANSCRIPT');
  });
});

test('without a session id the thread id is the one the transcript export declares; --until-line cuts the transcript only', () => {
  withTree(({ paths }) => {
    const { exporter, calls } = exporterFor(paths);
    const view = threadView({}, { transcript: paths.b, untilLine: 4, exporter });
    assert.equal(view.threadId, T);
    assert.deepEqual(view.segments.map((s) => [s.lines, s.until_line]), [
      [30, null],
      [3, 4],
    ]);
    assert.deepEqual(calls.find((c) => c.path === paths.a).untilLine, undefined);
    assert.equal(view.doc.records, 33);
  });
});

test('mergeSegments never lets two files share a thread line, even when records undercount the lines', () => {
  const sparse = { schema: 'codex-export.v1', file: 'A', records: 2, session: { metadata: { threadId: T }, timeline: [{ kind: 'user_message', lineNumber: 9, timestamp: ts('02', 9), text: 'x' }], executions: [] } };
  const next = { schema: 'codex-export.v1', file: 'B', records: 1, session: { metadata: { threadId: T }, timeline: [{ kind: 'user_message', lineNumber: 1, timestamp: ts('03', 1), text: 'y' }], executions: [] } };
  const merged = mergeSegments([{ path: 'A', doc: sparse }, { path: 'B', doc: next }]);
  assert.deepEqual(merged.doc.session.timeline.map((e) => e.lineNumber), [9, 10]);
});

test('buildHandoff over the thread: every file counts, and a window observed in the first binds a call in the second', () => {
  withTree(({ paths }) => {
    const { exporter } = exporterFor(paths);
    const view = threadView({}, { transcript: paths.b, threadId: T, exporter });
    const h = buildHandoff(view.doc, { sessionId: T, thread: view });
    assert.equal(h.compactions, 2, 'one compaction in each file');
    const write = h.terminal.recipes.write;
    assert.equal(write.lineNumber, 33);
    assert.equal(write.window.codeapi_window_id, WINDOW, 'bound from the observation at thread line 25');
    assert.equal(h.thread.segments.length, 2);
    // read alone, the resumed file cannot bind the call: its observation is in the other file
    const alone = buildHandoff(docB(paths.b), { sessionId: T });
    assert.equal(alone.terminal.recipes.write.window.codeapi_window_id, null);
    assert.equal(alone.compactions, 1);
  });
});

test('the rendered hand-off says how many rollout files it read and in which file each cited line is', () => {
  withTree(({ paths }) => {
    const { exporter } = exporterFor(paths);
    const view = threadView({}, { transcript: paths.b, threadId: T, exporter });
    const text = renderHandoff(buildHandoff(view.doc, { sessionId: T, thread: view }));
    assert.match(text, /session record across 2 rollout files, up to rollout 2 line 8/);
    assert.match(text, /recorded just before context compaction #3/);
    assert.match(text, /\(rollout 1 line 2\): "Explore the catalog/);
    assert.match(text, /\(cell at rollout 2 line 3,/);
  });
});
