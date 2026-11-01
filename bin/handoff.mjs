#!/usr/bin/env node
// codex-handoff: gives Codex its working state back after context compaction or resume.
//
//   snapshot  PreCompact hook. Reads the hook input (session_id, transcript_path, trigger) from
//             stdin, builds the hand-off from the session record and saves it under the state
//             directory. Prints nothing and always exits 0, so it can never block a compaction.
//   inject    SessionStart hook (matcher compact|resume). Prints the hand-off as
//             hookSpecificOutput.additionalContext JSON, which Codex adds as developer context
//             before the next model request (also mid-turn, after an automatic compaction): after a
//             compaction, the snapshot taken just before it, provided handoff.txt still has the hash
//             its accepted record states; on resume, when no recent snapshot exists, or when the
//             saved text fails that check (journaled as NOT_INJECTED), one rebuilt from the session
//             record. Ahead of it goes a block resolved at that moment from the live CodeAPI
//             instances: each recorded terminal's current endpoint, found by its CodeAPI window
//             identity, never by the recorded port (lib/codeapi.mjs). --text prints plain text.
//             (PreCompact and PostCompact cannot add context: Codex ignores their plain stdout and
//             their JSON only takes continue, stopReason, systemMessage and suppressOutput.)
//   show      Dry run: prints the hand-off for --transcript [--until-line N] [--session-id ID]
//             [--json] [--live: with the live CodeAPI block]. Writes nothing.
//   resolve   Prints the live CodeAPI block for a session's accepted record (--session-id ID
//             [--record handoff-NNNN.json]). Writes nothing.
//   index     Rewrites the generated block of the configured index document (config.json "index")
//             from the saved hand-offs; snapshot and inject do the same after saving.
//   reconcile Forward repair of one session (--session-id ID [--transcript PATH]): records accepted
//             although they did not read what the record before them read (a partial view of the
//             thread) get ACCEPTANCE_CORRECTED events; then a snapshot is taken from the whole
//             thread and the index is brought up to date, with a CORRECTION entry for each change
//             log entry that rested on a corrected record. Nothing recorded earlier is edited.
//
// Every snapshot reads the whole Codex thread: all its rollout files (a resume can continue a
// thread in a new file), merged in order (lib/thread.mjs). A snapshot becomes the accepted hand-off
// only if it keeps what the accepted one carries (lib/continuity.mjs); otherwise it is kept as
// evidence (RETAINED) and the accepted hand-off stays in force.
//
// Manual runs pass --transcript, --session-id, --until-line, --source and --state <dir> instead of
// hook input.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseScopePaths } from '../lib/alignment.mjs';
import { renderLiveBlock, resolutionSummary, resolveRuntime } from '../lib/codeapi.mjs';
import { loadConfig } from '../lib/config.mjs';
import { continuityVerdict } from '../lib/continuity.mjs';
import { claimsOf, classifyHandoff, codeapiWindowsOf, occurrencesOf, openGaps, recipesOf, runtimeKeysOf, withoutSources } from '../lib/evidence.mjs';
import { bounded, buildHandoff } from '../lib/extract.mjs';
import { lf, sha256, writeAtomic } from '../lib/files.mjs';
import { readHelios } from '../lib/helios.mjs';
import { syncIndex, verifyAll } from '../lib/indexblock.mjs';
import { pathIdentity } from '../lib/paths.mjs';
import { producerIdentity } from '../lib/producer.mjs';
import { acceptedHandoff, appendLifecycle, appendRecord, correctAcceptances, effectiveAccepted, readLatest, saveCell } from '../lib/records.mjs';
import { readReferences } from '../lib/references.mjs';
import { renderHandoff } from '../lib/render.mjs';
import { newestRollout, threadView } from '../lib/thread.mjs';

