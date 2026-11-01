// Builds the hand-off from a codex-export.v1 document (claude-devtools' normalized session):
// what Codex was asked, where it stood, the terminal recipes that last worked, its code-mode
// store keys and the sandbox limits it ran into. Only recorded session content is used; a recipe
// counts as working only when the cell that ran it completed without a script error.

import { scopeAlignment } from './alignment.mjs';
import { lf, sha256 } from './files.mjs';

const HANDOFF_SCHEMA = 'codex-handoff.v1';
// Terminal calls Codex makes through CodeAPI, in two physical transports: the REST routes
// (`/term/<id>/write|read`, `POST /term/create` with the id in its JSON body) or the JS bridge
// posted to `/exec` (`codeApiTerm.write|read|create("<id>", ...)`, `codeApiTerm.create({id: ...})`).
// Groups: 1 REST term, 2 REST op, 3 bridge op, 4 bridge term, 5 REST create, 6 bridge create.
const TERM_CALLS =
  /\/term\/([^/\s'"`?]+)\/(write|read)\b|codeApiTerm\.(write|read|create)\(\s*["'`]([^"'`]+)["'`]|(\/term\/create)\b|codeApiTerm\.(create)\(\s*\{/g;
const CREATE_ID = /\\*["']?\bid\\*["']?\s*:\s*\\*["'`]([^"'`\\]+)/;
export const TRANSPORT_NAMES = { REST_TERM: '/term routes', EXTENSION_EXEC: 'codeApiTerm via /exec' };
// Enter is sent either as an `enter: true` flag (quotes possibly escaped: `\"enter\":true`) or as a
// carriage return written as the data (`[char]13`, "\r").
const ENTER_FLAG = /enter\\?["']?\s*:\s*true/i;
const CR_DATA = /\[char\]\s*13|\\?["'`]\\{1,2}r\\?["'`]/;
const EMPTY_DATA = /data\\?["']?\s*[:=]\s*(?:\\?["'`]){2}/;
const EMPTY_BRIDGE_DATA = /^\(\s*["'`][^"'`]*["'`]\s*,\s*["'`]["'`]/;
const SCRIPT_ERROR = /^\s*Script error/;
const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/;
const RUNS_TOOLS = /\btools\.\w+|\bexec_command\b|\bapply_patch\b/;
// CodeAPI window identity in a response: JSON (escaped or not) or PowerShell's `key : value` list.
const WINDOW_ID = /codeapiWindowId\\*"?\s*[:=]\s*\\*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const SERVER_PORT = /serverPort\\*"?\s*[:=]\s*(\d{4,5})(?!\d)/gi;
const LOCAL_PORT = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d{4,5})(?!\d)/g;
export const portOf = (url) => Number(String(url ?? '').match(/:(\d{4,5})(?!\d)/)?.[1]) || null;

export function stripTerminal(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07]*\x07/g, '') // window-title sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // colours and cursor movement
    .replace(/\x08\r?\n/g, '') // soft wraps the PTY renders as backspace + newline
    .replace(/\r/g, '');
}

export function bounded(text, max) {
  const t = String(text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function tailBounded(text, max) {
  const t = String(text ?? '').trim();
  return t.length <= max ? t : `…${t.slice(-(max - 1))}`;
}

// User messages with pasted files list them as `## "<title>": <path>` lines.
export function parseUserMessage(text) {
  const source = String(text ?? '');
  const attachments = [...source.matchAll(/^## "(.+?)": (.+?)[ \t]*$/gm)].map((m) => ({ title: m[1], path: m[2] }));
  const typed = source.match(/^## My request:[ \t]*\n([\s\S]*)$/m);
  const request = (attachments.length ? (typed ? typed[1] : '') : source).trim();
  return { attachments, request };
}

function waitsByCell(executions) {
  const map = new Map();
  for (const x of executions) {
    if (x.kind !== 'code_wait' || !x.parentId) continue;
    if (!map.has(x.parentId)) map.set(x.parentId, []);
    map.get(x.parentId).push(x);
  }
  return map;
}

// What a cell returned: its own output or, when it yielded, the last wait that reported output.
// Single-call cells print exec_command's JSON result, whose `output` is the command's text.
export function cellResult(cell, waits = []) {
  const outputs = [cell.output, ...waits.map((w) => w.output)].filter((t) => typeof t === 'string' && t.trim());
  const raw = outputs.at(-1) ?? '';
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.output === 'string') return { text: parsed.output, exitCode: parsed.exit_code, outputs };
    } catch {
      // not a JSON result
    }
  }
  return { text: raw, outputs };
}

// A CodeAPI write answers `{"id":"<term>","wrote":<n>}`; PowerShell shows it as a table
// (`id  wrote` / `--  -----` / `<term>  <n>`). Cells that return several results as JSON carry the
// table with escaped newlines. With several writes in one result, the smallest count decides
// (any `wrote 0` means a write did not land).
export function wroteCount(text) {
  const plain = String(text ?? '')
    .replace(/\\r|\r/g, '')
    .replace(/\\n/g, '\n');
  const counts = [
    ...[...plain.matchAll(/\bid\s+wrote\s*\n\s*-+\s+-+\s*\n\s*\S+\s+(\d+)/g)].map((m) => Number(m[1])),
    ...[...plain.matchAll(/\\?"?\bwrote\\?"?\s*[:=]\s*(\d+)/g)].map((m) => Number(m[1])),
  ];
  return counts.length ? Math.min(...counts) : undefined;
}

function cellWorked(cell, waits = []) {
  const outputs = [cell.output, ...waits.map((w) => w.output)].filter((t) => typeof t === 'string');
  return cell.status === 'completed' && !outputs.some((t) => SCRIPT_ERROR.test(t));
}

export function judgeCell(cell, result) {
  if (cell.status !== 'completed') return { ok: false, reason: cell.status };
  if (result.outputs.some((t) => SCRIPT_ERROR.test(t))) return { ok: false, reason: 'script error' };
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return { ok: false, reason: `exit code ${result.exitCode}` };
  const wrote = wroteCount(result.text);
  if (wrote === 0) return { ok: false, reason: 'wrote 0 bytes' };
  if (wrote === undefined && !result.text.trim()) return { ok: false, reason: 'no result' };
  return { ok: true, wrote };
}

// The argument list of a call whose '(' is at `open`, up to its matching ')' (or the line's end).
function callArgs(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open, i + 1);
  }
  return line.slice(open);
}

// A write that only presses Enter ('enter'), types text and presses Enter in one call
// ('write_enter'), or only types text ('write').
function writeKind(text, bridgeArgs = false) {
  if (CR_DATA.test(text)) return 'enter';
  if (!ENTER_FLAG.test(text)) return 'write';
  return (bridgeArgs ? EMPTY_BRIDGE_DATA : EMPTY_DATA).test(text) ? 'enter' : 'write_enter';
}

// What one terminal call on a line does. A bridge call is judged by its own arguments; a REST route
// by the text between its neighbours on the line, since its body is often built just before it
// (`eb=b64(JSON.stringify({data:"",enter:true})),ec=\`...term/codex/write...\``).
function callKind(line, ops, i) {
  const m = ops[i];
  if (m[5] || m[6]) return 'create';
  const op = m[2] ?? m[3];
  if (op === 'read' || op === 'create') return op;
  if (m[3]) return writeKind(callArgs(line, line.indexOf('(', m.index)), true);
  const from = i > 0 ? ops[i - 1].index + ops[i - 1][0].length : 0;
  return writeKind(line.slice(from, i + 1 < ops.length ? ops[i + 1].index : line.length));
}

// The terminal a create call names: a bridge create in its own argument object, a REST create in
// its JSON body, which can stand before or after the route on the line.
function createTerm(line, m) {
  const scope = m[6] ? callArgs(line, line.indexOf('(', m.index)) : line;
  return scope.match(CREATE_ID)?.[1] ?? null;
}

// Source lines that make terminal calls, outside patch text (gate files quote commands too). One
// line can hold several calls (a write, an Enter and a read); it then counts for each of them.
// Each call keeps its physical transport: REST_TERM (/term routes) or EXTENSION_EXEC (/exec bridge).
export function routeLines(source) {
  const lines = [];
  const enterCalls = [];
  let inPatch = false;
  for (const line of String(source ?? '').split('\n')) {
    if (line.includes('*** Begin Patch')) inPatch = true;
    const skip = inPatch || line.trimStart().startsWith('//');
    const ops = skip ? [] : [...line.matchAll(TERM_CALLS)];
    const kinds = new Set();
    ops.forEach((m, i) => {
      const kind = callKind(line, ops, i);
      const transport = m[1] || m[5] ? 'REST_TERM' : 'EXTENSION_EXEC';
      const term = m[1] ?? m[4] ?? (m[5] || m[6] ? createTerm(line, m) : null);
      if (!kinds.has(kind)) lines.push({ kind, term, transport, line: line.trim() });
      kinds.add(kind);
    });
    if (!skip && !ops.length && ENTER_FLAG.test(line)) enterCalls.push(line.trim());
    if (line.includes('*** End Patch')) inPatch = false;
  }
  // Lines with an enter flag but no terminal call: in a cell that writes, either Enter sent through
  // a helper (post({data:"",enter:true})) or a write body built on its own line
  // (payload=JSON.stringify({data,enter:true})), which makes that cell's writes text + Enter.
  const writer = lines.find((l) => l.kind === 'write' || l.kind === 'write_enter');
  if (writer) {
    for (const line of enterCalls) {
      const kind = writeKind(line);
      if (kind === 'write_enter') {
        for (const l of lines) if (l.kind === 'write') l.kind = 'write_enter';
      } else if (!lines.some((l) => l.kind === kind)) {
        lines.push({ kind, term: writer.term, transport: writer.transport, line });
      }
    }
  }
  return lines;
}

export function helperSignatures(source) {
  const text = String(source ?? '');
  const sigs = [];
  for (const m of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) sigs.push(`${m[1]}(${m[2].trim()})`);
  for (const m of text.matchAll(/(?:const|let|var|,)\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) sigs.push(`${m[1]}(${m[2].trim()})`);
  for (const m of text.matchAll(/(?:const|let|var|,)\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g)) sigs.push(`${m[1]}(${m[2]})`);
  return [...new Set(sigs)].map((s) => bounded(s, 100));
}

// Newest working line per kind (write, enter, read, create), and the newest working cell that wrote
// text, which holds the whole procedure (gate, hash, chain) as Codex last ran it.
export function terminalRecipes(cells, waits) {
  const recipes = {};
  let cell = null;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    const source = c.input ?? '';
    if (!/\bexec_command\b/.test(source)) continue;
    const lines = routeLines(source);
    if (!lines.length) continue;
    const verdict = judgeCell(c, cellResult(c, waits.get(c.id)));
    if (!verdict.ok) continue;
    // A reply count belongs to a line only when the cell made that one call.
    const wrote = lines.length === 1 ? verdict.wrote : undefined;
    for (const l of lines) {
      // the endpoint: the line's own URL, else the first local URL in the cell (a bridge call's /exec)
      const url = (l.line.match(LOCAL_URL) ?? source.match(LOCAL_URL))?.[0] ?? null;
      // physical identity of the occurrence: the cell's bytes and the call line's bytes
      recipes[l.kind] ??= {
        ...l,
        line: bounded(l.line, 450),
        url,
        port: portOf(url),
        cellId: c.id,
        lineNumber: c.lineNumber,
        timestamp: c.timestamp,
        wrote,
        cellSha256: sha256(lf(source)),
        lineSha256: sha256(l.line),
      };
    }
    if (!cell && lines.some((l) => l.kind === 'write' || l.kind === 'write_enter')) {
      cell = { id: c.id, lineNumber: c.lineNumber, timestamp: c.timestamp, helpers: helperSignatures(source), source };
    }
    if (cell && recipes.write && recipes.enter && recipes.read && recipes.create) break;
  }
  return { recipes, cell };
}

// The PTY soft-wraps long output, also inside escaped JSON (`serv\\r\\nerPort`); identity matching
// reads the text with those breaks removed.
const unwrapped = (text) => text.replace(/\\+r\\+n|\r\n/g, '');

// Which CodeAPI window answered on which port, and when: every cell output that reports a
// codeapiWindowId. A cell that addressed one port binds the reported window to that port (if the
// response names a serverPort it must be the same port); a cell that addressed several pairs each
// window id with the nearest serverPort in the response. One port reporting two windows, or a
// serverPort that differs from the addressed port, is left out: it does not say who owned the port.
export function windowObservations(cells, waits = new Map()) {
  const seen = new Map();
  for (const c of cells) {
    const outputs = [c.output, ...(waits.get(c.id) ?? []).map((w) => w.output)].filter((t) => typeof t === 'string' && t).join('\n');
    const text = unwrapped(outputs);
    const ids = [...text.matchAll(WINDOW_ID)];
    if (!ids.length) continue;
    const targets = [...new Set([...String(c.input ?? '').matchAll(LOCAL_PORT)].map((m) => Number(m[1])))];
    const reported = [...text.matchAll(SERVER_PORT)];
    const found = [];
    if (targets.length === 1) {
      const windows = [...new Set(ids.map((m) => m[1].toLowerCase()))];
      if (windows.length === 1 && reported.every((m) => Number(m[1]) === targets[0])) {
        found.push({ port: targets[0], windowId: windows[0], basis: 'CELL_TARGET_PORT' });
      }
    } else {
      for (const m of ids) {
        const near = reported.map((p) => ({ port: Number(p[1]), distance: Math.abs(p.index - m.index) })).sort((a, b) => a.distance - b.distance)[0];
        if (near && near.distance <= 1500 && (!targets.length || targets.includes(near.port))) found.push({ port: near.port, windowId: m[1].toLowerCase(), basis: 'REPORTED_SERVER_PORT' });
      }
    }
    for (const o of found) {
      const key = `${o.port}|${o.windowId}|${c.lineNumber}`;
      if (!seen.has(key)) seen.set(key, { ...o, line: c.lineNumber, timestamp: c.timestamp ?? null, cellId: c.id });
    }
  }
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

// The window that owned `port` when the call at `line` was made: the nearest preceding observation
// on that port. A port can belong to another window later; that later observation binds later calls
// only. Without a preceding observation the window stays unresolved, even if one follows.
export function bindWindow(observations, port, line) {
  if (!port) return { codeapi_window_id: null, basis: 'NO_ENDPOINT' };
  const before = observations.filter((o) => o.port === port && o.line <= line).at(-1);
  return before
    ? { codeapi_window_id: before.windowId, basis: 'NEAREST_PRECEDING_SESSION_OBSERVATION', observation_line: before.line }
    : { codeapi_window_id: null, basis: 'NO_PRECEDING_SESSION_OBSERVATION' };
}

const transportOf = (r) => r.transport ?? (/codeApiTerm\./.test(r.line ?? '') ? 'EXTENSION_EXEC' : 'REST_TERM');

// Where the working terminal calls went, grouped by identity, not by locator: one entry per CodeAPI
// window and terminal, with the endpoint of its newest call (ports move when windows reopen) and
// every endpoint, transport and rollout line seen. Calls without a bound window are grouped by URL.
export function terminalEndpoints(terminal) {
  const groups = new Map();
  const calls = Object.values(terminal.recipes).sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
  for (const r of calls) {
    const windowId = r.window?.codeapi_window_id ?? null;
    const key = windowId ? `window:${windowId}|${r.term}` : `url:${r.url}|${r.term}`;
    if (!groups.has(key)) groups.set(key, { term: r.term ?? null, window: null, url: null, urls: [], transports: [], lines: [] });
    const g = groups.get(key);
    if (windowId) g.window = { id: windowId, basis: r.window.basis, observation_line: r.window.observation_line ?? null };
    if (r.url) {
      g.url = r.url;
      if (!g.urls.includes(r.url)) g.urls.push(r.url);
    }
    const transport = TRANSPORT_NAMES[transportOf(r)];
    if (!g.transports.includes(transport)) g.transports.push(transport);
    if (r.lineNumber && !g.lines.includes(r.lineNumber)) g.lines.push(r.lineNumber);
  }
  return [...groups.values()].map((g) => ({ ...g, lines: g.lines.sort((a, b) => a - b) }));
}

// Keys passed to store()/load(). Usage lines and the storing cell come only from cells that
// worked, so a line Codex got wrong is never handed back as the way to do it.

export function storeKeys(cells, waits = new Map()) {
  const keys = new Map();
  const entry = (key) => {
    if (!keys.has(key)) keys.set(key, { key, stores: 0, loads: 0, usage: [], workingLoadLines: [] });
    return keys.get(key);
  };
  for (const c of cells) {
    const source = String(c.input ?? '');
    const worked = cellWorked(c, waits.get(c.id));
    for (const m of source.matchAll(/\bstore\(\s*(["'`])([^"'`\n]+)\1/g)) {
      const k = entry(m[2]);
      k.stores++;
      if (worked) {
        k.lastStoreLine = c.lineNumber;
        k.source = source;
        // Such a cell cannot simply be re-run to restore the value: it would repeat its calls.
        k.storeCellRunsTools = RUNS_TOOLS.test(source);
      }
    }
    for (const line of source.split('\n')) {
      for (const m of line.matchAll(/\bload\(\s*(["'`])([^"'`\n]+)\1\s*\)/g)) {
        const k = entry(m[2]);
        k.loads++;
        k.lastLoadLine = c.lineNumber;
        if (!worked) continue;
        if (!k.workingLoadLines.includes(c.lineNumber)) k.workingLoadLines.push(c.lineNumber);
        // lines that differ only near the end (an error message, say) count as one usage
        const use = bounded(line.trim(), 220);
        k.usage = [use, ...k.usage.filter((u) => u.slice(0, 80) !== use.slice(0, 80))].slice(0, 2);
      }
    }
  }
  const lastUse = (k) => Math.max(k.lastStoreLine ?? 0, k.lastLoadLine ?? 0);
  return [...keys.values()].sort((a, b) => lastUse(b) - lastUse(a));
}

// Globals the code-mode sandbox lacks: ReferenceErrors, and `typeof x` probes that printed "undefined".
export function sandboxLimits(cells, waits) {
  const names = new Map();
  for (const c of cells) {
    const outputs = [c.output, ...(waits.get(c.id) ?? []).map((w) => w.output)].filter(Boolean).join('\n');
    if (!outputs) continue;
    for (const m of outputs.matchAll(/ReferenceError: ([A-Za-z_$][\w$]*) is not defined/g)) {
      if (!names.has(m[1])) names.set(m[1], c.lineNumber);
    }
    const source = String(c.input ?? '');
    for (const m of outputs.matchAll(/"([A-Za-z_$][\w$]*)"\s*:\s*"undefined"/g)) {
      const probe = new RegExp(`typeof\\s+${m[1].replace(/\$/g, '\\$')}\\b`);
      if (probe.test(source) && !names.has(m[1])) names.set(m[1], c.lineNumber);
    }
  }
  return [...names].map(([name, lineNumber]) => ({ name, lineNumber }));
}

// takenAt: 'pre_compact' (PreCompact snapshot, or a dry run cut before a compaction line),
// 'session_start' (rebuilt after the compaction or on resume; `source` says which) or 'manual'.
// scope: the task paths of the index the hooks maintain, for the alignment evidence.
// thread: the thread view the document was merged from (lib/thread.mjs): its rollout files
// (segments, with the line offset of each) and the files left out. Line numbers in `doc` are thread
// lines; a thread kept in one file has one segment at offset 0, so they are its file lines.
export function buildHandoff(doc, { sessionId, helios = null, references = [], scope = { paths: [], source: 'none declared' }, takenAt = 'pre_compact', source = null, thread = null } = {}) {
  const s = doc.session;
  const timeline = s.timeline ?? [];
  const executions = s.executions ?? [];
  const cells = executions.filter((x) => x.kind === 'code_cell');
  const waits = waitsByCell(executions);

  const task = timeline
    .filter((e) => e.kind === 'user_message')
    .slice(-3)
    .map((e) => ({ lineNumber: e.lineNumber, timestamp: e.timestamp, ...parseUserMessage(e.text) }));
  const agentMessages = timeline
    .filter((e) => e.kind === 'agent_message' && !e.recipient)
    .slice(-3)
    .map((e) => ({ lineNumber: e.lineNumber, timestamp: e.timestamp, phase: e.phase, text: e.text }));
  const last = cells.at(-1);
  const lastCell = last
    ? {
        lineNumber: last.lineNumber,
        timestamp: last.timestamp,
        status: last.status,
        result: tailBounded(stripTerminal(cellResult(last, waits.get(last.id)).text), 600),
      }
    : null;
  const lastAt = timeline.reduce((at, e) => (e.timestamp && e.timestamp > at ? e.timestamp : at), '');
  const terminal = terminalRecipes(cells, waits);
  const observations = windowObservations(cells, waits);
  for (const r of Object.values(terminal.recipes)) r.window = bindWindow(observations, r.port, r.lineNumber);
  const userMessages = timeline.filter((e) => e.kind === 'user_message').map((e) => ({ lineNumber: e.lineNumber, text: e.text }));
  const keys = storeKeys(cells, waits);

  return {
    schema: HANDOFF_SCHEMA,
    takenAt,
    source,
    sessionId: sessionId ?? s.metadata?.threadId ?? null,
    cwd: s.metadata?.cwd ?? null,
    rollout: doc.file,
    untilLine: doc.untilLine ?? null,
    records: doc.records,
    lastRecordAt: lastAt || null,
    compactions: timeline.filter((e) => e.kind === 'compaction').length,
    compactionLines: timeline.filter((e) => e.kind === 'compaction').map((e) => e.lineNumber),
    model: s.model ?? null,
    references,
    task,
    position: { agentMessages, lastCell },
    terminal,
    endpoints: terminalEndpoints(terminal),
    codeapi: { observations: observations.map(({ cellId: _c, ...o }) => o) },
    scope,
    alignment: scopeAlignment({ cwd: s.metadata?.cwd, userMessages }, scope.paths),
    store: keys.slice(0, 8),
    // every key the record saw, so a key not carried can be shown displaced rather than lost
    storeTotal: keys.length,
    sandbox: sandboxLimits(cells, waits),
    helios,
    thread: thread
      ? { id: thread.threadId ?? null, segments: thread.segments ?? [], excluded: thread.excluded ?? [] }
      : { id: sessionId ?? s.metadata?.threadId ?? null, segments: [], excluded: [] },
  };
}
