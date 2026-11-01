// Whether a session's records show it working within an index's task paths (its declared
// scope). Evidence classes, strongest first:
//   WORKSPACE  the session's recorded cwd is inside a scope path
//   TASK_PATH  a recorded user message names a scope path
//   TASK_NAME  a recorded user message names a scope directory on its own
//   NOT_ALIGNED none of these
const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const nameOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The index declares its scope on its "**Scope checked:**" line, as backticked absolute paths.
export function parseScopePaths(indexText) {
  const line = String(indexText ?? '')
    .split(/\r?\n/)
    .find((l) => /^\*\*Scope checked:\*\*/i.test(l.trim()));
  return line ? [...line.matchAll(/`([A-Za-z]:[\\/][^`]+)`/g)].map((m) => m[1]) : [];
}

export function scopeAlignment({ cwd, userMessages = [] }, scopePaths = []) {
  const scopes = scopePaths.map((path) => ({ path, norm: norm(path), name: nameOf(path) }));
  if (!scopes.length) return { class: 'NOT_ALIGNED', scopes: [], evidence: 'no scope paths declared' };
  if (cwd) {
    const c = norm(cwd);
    const hit = scopes.filter((s) => c === s.norm || c.startsWith(`${s.norm}\\`));
    if (hit.length) return { class: 'WORKSPACE', scopes: hit.map((s) => s.path), evidence: { field: 'cwd', value: cwd } };
  }
  for (const m of userMessages) {
    const t = norm(m.text);
    const hit = scopes.filter((s) => new RegExp(`${escapeRe(s.norm)}(?![a-z0-9_-])`).test(t));
    if (hit.length) return { class: 'TASK_PATH', scopes: hit.map((s) => s.path), evidence: { rollout_line: m.lineNumber } };
  }
  for (const m of userMessages) {
    const hit = scopes.filter((s) => s.name && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(s.name)}([^A-Za-z0-9_-]|$)`, 'i').test(m.text));
    if (hit.length) return { class: 'TASK_NAME', scopes: hit.map((s) => s.path), evidence: { rollout_line: m.lineNumber } };
  }
  return { class: 'NOT_ALIGNED', scopes: [], evidence: null };
}