const USAGE = `Usage:
  handoff.mjs snapshot   (PreCompact hook; hook JSON on stdin)
  handoff.mjs inject     (SessionStart hook; hook JSON on stdin)
  handoff.mjs show --transcript <rollout.jsonl> [--until-line N] [--session-id ID] [--json] [--live]
  handoff.mjs resolve --session-id ID [--record handoff-NNNN.json]   (live CodeAPI routing, read-only)
  handoff.mjs index      (bring the index document's generated block up to date now)
  handoff.mjs verify     (re-derive record chains, continuity verdicts, the change log chain and statements, the index block)
  handoff.mjs reconcile --session-id ID [--transcript <rollout.jsonl>]   (forward repair after a partial-view record)
Manual options: --transcript, --session-id, --until-line, --source, --state <dir>, --text (inject: plain text)
`;
// A snapshot older than this is not trusted to be the one taken for the current compaction.
const SNAPSHOT_FRESH_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--transcript') opts.transcript = value();
    else if (arg === '--session-id') opts.sessionId = value();
    else if (arg === '--until-line') opts.untilLine = Number(value());
    else if (arg === '--source') opts.source = value();
    else if (arg === '--state') opts.state = value();
    else if (arg === '--json') opts.json = true;
    else if (arg === '--text') opts.text = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--record') opts.record = value();
    else throw new Error(`unknown option ${arg}`);
  }
  if (opts.untilLine !== undefined && (!Number.isInteger(opts.untilLine) || opts.untilLine < 2)) {
    throw new Error('--until-line needs a line number of 2 or more');
  }
  return opts;
}

