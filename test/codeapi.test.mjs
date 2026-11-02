import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { discoverWindows, renderLiveBlock, resolutionSummary, resolveRuntime } from '../lib/codeapi.mjs';

const TOOLKIT = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';
const CATALOG = '8d3efeac-b45b-49c3-b992-069b67b66e1c';

// A fake CodeAPI instance on an ephemeral port: /session as the real adapter reports it,
// /term/list with the given terminals. serverPort defaults to the port it listens on.
async function fakeCodeapi({ windowId, workspace, terminals = [], serverPort, requiredToken }) {
  const server = createServer((req, res) => {
    const port = server.address().port;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') {
      res.end(JSON.stringify({ workspaceUri: `file:///c%3A/Users/accountName/Desktop/${encodeURIComponent(workspace)}`, windowId: 0, serverPort: serverPort ?? port, codeapiWindowId: windowId, extensionHostPid: 4242 }));
    } else if (req.url === '/term/list') {
      if (requiredToken && req.headers['x-codeapi-token'] !== requiredToken) {
        res.statusCode = 401;
        res.end('{"error":"CODEAPI authentication required"}');
        return;
      }
      res.end(JSON.stringify(terminals));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A port nothing listens on: bind, note the port, close.
async function freePort() {
  const s = await fakeCodeapi({ windowId: TOOLKIT, workspace: 'x' });
  await s.close();
  return s.port;
}

const recorded = (windowId, url = 'http://127.0.0.1:47339') => ({
  term: 'codeapi:NewSession',
  window: windowId ? { id: windowId, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: 1959 } : null,
  url,
  urls: [url],
  transports: ['/term routes'],
  lines: [2558],
});

test('a window that moved ports resolves to its current endpoint, with the terminal checked there', async () => {
  // the Toolkit window recorded on 47339 now answers elsewhere; another window holds a different port
  const toolkit = await fakeCodeapi({ windowId: TOOLKIT, workspace: 'Powershell ToolKit', terminals: [{ id: 'codeapi:NewSession', alive: true, pid: 96056 }] });
  const catalog = await fakeCodeapi({ windowId: CATALOG, workspace: 'HeliosEvidenceCatalog' });
  try {
    const res = await resolveRuntime([recorded(TOOLKIT)], { ports: [toolkit.port, catalog.port], timeoutMs: 1000 });
    assert.equal(res.results[0].status, 'CURRENT');
    assert.equal(res.results[0].current, `http://127.0.0.1:${toolkit.port}`);
    assert.deepEqual(res.results[0].terminal, { present: true, alive: true, pid: 96056 });
    const block = renderLiveBlock(res, { ports: [toolkit.port, catalog.port] });
    assert.ok(block.startsWith('[codex-handoff] CodeAPI right now'));
    assert.ok(block.includes(`CURRENT endpoint http://127.0.0.1:${toolkit.port} (recorded at http://127.0.0.1:47339; use http://127.0.0.1:${toolkit.port} instead)`));
    assert.ok(block.includes('terminal codeapi:NewSession: alive, pid 96056'));
    assert.ok(block.includes(`127.0.0.1:${catalog.port} HeliosEvidenceCatalog (window ${CATALOG})`));
    assert.deepEqual(resolutionSummary(res)[0], {
      term: 'codeapi:NewSession',
      codeapi_window_id: TOOLKIT,
      status: 'CURRENT',
      current: `http://127.0.0.1:${toolkit.port}`,
      recorded: 'http://127.0.0.1:47339',
      terminal: { present: true, alive: true, pid: 96056 },
    });
  } finally {
    await toolkit.close();
    await catalog.close();
  }
});

test('an unresolved window never falls back to its recorded port, even when that port answers for another window', async () => {
  // the recorded port is now the Catalog window's: the Toolkit id is nowhere
  const catalog = await fakeCodeapi({ windowId: CATALOG, workspace: 'HeliosEvidenceCatalog', terminals: [{ id: 'codeapi:NewSession', alive: true, pid: 1 }] });
  try {
    const recordedUrl = `http://127.0.0.1:${catalog.port}`;
    const res = await resolveRuntime([recorded(TOOLKIT, recordedUrl)], { ports: [catalog.port], timeoutMs: 1000 });
    assert.equal(res.results[0].status, 'UNRESOLVED');
    assert.equal(res.results[0].current, undefined);
    const block = renderLiveBlock(res, { ports: [catalog.port] });
    assert.ok(block.includes(`current endpoint UNRESOLVED`));
    assert.ok(block.includes(`Historical endpoint ${recordedUrl}: DO NOT USE AS CURRENT`));
    assert.ok(!block.includes('CURRENT endpoint'), 'no endpoint is presented as current');
  } finally {
    await catalog.close();
  }
});

test('two instances with one window id are ambiguous; records without identity say so; phantoms are ignored', async () => {
  const a = await fakeCodeapi({ windowId: TOOLKIT, workspace: 'Powershell ToolKit' });
  const b = await fakeCodeapi({ windowId: TOOLKIT, workspace: 'Powershell ToolKit' });
  const phantom = await fakeCodeapi({ windowId: CATALOG, workspace: 'HeliosEvidenceCatalog', serverPort: 1 });
  try {
    const ports = [a.port, b.port, phantom.port];
    assert.deepEqual(
      (await discoverWindows({ ports, timeoutMs: 1000 })).map((w) => w.port).sort(),
      [a.port, b.port].sort(),
      'an instance whose serverPort is not its port is a phantom'
    );
    const res = await resolveRuntime([recorded(TOOLKIT), recorded(null, 'http://127.0.0.1:47339')], { ports, timeoutMs: 1000 });
    assert.deepEqual(
      res.results.map((r) => r.status),
      ['AMBIGUOUS', 'IDENTITY_NOT_RECORDED']
    );
    const block = renderLiveBlock(res, { ports });
    assert.ok(block.includes(`AMBIGUOUS, answers on ports ${[a.port, b.port].join(', ')}`) || block.includes(`AMBIGUOUS, answers on ports ${[b.port, a.port].join(', ')}`));
    assert.ok(block.includes('recorded no CodeAPI window identity'));
  } finally {
    await a.close();
    await b.close();
    await phantom.close();
  }
});

test('nothing answering is reported as such', async () => {
  const port = await freePort();
  const res = await resolveRuntime([recorded(TOOLKIT)], { ports: [port], timeoutMs: 500 });
  assert.equal(res.results[0].status, 'UNRESOLVED');
  assert.ok(renderLiveBlock(res, { ports: [port] }).includes(`No CodeAPI instance answered on 127.0.0.1 ports ${port}-${port}`));
});

test('optional CODEAPI public token is sent on live terminal status requests', async () => {
  const prev = process.env.CODEAPI_PUBLIC_TOKEN;
  const server = await fakeCodeapi({
    windowId: TOOLKIT,
    workspace: 'Powershell ToolKit',
    terminals: [{ id: 'codeapi:NewSession', alive: true, pid: 23 }],
    requiredToken: 'test-token',
  });
  try {
    delete process.env.CODEAPI_PUBLIC_TOKEN;
    const without = await resolveRuntime([recorded(TOOLKIT)], { ports: [server.port], timeoutMs: 1000 });
    assert.equal(without.results[0].status, 'CURRENT');
    assert.equal(without.results[0].terminal.present, null);
    process.env.CODEAPI_PUBLIC_TOKEN = 'test-token';
    const withToken = await resolveRuntime([recorded(TOOLKIT)], { ports: [server.port], timeoutMs: 1000 });
    assert.deepEqual(withToken.results[0].terminal, { present: true, alive: true, pid: 23 });
  } finally {
    if (prev === undefined) delete process.env.CODEAPI_PUBLIC_TOKEN;
    else process.env.CODEAPI_PUBLIC_TOKEN = prev;
    await server.close();
  }
});
