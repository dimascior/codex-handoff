import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recipesOf } from '../lib/evidence.mjs';
import {
  bindWindow,
  buildHandoff,
  cellResult,
  judgeCell,
  parseUserMessage,
  routeLines,
  sandboxLimits,
  storeKeys,
  stripTerminal,
  terminalRecipes,
  windowObservations,
  wroteCount,
} from '../lib/extract.mjs';
import { readReferences } from '../lib/references.mjs';
import { renderHandoff } from '../lib/render.mjs';

const ts = (line) => `2026-10-02T04:${String(line % 60).padStart(2, '0')}:00.000Z`;
const cell = (id, lineNumber, input, output = '', status = 'completed') => ({ id, kind: 'code_cell', lineNumber, timestamp: ts(lineNumber), input, output, status, evidence: {} });
const wait = (id, parentId, lineNumber, output) => ({ id, kind: 'code_wait', parentId, lineNumber, timestamp: ts(lineNumber), output, status: 'completed', evidence: {} });
const execResult = (output, exitCode = 0) => JSON.stringify({ chunk_id: 'a1', wall_time_seconds: 0.5, exit_code: exitCode, original_token_count: 12, output });
const WROTE = (n) => `\r\nid    wrote\r\n--    -----\r\ncodex   ${n}\r\n\r\n`;
const singleCall = (cmd) => `const cmd = \`${cmd}\`;\nconst r = await tools.exec_command({cmd, shell:"bash"});\ntext(r);\n`;
const URI = 'http://127.0.0.1:47338/term/codex';
const WRITE_CMD = `powershell.exe -NoProfile -Command "Invoke-RestMethod -Method Post -Uri '${URI}/write' -ContentType 'application/json' -Body (ConvertTo-Json -Compress @{data='dir'})"`;
const ENTER_CMD = `powershell.exe -NoProfile -Command "Invoke-RestMethod -Method Post -Uri '${URI}/write' -ContentType 'application/json' -Body (ConvertTo-Json -Compress @{data=[string][char]13})"`;
const READ_CMD = `powershell.exe -NoProfile -Command "(Invoke-RestMethod -Uri '${URI}/read?tail=2000').buffer"`;
const GATE_ONLY = [
  'const patch = `*** Begin Patch',
  '*** Add File: C:/gate/pending/x.gate.json',
  `+  "command": "${WRITE_CMD.replace(/"/g, '\\"')}",`,
  '*** End Patch`;',
  'await tools.apply_patch(patch);',
].join('\n');
// A self-contained cell as Codex writes them now: helpers, gate writing and three calls, with the
// result arriving through a later wait.
const SELF_CONTAINED = [
  'function sha256(s){return "0".repeat(64)}',
  'const b64=s=>s;',
  'async function run(c,id,reason){await tools.apply_patch("*** Begin Patch\\n*** End Patch");return tools.exec_command({cmd:c});}',
  `const wb=b64(JSON.stringify({data:"dir",enter:false})),wc=\`powershell.exe -Command "Invoke-RestMethod -Uri '${URI}/write' -Method Post -Body ([Convert]::FromBase64String('\${wb}'))"\`;`,
  'await run(wc,"w-1","interactive_tool");',
  `const eb=b64(JSON.stringify({data:"",enter:true})),ec=\`powershell.exe -Command "Invoke-RestMethod -Uri '${URI}/write' -Method Post -Body ([Convert]::FromBase64String('\${eb}'))"\`;`,
  'await run(ec,"e-1","interactive_tool");',
  `const final=\`powershell.exe -Command "(Invoke-RestMethod -Uri '${URI}/read?tail=6000').buffer"\`,r=await run(final,"r-1","pure_output");`,
  'text(r.output);',
].join('\n');