// Hooks get one JSON object on stdin; manual runs pass options instead.
function hookInput(opts) {
  if (opts.transcript || opts.sessionId || process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 128) || 'unknown';

const sessionDir = (config, sessionId) => join(config.stateDir, safeName(sessionId ?? 'unknown'));

function plannedFiles(dir, handoff) {
  return {
    handoffJson: join(dir, 'handoff.json'),
    storeDir: dir,
    terminalCell: handoff.terminal.cell ? join(dir, 'terminal-cell.js') : null,
    store: Object.fromEntries(handoff.store.filter((k) => k.source).map((k) => [k.key, join(dir, `store-${safeName(k.key)}.js`)])),
  };
}

function logError(config, where, error) {
  try {
    mkdirSync(config.stateDir, { recursive: true });
    appendFileSync(join(config.stateDir, 'errors.log'), `${new Date().toISOString()} ${where}: ${error?.stack ?? error}\n`);
  } catch {
    // nowhere left to report
  }
}

// The index's task paths: from config, else the ones the index declares on its "Scope checked" line.
function scopeFor(config) {
  if (config.index?.scopePaths?.length) return { paths: config.index.scopePaths, source: 'config.json index.scopePaths' };
  if (config.index?.path && existsSync(config.index.path)) {
    const paths = parseScopePaths(readFileSync(config.index.path, 'utf8'));
    if (paths.length) return { paths, source: `${basename(config.index.path)}, "Scope checked" line` };
  }
  return { paths: [], source: 'none declared' };
}

const sessionsRoots = (config) => [join(config.codexHome, 'sessions')];

// The hand-off from the whole thread the transcript belongs to (lib/thread.mjs).
function build(config, { transcript, untilLine, sessionId, takenAt, source }) {
  if (!transcript) throw new Error('no transcript path (hook input transcript_path or --transcript)');
  const view = threadView(config, { transcript, threadId: sessionId || null, untilLine, roots: sessionsRoots(config) });
  const id = sessionId || view.threadId || view.doc.session.metadata?.threadId || null;
  return buildHandoff(view.doc, { sessionId: id, helios: readHelios(config, id), references: readReferences(config), scope: scopeFor(config), takenAt, source, thread: view });
}

// Brings the index document's generated block up to date from the records (config.json "index"),
// logging every change first. Never fails the hook.
function refreshIndex(config) {
  if (!config.index?.path) return { updated: false, reason: 'no index configured' };
  try {
    const result = syncIndex({
      indexPath: config.index.path,
      changeLogPath: config.index.changeLog,
      stateDir: config.stateDir,
      maxSessions: config.index.maxSessions,
      lockPath: join(config.stateDir, 'index.lock'),
    });
    if (!result.updated && !['unchanged'].includes(result.reason) && !result.entries) logError(config, 'index', result.reason);
    return result;
  } catch (error) {
    logError(config, 'index', error);
    return { updated: false, reason: error.message };
  }
}

// Writes the session's hand-off as an immutable, hash-chained record (the evidence), plus the
// current-state files the hooks read (handoff.txt, handoff.json, the cell files the text names).
function save(config, handoff, meta) {
  const dir = sessionDir(config, handoff.sessionId);
  mkdirSync(dir, { recursive: true });
  const files = plannedFiles(dir, handoff);
  // content-addressed copies the record cites (its acceptance checks them); the named current-state
  // copies (terminal-cell.js, store-<key>.js) are written only once the record is accepted, since the
  // accepted hand-off's text points at them
  const cells = {
    terminal: handoff.terminal.cell ? saveCell(dir, handoff.terminal.cell.source) : null,
    store: Object.fromEntries(handoff.store.filter((k) => k.source).map((k) => [k.key, saveCell(dir, k.source)])),
  };
  Object.assign(handoff, { savedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), event: meta.event, trigger: meta.trigger ?? null });
  handoff.references = readReferences(config);
  const text = renderHandoff(handoff, { maxChars: config.maxInjectChars, files });
  // One snapshot generation: everything below comes from the same exports, ledger read and
  // reference hashes, taken at one thread cursor.
  const body = {
    session_id: handoff.sessionId,
    recorded_at: handoff.savedAt,
    event: meta.event,
    trigger: meta.trigger ?? null,
    turn_id: meta.turnId ?? null,
    snapshot: {
      captured_at: handoff.savedAt,
      rollout_cursor: handoff.records,
      until_line: handoff.untilLine,
      last_record_at: handoff.lastRecordAt,
      compactions_before: handoff.compactions,
    },
    source: {
      // the rollout file the hook named, as recorded (evidence), and the identity it is compared by
      // (lib/paths.mjs)
      rollout: handoff.rollout,
      rollout_identity: pathIdentity(handoff.rollout),
      // thread lines read: the sum over the thread's rollout files (one file: its records)
      records_read: handoff.records,
      until_line: handoff.untilLine,
      last_record_at: handoff.lastRecordAt,
      cwd: handoff.cwd,
      export_schema: 'codex-export.v1',
      // every rollout file of the thread that was read, in order; a cited rollout_line is a thread
      // line: line_offset of its file + its line in that file
      thread_id: handoff.thread?.id ?? handoff.sessionId,
      segments: handoff.thread?.segments ?? [],
      excluded: handoff.thread?.excluded ?? [],
    },
    producer: producerIdentity(),
    scope: handoff.scope,
    alignment: handoff.alignment,
    classification: classifyHandoff(handoff),
    claims: claimsOf(handoff),
    codeapi_windows: codeapiWindowsOf(handoff),
    occurrences: occurrencesOf(handoff),
    recipes: recipesOf(handoff),
    runtime_keys: runtimeKeysOf(handoff, cells),
    open_gaps: openGaps(handoff),
    artifacts: [
      ...(cells.terminal ? [{ role: 'terminal_cell', ...cells.terminal }] : []),
      ...Object.entries(cells.store).map(([key, c]) => ({ role: 'store_cell', key, ...c })),
    ],
    rendered: { file: 'handoff.txt', sha256: sha256(lf(text)), chars: text.length },
    handoff: withoutSources(handoff, cells),
  };
  // Whether this snapshot keeps what the accepted hand-off carries (lib/continuity.mjs). The verdict
  // is part of the record, so verify can re-derive it from the two records.
  const prior = effectiveAccepted(dir);
  body.continuity = continuityVerdict(prior?.record ?? null, body, prior ? { name: prior.name, sha256: prior.sha256 } : null);
  const record = appendRecord(dir, body);
  const entry = {
    at: handoff.savedAt,
    ...meta,
    record: record.name,
    record_sha256: record.sha256,
    accepted: record.accepted,
    ...(record.retained ? { retained: true } : {}),
    records: handoff.records,
    rollout_files: handoff.thread?.segments?.length ?? 1,
    compactions: handoff.compactions,
    chars: text.length,
  };
  appendFileSync(join(dir, 'snapshots.jsonl'), `${JSON.stringify(entry)}\n`);
  if (!record.accepted) {
    // the pointer and the current-state files stay on the last accepted hand-off
    logError(config, 'snapshot', `record ${record.name} ${record.retained ? 'retained' : 'rejected'}: ${record.reason}`);
    return { text: null, record };
  }
  if (files.terminalCell) writeAtomic(files.terminalCell, handoff.terminal.cell.source);
  for (const k of handoff.store) if (files.store[k.key]) writeAtomic(files.store[k.key], k.source);
  writeAtomic(files.handoffJson, JSON.stringify({ ...handoff, record: record.name, record_sha256: record.sha256 }, null, 2));
  writeAtomic(join(dir, 'handoff.txt'), text);
  refreshIndex(config);
  return { text, record };
}

