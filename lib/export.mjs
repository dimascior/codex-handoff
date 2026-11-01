// Reads a Codex rollout through claude-devtools' export script, so this tool never depends on
// the raw JSONL format (which Codex documents as unstable for hooks).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPORT_SCHEMA = 'codex-export.v1';

function findTsxCli(devtoolsDir) {
  const linked = join(devtoolsDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(linked)) return linked;
  // pnpm keeps the real package under node_modules/.pnpm/tsx@<version>/
  const store = join(devtoolsDir, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    const dir = readdirSync(store).filter((name) => name.startsWith('tsx@')).sort().pop();
    if (dir) {
      const candidate = join(store, dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function exportSession(config, rolloutPath, untilLine) {
  const script = join(config.devtoolsDir, 'scripts', 'codex-export.ts');
  const tsxCli = findTsxCli(config.devtoolsDir);
  if (!existsSync(script) || !tsxCli) {
    throw new Error(`claude-devtools export not found under ${config.devtoolsDir} (scripts/codex-export.ts and tsx)`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'codex-handoff-'));
  const out = join(dir, 'export.json');
  try {
    const args = [tsxCli, script, rolloutPath, '--out', out];
    if (untilLine) args.push('--until-line', String(untilLine));
    try {
      execFileSync(process.execPath, args, {
        cwd: config.devtoolsDir,
        timeout: config.exportTimeoutMs,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const stderr = String(error.stderr ?? '').trim().slice(-500);
      throw new Error(`export failed (${error.signal ?? `exit ${error.status}`})${stderr ? `: ${stderr}` : ''}`);
    }
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    if (doc.schema !== EXPORT_SCHEMA) throw new Error(`unexpected export schema ${doc.schema}`);
    return doc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