test('parseUserMessage lists pasted files, paths with spaces included', () => {
  const text =
    '\n# Files pasted by the user:\n\n## "Continue the exploration th…": C:\\Users\\accountName\\.codex/attachments/abc/Pasted text.txt\n\n' +
    "Pasted text contains the user's request.\n\n## My request:\n\n";
  assert.deepEqual(parseUserMessage(text), {
    attachments: [{ title: 'Continue the exploration th…', path: 'C:\\Users\\accountName\\.codex/attachments/abc/Pasted text.txt' }],
    request: '',
  });
  assert.deepEqual(parseUserMessage('go ahead with message 2\n'), { attachments: [], request: 'go ahead with message 2' });
});

test('wroteCount reads the write route reply table', () => {
  assert.equal(wroteCount(WROTE(131)), 131);
  assert.equal(wroteCount(WROTE(0)), 0);
  assert.equal(wroteCount('PS> nothing here'), undefined);
  // several results returned as JSON: escaped newlines, and the smallest count decides
  assert.equal(wroteCount(JSON.stringify({ p: WROTE(168), e: WROTE(0) })), 0);
  assert.equal(wroteCount(JSON.stringify({ p: WROTE(168), e: WROTE(1) })), 1);
});

test('stripTerminal removes escape sequences and soft wraps', () => {
  assert.equal(stripTerminal('\x1b]0;cmd.exe\x07C:\\>Invoke-Cat\x08\r\nalog.ps1 \x1b[32mok\x1b[0m\r\n'), 'C:\\>Invoke-Catalog.ps1 ok\n');
});

test('routeLines classifies calls and skips patch text and comments', () => {
  assert.deepEqual(
    routeLines(singleCall(ENTER_CMD)).map((l) => l.kind),
    ['enter']
  );
  assert.deepEqual(routeLines(GATE_ONLY), []);
  assert.deepEqual(routeLines(`// see ${URI}/write\n`), []);
  assert.deepEqual(
    routeLines(SELF_CONTAINED).map((l) => l.kind),
    ['write', 'enter', 'read']
  );
});

test('routeLines handles helper-style cells: one line with both templates, Enter through the helper', () => {
  const helperStyle = [
    `const post=x=>\`powershell.exe -Command "Invoke-RestMethod -Uri '${URI}/write' -Method Post -Body ([Convert]::FromBase64String('\${b64(JSON.stringify(x))}'))"\`,rd=t=>\`powershell.exe -Command "(Invoke-RestMethod -Uri '${URI}/read?tail=\${t}').buffer"\`;`,
    'await a(post({data:"dir",enter:false}),"x-write");',
    'await a(post({data:"",enter:true}),"x-enter");',
    'text(await a(rd(4000),"x-read"));',
  ].join('\n');
  assert.deepEqual(
    routeLines(helperStyle).map((l) => [l.kind, l.line.slice(0, 16)]),
    [
      ['write', 'const post=x=>`p'],
      ['read', 'const post=x=>`p'],
      ['enter', 'await a(post({da'],
    ]
  );
});

test('routeLines reads codeApiTerm bridge calls, each by its own arguments', () => {
  // One line holding a write, an Enter sent as "\r" data and a read, as Codex wrote it on 2026-10-02.
  const line =
    'const wjs=`return codeApiTerm.write("codeapi:NewSession",${JSON.stringify(ptyCommand)},{enter:false})`,' +
    'ejs=`return codeApiTerm.write("codeapi:NewSession",${JSON.stringify("\\r")},{enter:false})`,' +
    'rjs=`const r=codeApiTerm.read("codeapi:NewSession",{tail:14000}); return r`;';
  assert.deepEqual(
    routeLines(line).map((l) => [l.kind, l.term]),
    [
      ['write', 'codeapi:NewSession'],
      ['enter', 'codeapi:NewSession'],
      ['read', 'codeapi:NewSession'],
    ]
  );
  assert.deepEqual(
    routeLines('return codeApiTerm.write("t1","",{enter:true})\nreturn codeApiTerm.create("t1",{shell:"pwsh"})').map((l) => l.kind),
    ['enter', 'create']
  );
  // REST terminal ids may contain ':' too
  assert.deepEqual(
    routeLines(`const c=\`Invoke-RestMethod -Uri 'http://127.0.0.1:47338/term/codeapi:NewSession/write' -Method Post\`;`).map((l) => [l.kind, l.term]),
    [['write', 'codeapi:NewSession']]
  );
});