function snapshot(config, opts) {
  const input = hookInput(opts);
  try {
    // A run with --transcript is a manual snapshot, not one Codex took before a compaction.
    const manual = Boolean(opts.transcript);
    const handoff = build(config, {
      transcript: opts.transcript ?? input.transcript_path,
      untilLine: opts.untilLine,
      sessionId: opts.sessionId ?? input.session_id,
      takenAt: manual ? 'manual' : 'pre_compact',
    });
    save(config, handoff, { event: manual ? 'manual' : 'PreCompact', trigger: input.trigger ?? null, turnId: input.turn_id ?? null });
  } catch (error) {
    logError(config, 'snapshot', error);
  }
}

// The documented SessionStart shape; plain stdout would work too, but JSON leaves no doubt about
// how Codex reads it.
function emitContext(text, opts) {
  if (opts.text) process.stdout.write(`${text}\n`);
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
}

// Runtime routing resolved now from the CodeAPI window identities a record keeps
// (lib/codeapi.mjs): a projection for this injection, never written back into the record. A check
// that fails says so; it never presents a recorded port as current.
async function liveRuntime(config, endpoints) {
  if (!config.codeapi?.enabled || !endpoints?.length) return null;
  try {
    const res = await resolveRuntime(endpoints, { ports: config.codeapi.ports, timeoutMs: config.codeapi.timeoutMs });
    return { block: renderLiveBlock(res, { ports: config.codeapi.ports }), summary: resolutionSummary(res) };
  } catch (error) {
    return {
      block: `[codex-handoff] CodeAPI check failed at injection (${error.message}). Ports in the recorded calls below are history: confirm the window with GET /session before using a terminal.`,
      summary: [{ status: 'CHECK_FAILED', error: error.message }],
    };
  }
}

const withLive = (live, text) => (live ? `${live.block}\n\n${text}` : text);

// The journal keeps the record's rendered hash and the hash of exactly what was injected (the live
// block plus that text), so the rollout's copy can be checked against both.
function injectedEvent(name, text, injected, live, source) {
  return { event: 'INJECTED', record: name, rendered_sha256: sha256(lf(text)), injected_sha256: sha256(lf(injected)), ...(live ? { runtime: live.summary } : {}), source };
}

