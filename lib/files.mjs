// File helpers for evidence artifacts. Identity follows the HeliosEntitlementAuthority hand-off
// convention: the SHA-256 of a file's LF-normalized bytes, with a one-line sidecar
// "<hex>  <file name>" next to the file.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export const lf = (text) => String(text).replace(/\r\n/g, '\n');
export const sha256 = (text) => createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
export const fileSha256 = (path) => sha256(lf(readFileSync(path, 'utf8')));

export function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export const sidecarPath = (path) => `${path}.sha256`;

export function writeSidecar(path) {
  const hex = fileSha256(path);
  writeAtomic(sidecarPath(path), `${hex}  ${basename(path)}\n`);
  return hex;
}

export function checkSidecar(path) {
  let line;
  try {
    line = readFileSync(sidecarPath(path), 'utf8').trim();
  } catch {
    return { ok: false, detail: 'sidecar missing' };
  }
  const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
  if (!m) return { ok: false, detail: 'sidecar malformed' };
  if (m[2] !== basename(path)) return { ok: false, detail: `sidecar names ${m[2]}` };
  let actual;
  try {
    actual = fileSha256(path);
  } catch {
    return { ok: false, detail: 'file missing' };
  }
  return actual === m[1] ? { ok: true, detail: actual } : { ok: false, detail: `sidecar ${m[1].slice(0, 12)}… but file ${actual.slice(0, 12)}…` };
}
