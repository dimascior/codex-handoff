// Runtime routing for the hand-off, resolved when it is injected, never stored: a record keeps the
// CodeAPI window identity (codeapiWindowId) of each terminal it saw working and the endpoint it
// used then; ports move when VS Code windows reopen, so the endpoint is history. At SessionStart
// the hook asks every CodeAPI instance on the local port band who it is (GET /session), matches the
// recorded window identities, and checks each terminal (GET /term/list). Read-only.
//
//   CURRENT                 exactly one running instance reports the window id
//   UNRESOLVED              none does: the recorded endpoint must not be used as current
//   AMBIGUOUS               several do: check /session before using any of them
//   IDENTITY_NOT_RECORDED   the session recorded no window identity for that terminal
//
// A failed resolution never falls back to the recorded endpoint.

export const DEFAULT_PORTS = Array.from({ length: 64 }, (_, i) => 47337 + i);

async function getJson(url, timeoutMs) {
  // CODEAPI's optional public-service token is separate from its private adapter token.
  // Discovery still works without it; terminal inspection requires it when enabled.
  const token = process.env.CODEAPI_PUBLIC_TOKEN;
  const headers = token ? { 'X-CODEAPI-TOKEN': token } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const workspaceName = (uri) => (uri ? decodeURIComponent(String(uri)).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null);

// Every CodeAPI instance answering on the band, as it identifies itself. An instance whose
// serverPort differs from the port it answered on is a phantom (CodeAPI discovery's
// port-mismatch) and is left out.
export async function discoverWindows({ ports = DEFAULT_PORTS, host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  const answers = await Promise.all(
    ports.map(async (port) => {
      try {
        const s = await getJson(`http://${host}:${port}/session`, timeoutMs);
        if (s.serverPort != null && Number(s.serverPort) !== port) return null;
        return { port, windowId: s.codeapiWindowId ? String(s.codeapiWindowId).toLowerCase() : null, workspace: workspaceName(s.workspaceUri), extensionHostPid: s.extensionHostPid ?? null };
      } catch {
        return null;
      }
    })
  );
  return answers.filter(Boolean);
}

async function terminalOn(port, term, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  if (!term) return { present: false };
  try {
    const body = await getJson(`http://${host}:${port}/term/list`, timeoutMs);
    const list = Array.isArray(body) ? body : (body.terminals ?? body.items ?? []);
    const t = list.find((x) => x?.id === term);
    return t ? { present: true, alive: t.alive !== false, pid: t.pid ?? null } : { present: false };
  } catch (error) {
    return { present: null, error: error.message };
  }
}

// Recorded endpoints come from a record's handoff.endpoints: identity groups ({term, window, url,
// urls}) in records that bind windows, or ({term, url, transport}) in records made before that.
export async function resolveRuntime(endpoints, options = {}) {
  const windows = await discoverWindows(options);
  const results = [];
  for (const e of endpoints ?? []) {
    const recorded = e.url ?? null;
    const windowId = e.window?.id ?? null;
    if (!windowId) {
      results.push({ term: e.term ?? null, windowId: null, status: 'IDENTITY_NOT_RECORDED', recorded });
      continue;
    }
    const matches = windows.filter((w) => w.windowId === windowId);
    if (matches.length === 1) {
      const [w] = matches;
      results.push({ term: e.term ?? null, windowId, status: 'CURRENT', current: `http://${options.host ?? '127.0.0.1'}:${w.port}`, workspace: w.workspace, recorded, terminal: await terminalOn(w.port, e.term, options) });
    } else {
      results.push({ term: e.term ?? null, windowId, status: matches.length ? 'AMBIGUOUS' : 'UNRESOLVED', ports: matches.map((w) => w.port), recorded });
    }
  }
  return { checkedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), windows, results };
}

const portRange = (ports) => (ports?.length ? `${Math.min(...ports)}-${Math.max(...ports)}` : 'none');

function terminalText(r) {
  const t = r.terminal ?? {};
  if (t.present === null) return `terminal ${r.term ?? '(id not recorded)'}: list unavailable (${t.error}); check /term/list before use`;
  if (!t.present) return `terminal ${r.term ?? '(id not recorded)'}: not present in that window; create it again there before writing (the create recipe below, if one was recorded)`;
  return `terminal ${r.term}: ${t.alive ? 'alive' : 'present but not alive'}${t.pid ? `, pid ${t.pid}` : ''}`;
}

// The text injected ahead of the hand-off. It names current endpoints by window identity and
// marks every recorded endpoint as history.
export function renderLiveBlock(res, { ports } = {}) {
  const out = [`[codex-handoff] CodeAPI right now (checked at injection, ${res.checkedAt}). Ports in the recorded calls below are history; route terminal calls by CodeAPI window identity:`];
  for (const r of res.results) {
    const id = r.windowId ?? '';
    if (r.status === 'CURRENT') {
      const moved = r.recorded && r.recorded !== r.current ? ` (recorded at ${r.recorded}; use ${r.current} instead)` : '';
      out.push(`- CodeAPI window ${id}${r.workspace ? ` (${r.workspace})` : ''}: CURRENT endpoint ${r.current}${moved}; ${terminalText(r)}.`);
    } else if (r.status === 'AMBIGUOUS') {
      out.push(`- CodeAPI window ${id}: AMBIGUOUS, answers on ports ${r.ports.join(', ')}; compare their /session (extensionHostPid, vscodeSessionId) before using either. Historical endpoint ${r.recorded ?? 'unknown'}: DO NOT USE AS CURRENT.`);
    } else if (r.status === 'UNRESOLVED') {
      out.push(`- CodeAPI window ${id}: current endpoint UNRESOLVED (no running CodeAPI instance reports this id). Historical endpoint ${r.recorded ?? 'unknown'}: DO NOT USE AS CURRENT; find the window with GET /session first.`);
    } else {
      out.push(`- terminal ${r.term ?? '(id not recorded)'}, recorded at ${r.recorded ?? 'unknown'}: this session recorded no CodeAPI window identity for it, so that port may now belong to another window. Check GET /session on it before use.`);
    }
  }
  out.push(
    res.windows.length
      ? `CodeAPI instances answering now: ${res.windows.map((w) => `127.0.0.1:${w.port} ${w.workspace ?? '?'} (window ${w.windowId ?? 'not reported'})`).join('; ')}.`
      : `No CodeAPI instance answered on 127.0.0.1 ports ${portRange(ports)} at injection.`
  );
  return out.join('\n');
}

// What the lifecycle journal keeps of a resolution (no terminal output, no buffers).
export const resolutionSummary = (res) =>
  res.results.map((r) => ({
    term: r.term,
    codeapi_window_id: r.windowId,
    status: r.status,
    current: r.current ?? null,
    recorded: r.recorded ?? null,
    ...(r.ports ? { ports: r.ports } : {}),
    ...(r.terminal ? { terminal: r.terminal } : {}),
  }));
