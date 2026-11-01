// The identity of the code that wrote a record: the SHA-256 of each codex-handoff source file
// (bin/handoff.mjs and lib/*.mjs, LF-normalized) and one hash over that manifest. Two records
// read from the same evidence that classify it differently can then be traced to a change of
// producer instead of being taken for new evidence.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileSha256, sha256 } from './files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function producerIdentity(root = ROOT) {
  const paths = [
    'bin/handoff.mjs',
    ...readdirSync(join(root, 'lib'))
      .filter((name) => name.endsWith('.mjs'))
      .sort()
      .map((name) => `lib/${name}`),
  ];
  const files = paths.map((path) => ({ path, sha256: fileSha256(join(root, path)) }));
  return {
    name: 'codex-handoff',
    code_sha256: sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join('')),
    files,
  };
}