async function inject(config, opts) {
  const input = hookInput(opts);
  const source = opts.source ?? input.source ?? null;
  const sessionId = opts.sessionId ?? input.session_id ?? null;
  try {
    const dir = sessionId ? sessionDir(config, sessionId) : null;
    // After a compaction: the snapshot taken just before it, if it is the accepted record's own
    // text (its hash as the record states it) and that record is recent. Anything else is rebuilt.
    if (source === 'compact' && dir && existsSync(dir)) {
      const accepted = acceptedHandoff(dir);
      const capturedAt = Date.parse(accepted.record?.snapshot?.captured_at ?? accepted.record?.recorded_at ?? '');
      if (accepted.text && Date.now() - capturedAt < SNAPSHOT_FRESH_MS) {
        const live = await liveRuntime(config, accepted.record?.handoff?.endpoints);
        const injected = withLive(live, accepted.text);
        emitContext(injected, opts);
        appendLifecycle(dir, injectedEvent(accepted.name, accepted.text, injected, live, source));
        return;
      }
      if (accepted.reason && accepted.reason !== 'NO_ACCEPTED_RECORD') appendLifecycle(dir, { event: 'NOT_INJECTED', record: accepted.name ?? null, reason: accepted.reason, source });
    }
    const handoff = build(config, {
      transcript: opts.transcript ?? input.transcript_path,
      untilLine: opts.untilLine,
      sessionId,
      takenAt: 'session_start',
      source,
    });
    const { text, record } = save(config, handoff, { event: 'SessionStart', source });
    const stateDir = sessionDir(config, handoff.sessionId);
    let chosen = text ? { name: record.name, text, injectedText: text, endpoints: handoff.endpoints } : null;
    if (!chosen && record.retained) {
      // The snapshot keeps less than the accepted hand-off (lib/continuity.mjs): the accepted one
      // stays in force, and Codex is told why it gets that one.
      const accepted = acceptedHandoff(stateDir);
      if (accepted.text) {
        const note = `[codex-handoff] The snapshot taken at this session start (${record.name}) was kept as evidence but not used: ${bounded(record.reason, 300)}. Below is the accepted hand-off (${accepted.name}).`;
        chosen = { name: accepted.name, text: accepted.text, injectedText: `${note}\n\n${accepted.text}`, endpoints: accepted.record?.handoff?.endpoints };
      }
    }
    if (!chosen) throw new Error(`hand-off record ${record.name} was not accepted: ${record.reason}`);
    const live = await liveRuntime(config, chosen.endpoints);
    const injected = withLive(live, chosen.injectedText);
    emitContext(injected, opts);
    appendLifecycle(stateDir, injectedEvent(chosen.name, chosen.text, injected, live, source));
  } catch (error) {
    logError(config, 'inject', error);
    emitContext(
      `[codex-handoff] No hand-off could be built for this session (details: ${join(config.stateDir, 'errors.log')}). ` +
        'Before rebuilding a call that worked earlier, look up its last successful use in this session.',
      opts
    );
  }
}

async function show(config, opts) {
  const handoff = build(config, { transcript: opts.transcript, untilLine: opts.untilLine, sessionId: opts.sessionId, takenAt: 'pre_compact' });
  if (opts.json) {
    const brief = (key, value) => (key === 'source' && typeof value === 'string' ? `<${value.length} characters>` : value);
    process.stdout.write(`${JSON.stringify(handoff, brief, 2)}\n`);
    return;
  }
  const files = plannedFiles(sessionDir(config, handoff.sessionId), handoff);
  const text = renderHandoff(handoff, { maxChars: config.maxInjectChars, files });
  const live = opts.live ? await liveRuntime({ ...config, codeapi: { ...config.codeapi, enabled: true } }, handoff.endpoints) : null;
  process.stdout.write(`${withLive(live, text)}\n`);
}