test('terminal creation is one semantic recipe in two physical transports', () => {
  // as Codex wrote them in session 01a0fcec: the typed route (line 2685) and the /exec bridge (line 1288)
  const rest =
    'const command="curl.exe -sS -H \'Content-Type: application/json\' --data-binary \'{\\"id\\":\\"codeapi:NewSession\\",\\"cwd\\":\\"C:/Users/accountName/Desktop/Powershell ToolKit\\",\\"shell\\":\\"powershell.exe\\",\\"show\\":true}\' \'http://127.0.0.1:47338/term/create\'; echo EXIT=$?";';
  const bridge =
    "const ps = `$body = 'return codeApiTerm.create({id:\"codeapi:NewSession\",cwd:\"C:/Users/accountName/Desktop/Powershell ToolKit\",shell:\"powershell.exe\",show:true})'\\nInvoke-WebRequest -Uri 'http://127.0.0.1:47339/exec' -Method Post -ContentType 'text/plain' -Body $body`;";
  assert.deepEqual(
    routeLines(rest).map((l) => [l.kind, l.term, l.transport]),
    [['create', 'codeapi:NewSession', 'REST_TERM']]
  );
  assert.deepEqual(
    routeLines(bridge).map((l) => [l.kind, l.term, l.transport]),
    [['create', 'codeapi:NewSession', 'EXTENSION_EXEC']]
  );
  const handoff = (line, transport) => ({ sessionId: 's', terminal: { recipes: { create: { kind: 'create', term: 'codeapi:NewSession', transport, line, lineNumber: 1, url: null } } } });
  assert.deepEqual(
    [recipesOf(handoff(rest, 'REST_TERM'))[0], recipesOf(handoff(bridge, 'EXTENSION_EXEC'))[0]].map((r) => [r.recipe_id, r.physical_transport]),
    [
      ['codeapi.terminal.create', 'REST_TERM_CREATE'],
      ['codeapi.terminal.create', 'EXTENSION_EXEC_CREATE'],
    ]
  );
});

test('CodeAPI window identity is bound per call from the nearest preceding observation on that port', () => {
  const A = '8030da57-24fc-4d7c-88a1-6e0b9a3427a8';
  const B = '8d3efeac-b45b-49c3-b992-069b67b66e1c';
  const cells = [
    // PowerShell's list output for one addressed port
    cell('s1', 100, 'Invoke-RestMethod http://127.0.0.1:47339/session', `serverPort      : 47339\r\ncodeapiWindowId : ${A}\r\n`),
    // escaped JSON through /exec, soft-wrapped by the PTY inside a key (as at rollout line 1959)
    cell('s2', 200, 'curl http://127.0.0.1:47339/exec', `{\\"serv\\r\\nerPort\\":47339,\\"codeapiWindowId\\":\\"${A}\\"}`),
    // later the port belongs to another window
    cell('s3', 300, 'curl http://127.0.0.1:47339/session', `{"serverPort":47339,"codeapiWindowId":"${B}"}`),
    // the first window answers on another port
    cell('s4', 400, 'curl http://127.0.0.1:47338/session', `{"serverPort":47338,"codeapiWindowId":"${A}"}`),
    // a loop over two ports: each id pairs with the serverPort reported next to it
    cell('s5', 500, 'curl http://127.0.0.1:47338/session http://127.0.0.1:47339/session', `{"serverPort":47338,"codeapiWindowId":"${A}"}\n{"serverPort":47339,"codeapiWindowId":"${B}"}`),
    // an addressed port reporting another serverPort is a phantom, not evidence of ownership
    cell('s6', 600, 'curl http://127.0.0.1:47340/session', `{"serverPort":47341,"codeapiWindowId":"${B}"}`),
  ];
  const observations = windowObservations(cells);
  assert.deepEqual(
    observations.map((o) => [o.line, o.port, o.windowId.slice(0, 8), o.basis]),
    [
      [100, 47339, '8030da57', 'CELL_TARGET_PORT'],
      [200, 47339, '8030da57', 'CELL_TARGET_PORT'],
      [300, 47339, '8d3efeac', 'CELL_TARGET_PORT'],
      [400, 47338, '8030da57', 'CELL_TARGET_PORT'],
      [500, 47338, '8030da57', 'REPORTED_SERVER_PORT'],
      [500, 47339, '8d3efeac', 'REPORTED_SERVER_PORT'],
    ]
  );
  // a call made before the port changed hands keeps the window that owned it then
  assert.deepEqual(bindWindow(observations, 47339, 250), { codeapi_window_id: A, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: 200 });
  assert.equal(bindWindow(observations, 47339, 350).codeapi_window_id, B);
  assert.equal(bindWindow(observations, 47338, 450).codeapi_window_id, A, 'the same window, after it moved');
  assert.deepEqual(bindWindow(observations, 47338, 50), { codeapi_window_id: null, basis: 'NO_PRECEDING_SESSION_OBSERVATION' }, 'a later observation does not bind an earlier call');
});

