// Paths and limits. Environment variables override %USERPROFILE%\.codex-handoff\config.json,
// which overrides the defaults below.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();

const DEFAULTS = {
  stateDir: join(HOME, '.codex-handoff'),
  devtoolsDir: null,
  heliosRoot: null,
  exportTimeoutMs: 45000,
  // Hex hashes and paths run about 3 characters per token: 7,000 characters stays under Codex's
  // default 2,500-token additionalContextLimit, above which the text is saved to a file instead.
  maxInjectChars: 7000,
};

export function loadConfig(env = process.env) {
  const stateDir = env.CODEX_HANDOFF_STATE || DEFAULTS.stateDir;
  let file = {};
  const configPath = join(stateDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      file = {};
    }
  }
  return {
    stateDir,
    // Codex's home: its sessions/ tree is searched for every rollout file of a thread (lib/thread.mjs)
    codexHome: env.CODEX_HOME || file.codexHome || join(HOME, '.codex'),
    devtoolsDir: env.CODEX_HANDOFF_DEVTOOLS || file.devtoolsDir || DEFAULTS.devtoolsDir,
    heliosRoot: env.CODEX_HANDOFF_HELIOS_ROOT || file.heliosRoot || DEFAULTS.heliosRoot,
    exportTimeoutMs: Number(file.exportTimeoutMs) || DEFAULTS.exportTimeoutMs,
    maxInjectChars: Number(file.maxInjectChars) || DEFAULTS.maxInjectChars,
    // [{ path, note }]: documents every hand-off points to first (see lib/references.mjs)
    references: Array.isArray(file.references) ? file.references.filter((r) => r && typeof r.path === 'string') : [],
    // Index document whose marked block the hooks keep up to date (lib/indexblock.mjs)
    index: indexConfig(file.index),
    // Live CodeAPI resolution at injection (lib/codeapi.mjs)
    codeapi: codeapiConfig(file.codeapi, env.CODEX_HANDOFF_CODEAPI_PORTS),
  };
}

// Ports as "47337-47400", "47500,47501" or "off".
function parsePorts(spec) {
  const ports = [];
  for (const part of String(spec).split(',')) {
    const [a, b] = part.trim().split('-').map(Number);
    if (!Number.isInteger(a)) continue;
    for (let p = a; p <= (Number.isInteger(b) ? b : a) && ports.length < 1024; p++) if (p > 0 && p < 65536) ports.push(p);
  }
  return ports;
}

// { enabled, ports, timeoutMs }: the CodeAPI port band scanned when a hand-off is injected
// (default 47337-47400, CodeAPI's discovery range). CODEX_HANDOFF_CODEAPI_PORTS overrides it; "off"
// turns the check off.
function codeapiConfig(c = {}, envPorts) {
  const spec = envPorts ?? (Array.isArray(c?.ports) ? c.ports.join(',') : typeof c?.ports === 'string' ? c.ports : '47337-47400');
  return {
    enabled: c?.enabled !== false && String(spec).trim() !== 'off',
    ports: String(spec).trim() === 'off' ? [] : parsePorts(spec),
    timeoutMs: Number(c?.timeoutMs) || 1500,
  };
}

// { path, maxSessions, changeLog, scopePaths }: the change log defaults to change.log.md next to
// the index; scope paths default to the ones the index declares on its "Scope checked" line.
function indexConfig(index) {
  if (!index || typeof index.path !== 'string') return null;
  return {
    path: index.path,
    maxSessions: Number(index.maxSessions) || 5,
    changeLog: typeof index.changeLog === 'string' ? index.changeLog : join(dirname(index.path), 'change.log.md'),
    scopePaths: Array.isArray(index.scopePaths) ? index.scopePaths.filter((p) => typeof p === 'string') : [],
  };
}
