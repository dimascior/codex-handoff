// Standing references the hand-off always points to (config.json "references"): documents Codex
// should re-read after a compaction, such as an operational index. Read-only. Each is identified
// by the SHA-256 of its LF-normalized text; a document the hooks write into (one with
// codex-handoff markers) is identified by its text outside the generated block, so its hash
// changes only when a person edits it.
import { existsSync, readFileSync, statSync } from 'node:fs';

import { lf, sha256 } from './files.mjs';

const MAX_HASHED_BYTES = 16 * 1024 * 1024;
const BLOCK = /(<!-- codex-handoff:begin\b[^>]*-->)[\s\S]*?(<!-- codex-handoff:end -->)/;

export function readReferences(config) {
  return (config.references ?? []).map(({ path, note }) => {
    if (!path || !existsSync(path)) return { path, note: note ?? null, exists: false };
    const stat = statSync(path);
    if (stat.size > MAX_HASHED_BYTES) return { path, note: note ?? null, exists: true, sha256: null, modified: stat.mtime.toISOString() };
    const text = lf(readFileSync(path, 'utf8'));
    const outside = text.replace(BLOCK, '$1$2');
    const scoped = outside !== text;
    return {
      path,
      note: note ?? null,
      exists: true,
      sha256: sha256(outside),
      hashed: scoped ? 'outside the generated block' : 'whole file',
      modified: scoped ? null : stat.mtime.toISOString(),
    };
  });
}