test('routeLines tells text + Enter apart from a bare Enter, with escaped quotes too', () => {
  const curl = (body) => `const command="curl.exe -sS --data-binary '${body}' 'http://127.0.0.1:47339/term/codeapi:NewSession/write'";`;
  assert.deepEqual(routeLines(curl('{\\"data\\":\\"Get-ChildItem\\",\\"enter\\":true}')).map((l) => l.kind), ['write_enter']);
  assert.deepEqual(routeLines(curl('{\\"data\\":\\"\\",\\"enter\\":true}')).map((l) => l.kind), ['enter']);
  assert.deepEqual(routeLines(curl('{\\"data\\":\\"\\\\r\\"}')).map((l) => l.kind), ['enter']);
  assert.deepEqual(routeLines('return codeApiTerm.write("t1","dir",{enter:true})').map((l) => l.kind), ['write_enter']);
  // the body built on its own line makes the route call text + Enter
  const built = [
    'const payload=JSON.stringify({data,enter:true}),bq=s=>s;',
    "const command=`curl.exe --data-binary ${bq(payload)} 'http://127.0.0.1:47339/term/codeapi:NewSession/write'`;",
  ].join('\n');
  assert.deepEqual(routeLines(built).map((l) => l.kind), ['write_enter']);
});

test('wroteCount reads JSON replies, escaped or not', () => {
  assert.equal(wroteCount('WRITE {"id":"codeapi:NewSession","wrote":505} ENTER {"id":"codeapi:NewSession","wrote":1}'), 1);
  assert.equal(wroteCount('{\\"id\\":\\"codeapi:NewSession\\",\\"wrote\\":0}'), 0);
  assert.equal(wroteCount('{"id":"codeapi:NewSession","bytes":129205,"tail":"PS>"}'), undefined);
});

test('cellResult unwraps exec_command results and follows waits', () => {
  assert.equal(cellResult(cell('c', 1, '', execResult(WROTE(5)))).text, WROTE(5));
  const yielded = cell('y', 2, SELF_CONTAINED, '');
  assert.equal(cellResult(yielded, [wait('w1', 'y', 3, ''), wait('w2', 'y', 4, 'final buffer')]).text, 'final buffer');
});