// Forward repair of one session after records that saw only part of its thread became the pointer:
// their acceptance is corrected in the journal (never edited), a snapshot is taken from the whole
// thread, and the index is brought up to date (CORRECTION entries for change-log entries that
// rested on a corrected record). Prints what it did.
function reconcile(config, opts) {
  if (!opts.sessionId) throw new Error('reconcile needs --session-id');
  const dir = sessionDir(config, opts.sessionId);
  if (!existsSync(join(dir, 'records'))) throw new Error(`no hand-off records for session ${opts.sessionId}`);
  const corrections = correctAcceptances(dir);
  for (const e of corrections) process.stdout.write(`ACCEPTANCE_CORRECTED ${e.record} (against ${e.predecessor}): ${e.reason}: ${e.detail}\n`);
  if (!corrections.length) process.stdout.write('no accepted record needs its acceptance corrected\n');
  const transcript = opts.transcript ?? newestRollout(sessionsRoots(config), opts.sessionId);
  if (!transcript) throw new Error(`no rollout file of thread ${opts.sessionId} found under ${sessionsRoots(config).join(', ')}; pass --transcript`);
  const handoff = build(config, { transcript, sessionId: opts.sessionId, takenAt: 'manual' });
  const { record } = save(config, handoff, { event: 'manual' });
  const status = record.accepted ? 'ACCEPTED' : record.retained ? 'RETAINED' : 'REJECTED';
  process.stdout.write(`${record.name}: ${status}${record.reason ? ` (${record.reason})` : ''}; read ${handoff.thread.segments.length} rollout file(s), ${handoff.records} thread lines\n`);
  const index = refreshIndex(config);
  process.stdout.write(`index: ${index.updated ? 'block updated' : `block ${index.reason ?? 'unchanged'}`}${index.entries ? `; ${index.entries} change log entr${index.entries === 1 ? 'y' : 'ies'} appended` : ''}\n`);
  if (!record.accepted) process.exitCode = 1;
}

// The live routing for a session's accepted record, or a named one, as inject would put it ahead
// of the hand-off. Read-only.
async function resolve(config, opts) {
  if (!opts.sessionId) throw new Error('resolve needs --session-id');
  const dir = sessionDir(config, opts.sessionId);
  const name = opts.record ?? readLatest(dir)?.current;
  if (!name) throw new Error(`no accepted record for session ${opts.sessionId}`);
  const record = JSON.parse(readFileSync(join(dir, 'records', basename(name)), 'utf8'));
  const live = await liveRuntime({ ...config, codeapi: { ...config.codeapi, enabled: true } }, record.handoff?.endpoints);
  process.stdout.write(live ? `${basename(name)}:\n${live.block}\n` : `${basename(name)}: no CodeAPI terminal calls recorded; nothing to resolve\n`);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exitCode = 2;
}
if (opts) {
  // --state names a whole state directory, its config.json included: a run against another state
  // never reads (or writes the index configured in) the default one
  const config = loadConfig(opts.state ? { ...process.env, CODEX_HANDOFF_STATE: opts.state } : process.env);
  if (opts.command === 'snapshot') snapshot(config, opts);
  else if (opts.command === 'inject') await inject(config, opts);
  else if (opts.command === 'resolve') {
    try {
      await resolve(config, opts);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  } else if (opts.command === 'index') {
    const result = refreshIndex(config);
    const logged = result.entries ? `${result.entries} change log entr${result.entries === 1 ? 'y' : 'ies'} appended` : '';
    if (result.updated) process.stdout.write(`index block brought up to date${logged ? `, ${logged}` : ''}: ${config.index.path}\n`);
    else if (result.entries) process.stdout.write(`index block unchanged; ${logged}: ${config.index.changeLog}\n`);
    else process.stdout.write(`index not changed: ${result.reason}\n`);
  } else if (opts.command === 'verify') {
    const results = verifyAll({ stateDir: config.stateDir, indexPath: config.index?.path, changeLogPath: config.index?.changeLog });
    for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  ${r.detail}` : ''}\n`);
    const failed = results.filter((r) => !r.ok).length;
    process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
    if (failed) process.exitCode = 1;
  } else if (opts.command === 'reconcile') {
    try {
      reconcile(config, opts);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  } else if (opts.command === 'show') {
    try {
      await show(config, opts);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  }
}
