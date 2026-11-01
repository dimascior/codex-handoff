// A path as recorded is evidence and stays as recorded. Comparing two recorded paths uses one
// identity form instead: Windows' extended-length prefixes removed (\\?\C:\x → C:\x,
// \\?\UNC\host\x → \\host\x), separators and . / .. normalized the win32 way, and case folded,
// since Windows paths ignore case. Codex's hook input names a rollout \\?\C:\Users\...; manual
// runs name it C:/Users/...; both have the identity c:\users\....
import { posix, win32 } from 'node:path';

export function pathIdentity(path) {
  if (path == null || path === '') return null;
  let p = String(path);
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(p)) p = `\\\\${p.slice(8)}`;
  else if (/^[\\/]{2}[?.][\\/]/.test(p)) p = p.slice(4);
  const windows = /^[a-z]:([\\/]|$)/i.test(p) || /^[\\/]{2}[^\\/?.]/.test(p);
  return windows ? win32.normalize(p.replace(/\//g, '\\')).toLowerCase() : posix.normalize(p);
}