test('judgeCell rejects failures, script errors, non-zero exits and empty writes', () => {
  const ok = cell('a', 1, '', execResult(WROTE(3)));
  assert.deepEqual(judgeCell(ok, cellResult(ok)), { ok: true, wrote: 3 });
  const zero = cell('b', 2, '', execResult(WROTE(0)));
  assert.equal(judgeCell(zero, cellResult(zero)).ok, false);
  const failed = cell('c', 3, '', 'Script error:\nCommand blocked by PreToolUse hook: GATE REQUIRED', 'failed');
  assert.equal(judgeCell(failed, cellResult(failed)).ok, false);
  const thrown = cell('d', 4, '', '');
  assert.equal(judgeCell(thrown, cellResult(thrown, [wait('w', 'd', 5, 'Script error:\nError: not verified; Enter not sent.')])).ok, false);
  const exit1 = cell('e', 6, '', execResult('boom', 1));
  assert.equal(judgeCell(exit1, cellResult(exit1)).ok, false);
});

test('terminalRecipes keeps the newest working call per kind', () => {
  const cells = [
    cell('write-ok', 10, singleCall(WRITE_CMD), execResult(WROTE(131))),
    cell('gate-only', 20, GATE_ONLY, '{}'),
    cell('write-zero', 30, singleCall(WRITE_CMD), execResult(WROTE(0))),
    cell('enter-ok', 40, singleCall(ENTER_CMD), execResult(WROTE(1))),
    cell('read-failed', 50, singleCall(READ_CMD), 'Script error:\nboom', 'failed'),
    cell('read-ok', 60, singleCall(READ_CMD), execResult('C:\\> dir')),
  ];
  const { recipes, cell: saved } = terminalRecipes(cells, new Map());
  assert.equal(recipes.write.cellId, 'write-ok');
  assert.equal(recipes.write.wrote, 131);
  assert.equal(recipes.enter.cellId, 'enter-ok');
  assert.equal(recipes.read.cellId, 'read-ok');
  assert.equal(saved.id, 'write-ok');
});

test('terminalRecipes prefers a newer self-contained cell and saves it with its helpers', () => {
  const cells = [cell('old', 10, singleCall(WRITE_CMD), execResult(WROTE(9))), cell('new', 20, SELF_CONTAINED, '', 'completed')];
  const waits = new Map([['new', [wait('w1', 'new', 21, ''), wait('w2', 'new', 22, 'C:\\> dir\r\n')]]]);
  const { recipes, cell: saved } = terminalRecipes(cells, waits);
  assert.deepEqual(
    ['write', 'enter', 'read'].map((k) => recipes[k].cellId),
    ['new', 'new', 'new']
  );
  // the cell made three calls, so no single reply count belongs to any one of them
  assert.equal(recipes.write.wrote, undefined);
  assert.equal(saved.id, 'new');
  assert.deepEqual(saved.helpers, ['sha256(s)', 'run(c,id,reason)', 'b64(s)']);
  assert.equal(saved.source, SELF_CONTAINED);
});

test('storeKeys records stores, loads and usage lines from cells that worked', () => {
  const keys = storeKeys([
    cell('s', 10, 'store("helios_sha256_source", String(sha256));'),
    cell('l1', 20, 'const sha256=new Function(`return (${load("helios_sha256_source")})`)();'),
    cell('l2', 30, 'const v = load("helios_sha256_source");\ntext(load(\'probe\'));'),
    // a typo Codex made once: the cell failed, so its line must not be handed back
    cell('typo', 40, 'const sha256=new Function(`return (${load("helios_sha256_source")})`());', 'Script error:\nTypeError: load(...) is not a function', 'failed'),
    cell('s2', 50, 'store("helios_sha256_source", broken);', 'Script error:\nReferenceError: broken is not defined', 'failed'),
    cell('p', 60, 'store("helios_prev_corr", id);\nawait tools.exec_command({cmd});', '{}'),
  ]);
  assert.equal(keys.find((k) => k.key === 'helios_prev_corr').storeCellRunsTools, true);
  const sha = keys.find((k) => k.key === 'helios_sha256_source');
  assert.equal(sha.stores, 2);
  assert.equal(sha.lastStoreLine, 10);
  assert.equal(sha.loads, 3);
  assert.equal(sha.lastLoadLine, 40);
  assert.deepEqual(sha.usage, ['const v = load("helios_sha256_source");', 'const sha256=new Function(`return (${load("helios_sha256_source")})`)();']);
  assert.equal(sha.source, 'store("helios_sha256_source", String(sha256));');
  assert.equal(sha.storeCellRunsTools, false);
  assert.equal(keys.find((k) => k.key === 'probe').stores, 0);
});

