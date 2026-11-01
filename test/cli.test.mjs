import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { lf, sha256 } from '../lib/files.mjs';
import { appendRecord, readLifecycle } from '../lib/records.mjs';

const CLI = fileURLToPath(new URL('../bin/handoff.mjs', import.meta.url));
// no CodeAPI scan unless a test asks for one
const ENV = { ...process.env, CODEX_HANDOFF_CODEAPI_PORTS: 'off' };
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
// asynchronous, so a fake CodeAPI in this process can answer while the hook runs
const runAsync = async (args, env) => (await promisify(execFile)(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...ENV, ...env } })).stdout;
const utc = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

function withState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-handoff-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An accepted record for `text`, as a PreCompact snapshot leaves it.
function acceptedSnapshot(dir, text, capturedAt = utc()) {
  mkdirSync(dir, { recursive: true });
  appendRecord(dir, { session_id: 'thread-1', recorded_at: capturedAt, snapshot: { captured_at: capturedAt }, rendered: { file: 'handoff.txt', sha256: sha256(lf(text)) } });
  writeFileSync(join(dir, 'handoff.txt'), text);
}

const injectArgs = (state) => ['inject', '--session-id', 'thread-1', '--source', 'compact', '--state', state];

test('inject after a compaction prints the accepted snapshot as SessionStart additionalContext', () => {
  withState((state) => {
    const dir = join(state, 'thread-1');
    acceptedSnapshot(dir, '[codex-handoff] state → recipes');
    const out = JSON.parse(run(injectArgs(state)));
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[codex-handoff] state → recipes' } });
    assert.equal(run([...injectArgs(state), '--text']), '[codex-handoff] state → recipes\n');
    const injected = readLifecycle(dir).filter((e) => e.event === 'INJECTED');
    assert.equal(injected.length, 2);
    assert.equal(injected[0].record, 'handoff-0001.json');
    assert.equal(injected[0].rendered_sha256, sha256('[codex-handoff] state → recipes'));
  });
});

test('inject never reuses a stale snapshot and still answers with context when it cannot build one', () => {
  withState((state) => {
    acceptedSnapshot(join(state, 'thread-1'), 'old snapshot', utc(Date.now() - 60 * 60 * 1000));
    // no transcript to rebuild from: the hook must still exit 0 with a usable message
    const out = JSON.parse(run(injectArgs(state)));
    assert.match(out.hookSpecificOutput.additionalContext, /^\[codex-handoff\] No hand-off could be built/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /old snapshot/);
  });
});

test('inject refuses a saved hand-off whose text no longer has the hash its record states', () => {
  withState((state) => {
    const dir = join(state, 'thread-1');
    acceptedSnapshot(dir, 'snapshot as captured');
    writeFileSync(join(dir, 'handoff.txt'), 'snapshot edited afterwards');
    const out = JSON.parse(run(injectArgs(state)));
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /edited afterwards/);
    const refused = readLifecycle(dir).find((e) => e.event === 'NOT_INJECTED');
    assert.deepEqual([refused.record, refused.reason], ['handoff-0001.json', 'RENDERED_HASH_MISMATCH']);
    assert.equal(
      readLifecycle(dir).some((e) => e.event === 'INJECTED'),
      false
    );
  });
});

test('inject puts the live CodeAPI routing ahead of the hand-off: the window moved, the recorded port is history', async () => {
  const windowId = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') res.end(JSON.stringify({ workspaceUri: 'file:///c%3A/Users/accountName/Desktop/Powershell%20ToolKit', serverPort: server.address().port, codeapiWindowId: windowId }));
    else if (req.url === '/term/list') res.end(JSON.stringify([{ id: 'codeapi:NewSession', alive: true, pid: 96056 }]));
    else res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const state = mkdtempSync(join(tmpdir(), 'codex-handoff-test-'));
  try {
    const dir = join(state, 'thread-1');
    mkdirSync(dir, { recursive: true });
    const text = '[codex-handoff] Working state …';
    // the record saw the terminal working on 47339, in the window it bound from a /session observation
    const endpoints = [{ term: 'codeapi:NewSession', window: { id: windowId, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: 1959 }, url: 'http://127.0.0.1:47339', urls: ['http://127.0.0.1:47339'], transports: ['/term routes'], lines: [2558] }];
    appendRecord(dir, { session_id: 'thread-1', recorded_at: utc(), snapshot: { captured_at: utc() }, rendered: { file: 'handoff.txt', sha256: sha256(lf(text)) }, handoff: { endpoints } });
    writeFileSync(join(dir, 'handoff.txt'), text);

    const out = JSON.parse(await runAsync(injectArgs(state), { CODEX_HANDOFF_CODEAPI_PORTS: String(port) }));
    const injected = out.hookSpecificOutput.additionalContext;
    assert.ok(injected.startsWith('[codex-handoff] CodeAPI right now'));
    assert.ok(injected.includes(`CURRENT endpoint http://127.0.0.1:${port} (recorded at http://127.0.0.1:47339; use http://127.0.0.1:${port} instead); terminal codeapi:NewSession: alive, pid 96056`));
    assert.ok(injected.endsWith(`\n\n${text}`), 'the accepted text follows unchanged');
    const event = readLifecycle(dir).find((e) => e.event === 'INJECTED');
    assert.equal(event.rendered_sha256, sha256(text), 'the record’s rendered hash');
    assert.equal(event.injected_sha256, sha256(lf(injected)), 'and the hash of exactly what was injected');
    assert.deepEqual([event.runtime[0].status, event.runtime[0].current], ['CURRENT', `http://127.0.0.1:${port}`]);
    // the record is not changed by the resolution
    assert.ok(!readLifecycle(dir).some((e) => e.event === 'CAPTURED' && e.record !== 'handoff-0001.json'));

    // the same window gone: the recorded port is never offered as current
    await new Promise((resolve) => server.close(resolve));
    const again = JSON.parse(await runAsync(injectArgs(state), { CODEX_HANDOFF_CODEAPI_PORTS: String(port) })).hookSpecificOutput.additionalContext;
    assert.ok(again.includes('current endpoint UNRESOLVED') && again.includes('Historical endpoint http://127.0.0.1:47339: DO NOT USE AS CURRENT'));
    assert.ok(!again.includes('CURRENT endpoint'));
  } finally {
    server.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('snapshot prints nothing and exits 0 even when it fails', () => {
  withState((state) => {
    assert.equal(run(['snapshot', '--session-id', 'thread-1', '--state', state]), '');
  });
});