test('renderHandoff never tells Codex to re-run a storing cell that also runs tools', () => {
  const h = {
    takenAt: 'pre_compact',
    compactions: 0,
    records: 10,
    untilLine: null,
    lastRecordAt: null,
    task: [],
    position: { agentMessages: [], lastCell: null },
    terminal: { recipes: {}, cell: null },
    sandbox: [],
    helios: null,
    store: [
      { key: 'pure', stores: 1, loads: 1, lastStoreLine: 5, usage: [], storeCellRunsTools: false },
      { key: 'mixed', stores: 1, loads: 1, lastStoreLine: 6, usage: [], storeCellRunsTools: true },
    ],
  };
  const text = renderHandoff(h, { files: { storeDir: 'C:\\s', store: { pure: 'C:\\s\\store-pure.js', mixed: 'C:\\s\\store-mixed.js' } } });
  assert.ok(text.includes('the cells that stored them are saved in C:\\s'));
  assert.ok(text.includes('re-run store-pure.js'));
  assert.ok(text.includes('rebuild it from the store() call in store-mixed.js'));
  assert.ok(!text.includes('re-run store-mixed.js'));
});

test('standing references carry their hash and come before everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-handoff-ref-'));
  try {
    const index = join(dir, 'Operational-Index.md');
    writeFileSync(index, '# Index\n');
    const refs = readReferences({ references: [{ path: index, note: 'Map of the docs.' }, { path: join(dir, 'missing.md') }] });
    assert.equal(refs[0].sha256, createHash('sha256').update('# Index\n').digest('hex'));
    assert.equal(refs[1].exists, false);
    const text = renderHandoff({
      takenAt: 'pre_compact',
      compactions: 0,
      records: 10,
      untilLine: null,
      lastRecordAt: null,
      references: refs,
      task: [{ lineNumber: 2, timestamp: ts(2), attachments: [], request: 'go on' }],
      position: { agentMessages: [], lastCell: null },
      terminal: { recipes: {}, cell: null },
      store: [],
      sandbox: [],
      helios: null,
    });
    assert.ok(text.indexOf('START HERE') < text.indexOf('TASK'));
    assert.ok(text.includes(`${index}: Map of the docs. (sha256 ${refs[0].sha256.slice(0, 12)}…`));
    assert.ok(text.includes('missing.md (not found at snapshot time)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderHandoff shows a line that serves several kinds once', () => {
  const line = 'const wjs=`return codeApiTerm.write("t",x,{enter:false})`,ejs=`return codeApiTerm.write("t","\\r",{enter:false})`;';
  const r = { line, lineNumber: 7, timestamp: '2026-10-02T15:26:50.000Z' };
  const h = {
    takenAt: 'pre_compact',
    compactions: 0,
    records: 10,
    untilLine: null,
    lastRecordAt: null,
    task: [],
    position: { agentMessages: [], lastCell: null },
    terminal: { recipes: { write: { ...r, kind: 'write' }, enter: { ...r, kind: 'enter' } }, cell: null },
    store: [],
    sandbox: [],
    helios: null,
  };
  const text = renderHandoff(h);
  assert.ok(text.includes('- write text, Enter (cell at line 7'));
  assert.equal(text.split(line).length - 1, 1);
});

test('renderHandoff cuts the store section before the Helios chain', () => {
  const h = {
    takenAt: 'pre_compact',
    compactions: 0,
    records: 10,
    untilLine: null,
    lastRecordAt: null,
    task: [],
    position: { agentMessages: [], lastCell: null },
    terminal: { recipes: {}, cell: null },
    sandbox: [],
    helios: { pendingDir: 'C:\\gate\\pending', evidenceDir: 'C:\\gate\\evidence', chainPredecessor: { correlationId: 'corr-7', at: null } },
    store: Array.from({ length: 12 }, (_, i) => ({ key: `key_${i}`, stores: 1, loads: 1, lastStoreLine: i, usage: ['x'.repeat(300)] })),
  };
  const text = renderHandoff(h, { maxChars: 1500 });
  assert.ok(text.length <= 1500);
  assert.ok(text.includes('corr-7'));
  assert.ok(text.indexOf('HELIOS GATE') < text.indexOf('CODE-MODE STORE'));
});

test('sandboxLimits takes ReferenceErrors and typeof probes, not other "undefined" strings', () => {
  const limits = sandboxLimits(
    [
      cell('a', 10, 'crypto.subtle', 'Script error:\nReferenceError: crypto is not defined', 'failed'),
      cell('b', 20, 'text(JSON.stringify({btoa: typeof btoa}))', '{"btoa":"undefined"}'),
      cell('c', 30, 'text(JSON.stringify({type: x.type}))', '{"type":"undefined"}'),
    ],
    new Map()
  );
  assert.deepEqual(limits, [
    { name: 'crypto', lineNumber: 10 },
    { name: 'btoa', lineNumber: 20 },
  ]);
});

test('buildHandoff and renderHandoff produce bounded text with the key facts', () => {
  const doc = {
    schema: 'codex-export.v1',
    file: 'C:/rollout.jsonl',
    untilLine: 100,
    records: 99,
    session: {
      metadata: { threadId: 'thread-1' },
      model: 'm',
      timeline: [
        { kind: 'user_message', lineNumber: 2, timestamp: ts(2), text: '## "Task th…": C:\\a\\Pasted text.txt\n\n## My request:\n\ngo' },
        { kind: 'compaction', lineNumber: 5, timestamp: ts(5), encrypted: true },
        { kind: 'agent_message', lineNumber: 6, timestamp: ts(6), text: 'x'.repeat(5000) },
        { kind: 'agent_message', lineNumber: 7, timestamp: ts(7), text: 'Reading the PTY buffer next.' },
      ],
      executions: [cell('w', 10, singleCall(WRITE_CMD), execResult(WROTE(131))), cell('r', 20, singleCall(READ_CMD), execResult('\x1b[32mC:\\>\x1b[0m'))],
    },
  };
  const helios = {
    pendingDir: 'C:\\gate\\pending',
    evidenceDir: 'C:\\gate\\evidence',
    gateSchemaVersion: 'command-gate.v1',
    separators: [';', '&&', '||', '|'],
    tierRequiredFields: { 0: ['need'], 2: ['need', 'stop_conditions'] },
    exitCaptureSuffixes: { bash: ['; echo EXIT=$?'] },
    notApplicableReasons: ['pure_output'],
    chainPredecessor: { correlationId: 'corr-42', at: '2026-10-02T04:59:00Z' },
  };
  const h = buildHandoff(doc, { helios });
  assert.equal(h.sessionId, 'thread-1');
  assert.equal(h.compactions, 1);
  assert.equal(h.position.lastCell.result, 'C:\\>');
  const text = renderHandoff(h, { maxChars: 3000, files: { terminalCell: 'C:\\state\\terminal-cell.js', store: {} } });
  assert.ok(text.length <= 3000, `length ${text.length}`);
  for (const fact of ['compaction #2', 'C:\\a\\Pasted text.txt', 'Reading the PTY buffer next.', 'wrote 131', 'terminal-cell.js', 'corr-42', 'GATE REJECTED']) {
    assert.ok(text.includes(fact), `missing ${fact}`);
  }
  const tiny = renderHandoff(h, { maxChars: 400, files: { handoffJson: 'C:\\state\\handoff.json' } });
  assert.ok(tiny.length <= 400 && tiny.endsWith('full hand-off: C:\\state\\handoff.json)'));
});
