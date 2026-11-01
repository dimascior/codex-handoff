// What a hand-off record claims, on whose authority, and from which evidence. The vocabulary
// follows the user's evidence repositories:
// - authority (after HeliosEvidenceCatalog's declared / physical / derived split):
//     DECLARED       intent or narration: the user's task, Codex's own messages
//     OBSERVED       a record of something that happened: a rollout cell result, a ledger entry
//     VERIFIED       observed and confirmed by an independent witness (none is wired in yet)
//     DERIVED        computed by codex-handoff from observed records
//     SEMANTIC       a normalized, reusable form of observed occurrences (a recipe)
//     RUNTIME_STATE  a mutable runtime identity (terminal id, port) to recheck before reuse
// - currency: CURRENT_AT_SNAPSHOT, DURABLE_UNTIL_INTERFACE_CHANGE, REVALIDATE_AFTER_RESUME
// - absent values (HeliosEvidenceCatalog 76ee548): AVAILABLE, EXPECTED_NOT_CAPTURED,
//   NOT_CAPTURED_BY_PRODUCER, UNRESOLVED, UNKNOWN; null is never left to mean all of them
// - physical occurrences come before recipes (HeliosEvidenceCatalog ffbc387: occurrence
//   resolution uses physical provenance only); a recipe only refers to occurrences.
import { contentId } from './canonical.mjs';

// Physical transport of a call (how it reached CodeAPI), kept apart from what it does.
const channelOf = (r) => r.transport ?? (/codeApiTerm\./.test(r.line ?? '') ? 'EXTENSION_EXEC' : 'REST_TERM');
const physicalTransport = (r, kind) => `${channelOf(r)}_${kind.toUpperCase()}`;
const hostPort = (url) => (url ? String(url).replace(/^https?:\/\//, '') : null);
const resultBasis = (r) => (r.wrote === undefined ? 'cell completed without a script error' : `cell completed; reply wrote ${r.wrote}`);
const bindingOf = (r) => ({
  authority: 'DERIVED',
  codeapi_window_id: r.window?.codeapi_window_id ?? null,
  basis: r.window?.basis ?? 'NOT_BOUND',
  observation_line: r.window?.observation_line ?? null,
});

// One entry per cell execution that made a working terminal call: identified by its bytes and
// its position in the session record, not by what it is taken to mean. Each call it made keeps
// its physical form (transport, route endpoint, terminal id) and the CodeAPI window that owned that
// endpoint at the time, bound from the nearest preceding /session observation on the same port.
export function occurrencesOf(h) {
  const byId = new Map();
  for (const [kind, r] of Object.entries(h.terminal?.recipes ?? {})) {
    const physical = {
      session_id: h.sessionId ?? null,
      rollout_line: r.lineNumber,
      cell_id: r.cellId ?? null,
      cell_sha256: r.cellSha256 ?? null,
      recorded_at: r.timestamp ?? null,
    };
    const id = contentId(physical);
    if (!byId.has(id)) {
      byId.set(id, {
        occurrence_id: id,
        ...physical,
        call_line_sha256: [],
        calls: [],
        result: { authority: 'OBSERVED', basis: resultBasis(r), provenance: [{ type: 'ROLLOUT_CELL_RESULT', rollout_line: r.lineNumber, cell_id: r.cellId ?? null }] },
      });
    }
    const o = byId.get(id);
    if (r.lineSha256 && !o.call_line_sha256.includes(r.lineSha256)) o.call_line_sha256.push(r.lineSha256);
    o.calls.push({ kind, terminal_id: r.term ?? null, physical_transport: physicalTransport(r, kind), observed_endpoint: hostPort(r.url), window_binding: bindingOf(r) });
  }
  return [...byId.values()];
}

// Normalized terminal recipes, each derived from the occurrences that show it working. One
// witness (the cell's own result) makes a recipe OBSERVED, not VERIFIED. The recipe is semantic
// (codeapi.terminal.<kind>, whichever transport carried it); its endpoint is capture-time runtime
// state, resolved again from the window identity when the hand-off is injected.
export function recipesOf(h) {
  return Object.entries(h.terminal?.recipes ?? {}).map(([kind, r]) => ({
    recipe_id: `codeapi.terminal.${kind}`,
    physical_transport: physicalTransport(r, kind),
    authority: 'SEMANTIC',
    status: 'OBSERVED',
    currency: 'DURABLE_UNTIL_INTERFACE_CHANGE',
    line: r.line,
    derived_from: [
      contentId({ session_id: h.sessionId ?? null, rollout_line: r.lineNumber, cell_id: r.cellId ?? null, cell_sha256: r.cellSha256 ?? null, recorded_at: r.timestamp ?? null }),
    ],
    runtime: {
      authority: 'RUNTIME_STATE',
      currency: 'REVALIDATE_ON_INJECT',
      terminal_id: r.term ?? null,
      codeapi_window_id: r.window?.codeapi_window_id ?? null,
      binding_basis: r.window?.basis ?? 'NOT_BOUND',
      capture_endpoint: r.url ?? null,
      terminal_pid: 'UNRESOLVED',
      pid_resolution: 'READ_FROM_CODEAPI_AT_INJECTION',
    },
  }));
}

// The physical evidence the window bindings rest on: each CodeAPI response that reported a
// codeapiWindowId, with the port it answered on and its rollout line.
export function codeapiWindowsOf(h) {
  return (h.codeapi?.observations ?? []).map((o) => ({
    port: o.port,
    codeapi_window_id: o.windowId,
    rollout_line: o.line,
    recorded_at: o.timestamp ?? null,
    basis: o.basis,
    authority: 'OBSERVED',
    provenance: [{ type: 'ROLLOUT_CELL_OUTPUT', rollout_line: o.line }],
  }));
}

// The code-mode store as an address space: each key with how to restore it and what the session
// record shows about whether it survived a compaction. A working load after a compaction shows a
// cell that used the key ran; the value itself is not visible to the hooks.
export function runtimeKeysOf(h, cells = {}) {
  const compactions = h.compactionLines ?? [];
  return (h.store ?? []).map((k) => {
    const storeLine = k.lastStoreLine ?? null;
    const loads = [...(k.workingLoadLines ?? [])].sort((a, b) => a - b);
    const lastLoad = loads.at(-1);
    const crossed = storeLine && lastLoad ? compactions.filter((c) => c > storeLine && c < lastLoad) : [];
    const after = storeLine ? compactions.filter((c) => c > storeLine) : [];
    const afterCompaction = !storeLine
      ? { status: 'UNKNOWN', reason: 'no completed cell stored the key' }
      : crossed.length
        ? { status: 'OBSERVED', basis: 'a cell that loaded the key completed after a compaction', compactions_crossed: crossed.length, last_compaction_line: Math.max(...crossed), load_line: lastLoad }
        : after.length
          ? { status: 'UNRESOLVED', reason: 'compacted since the store, but no completed load after it is recorded' }
          : { status: 'UNKNOWN', reason: 'no compaction since the store' };
    const cell = cells.store?.[k.key] ?? null;
    return {
      key: k.key,
      authority: 'OBSERVED',
      status: storeLine ? 'OBSERVED' : 'PARTIAL',
      stored_at_line: storeLine,
      working_load_lines: loads,
      value_sha256: { availability: 'NOT_CAPTURED_BY_PRODUCER', reason: 'store() values live in the code-mode runtime only' },
      restore: {
        usage: k.usage?.[0] ?? null,
        storing_cell: cell ? { file: cell.file, sha256: cell.sha256 } : { availability: storeLine ? 'EXPECTED_NOT_CAPTURED' : 'UNKNOWN' },
        rerun_safe: storeLine ? !k.storeCellRunsTools : false,
      },
      persistence: { after_compaction: afterCompaction, after_resume: { status: 'UNKNOWN', reason: 'resume boundaries are not in the export (gap G2)' }, after_restart: { status: 'UNKNOWN', reason: 'restart boundaries are not in the export (gap G2)' } },
    };
  });
}

// What the hooks cannot establish, recorded instead of guessed.
export function openGaps(h) {
  const gaps = [
    { id: 'G1', owner: 'Codex code-mode runtime', fact: 'store() values and their hashes', status: 'INTERFACE_GAP', reason: 'values are held in the runtime only; the hooks record the storing cell, not the value' },
    {
      id: 'G2',
      owner: 'codex-handoff (devtools export)',
      fact: 'resume and restart boundaries',
      status: 'INTERFACE_GAP',
      reason:
        (h.thread?.segments?.length ?? 0) > 1
          ? 'a resume that continued the thread in a new rollout file shows as a segment boundary (source.segments); a resume inside one file is not marked by the export, so persistence across resume or restart stays UNKNOWN'
          : 'the export does not expose session_meta boundaries, so persistence across resume or restart stays UNKNOWN',
    },
    {
      id: 'G3',
      owner: 'codex-handoff',
      fact: 'terminal PID',
      status: 'UNRESOLVED',
      reason: "not taken from the session record; the live PID is read from CodeAPI /term/list when the hand-off is injected and is not stored. Codex's messages about PIDs are DECLARED only",
    },
    { id: 'G4', owner: 'codex-handoff', fact: 'independent witness for terminal recipes', status: 'UNRESOLVED', reason: 'recipes rest on the cell result alone (OBSERVED); no second witness is linked yet' },
  ];
  if (h.helios) {
    gaps.push({ id: 'G5', owner: 'Helios', fact: 'outcomes of code-mode commands', status: 'INTERFACE_GAP', reason: 'evidence_capture records no output (output_preview null, success true) for Codex code-mode commands' });
  }
  return gaps;
}

export function classifyHandoff(h) {
  return {
    TERMINAL_RECIPES: Object.keys(h.terminal?.recipes ?? {}).length ? 'OBSERVED' : 'NONE_RECORDED',
    STORE_KEYS: h.store?.length ? 'OBSERVED' : 'NONE_RECORDED',
    SANDBOX_LIMITS: h.sandbox?.length ? 'OBSERVED' : 'NONE_RECORDED',
    HELIOS_CHAIN: !h.helios ? 'NOT_PRESENT' : h.helios.chainPredecessor ? 'OBSERVED' : 'EXPECTED_NOT_CAPTURED',
    HELIOS_CONTRACT: !h.helios ? 'NOT_PRESENT' : (h.helios.contract?.status ?? 'NOT_CAPTURED_BY_PRODUCER'),
    STANDING_REFERENCES: !h.references?.length ? 'NOT_PRESENT' : h.references.every((r) => r.exists) ? 'AVAILABLE' : 'PARTIAL',
    SCOPE_ALIGNMENT: h.alignment?.class ?? 'NOT_ALIGNED',
  };
}

// Every claim with its authority, currency and typed provenance.
export function claimsOf(h) {
  const claims = [];
  for (const m of h.task ?? []) {
    claims.push({ claim: 'user task', authority: 'DECLARED', currency: 'CURRENT_AT_SNAPSHOT', provenance: [{ type: 'USER_MESSAGE', rollout_line: m.lineNumber }] });
  }
  for (const m of h.position?.agentMessages ?? []) {
    claims.push({ claim: "Codex's account of its position", authority: 'DECLARED', currency: 'CURRENT_AT_SNAPSHOT', provenance: [{ type: 'AGENT_MESSAGE', rollout_line: m.lineNumber }] });
  }
  for (const [kind, r] of Object.entries(h.terminal?.recipes ?? {})) {
    claims.push({
      claim: `terminal ${kind} call observed working`,
      authority: 'OBSERVED',
      currency: 'DURABLE_UNTIL_INTERFACE_CHANGE',
      basis: resultBasis(r),
      provenance: [{ type: 'ROLLOUT_CELL_RESULT', rollout_line: r.lineNumber, cell_id: r.cellId ?? null, cell_sha256: r.cellSha256 ?? null }],
    });
  }
  for (const k of h.store ?? []) {
    claims.push({
      claim: `code-mode store key ${k.key}`,
      authority: 'OBSERVED',
      currency: 'CURRENT_AT_SNAPSHOT',
      basis: k.lastStoreLine ? 'stored by a cell that completed' : 'loaded only; no completed cell stored it',
      provenance: [{ type: 'ROLLOUT_CELL', rollout_line: k.lastStoreLine ?? k.lastLoadLine ?? null }],
    });
  }
  for (const s of h.sandbox ?? []) {
    claims.push({ claim: `sandbox lacks ${s.name}`, authority: 'OBSERVED', currency: 'DURABLE_UNTIL_INTERFACE_CHANGE', provenance: [{ type: 'ROLLOUT_CELL_OUTPUT', rollout_line: s.lineNumber }] });
  }
  // the newest observation of each (window, port) pair
  const windows = new Map();
  for (const o of h.codeapi?.observations ?? []) windows.set(`${o.windowId}|${o.port}`, o);
  for (const o of windows.values()) {
    claims.push({
      claim: `CodeAPI window ${o.windowId} answered on 127.0.0.1:${o.port}`,
      authority: 'OBSERVED',
      currency: 'CURRENT_AT_SNAPSHOT',
      basis: o.basis,
      provenance: [{ type: 'ROLLOUT_CELL_OUTPUT', rollout_line: o.line }],
    });
  }
  if (h.helios?.chainPredecessor) {
    claims.push({
      claim: 'Helios chain predecessor',
      authority: 'OBSERVED',
      currency: 'CURRENT_AT_SNAPSHOT',
      provenance: [{ type: 'HELIOS_SESSION_LEDGER', correlation_id: h.helios.chainPredecessor.correlationId, recorded_at: h.helios.chainPredecessor.at }],
    });
  }
  // The gate contract: what Helios's files declare, what codex-handoff derives from them, and a
  // value counted as verified only with an accepted gate as its second witness.
  const c = h.helios?.contract;
  if (c) {
    const file = (type, src) => ({ type, path: src.path, sha256: src.sha256 ?? null, identity: src.identity?.status ?? null, read_at: c.read_at });
    if (c.base_fields?.fields) {
      claims.push({ claim: 'fields every Helios gate needs', authority: 'DECLARED', currency: 'CURRENT_AT_SNAPSHOT', basis: c.base_fields.source, provenance: [file('HELIOS_GATE_SCHEMA', c.schema)] });
    }
    if (c.tier_fields?.tiers) {
      claims.push({ claim: 'fields each risk tier adds', authority: 'DECLARED', currency: 'CURRENT_AT_SNAPSHOT', basis: c.tier_fields.source, provenance: [file('HELIOS_COMMAND_POLICY', c.policy)] });
    }
    if (c.effective?.tiers) {
      claims.push({ claim: 'fields a gate needs at each tier', authority: 'DERIVED', currency: 'CURRENT_AT_SNAPSHOT', basis: c.effective.rule, provenance: [file('HELIOS_GATE_SCHEMA', c.schema), file('HELIOS_COMMAND_POLICY', c.policy)] });
    }
    for (const v of c.fixed_values ?? []) {
      claims.push({
        claim: `gate field ${v.field} is "${v.value}"`,
        authority: v.authority,
        currency: 'CURRENT_AT_SNAPSHOT',
        basis: v.declared_by,
        provenance: [file('HELIOS_GATE_SCHEMA', c.schema), ...(v.witness?.type ? [{ type: v.witness.type, file: v.witness.file, correlation_id: v.witness.correlation_id, carries: v.witness.carries }] : [])],
      });
    }
  }
  const a = h.alignment;
  if (a && a.class !== 'NOT_ALIGNED') {
    claims.push({
      claim: `works within ${a.scopes.join(', ')}`,
      authority: 'DERIVED',
      currency: 'CURRENT_AT_SNAPSHOT',
      basis: a.class,
      provenance: [a.evidence?.rollout_line ? { type: 'USER_MESSAGE', rollout_line: a.evidence.rollout_line } : { type: 'ROLLOUT_TURN_CONTEXT', field: 'cwd', value: a.evidence?.value ?? null }],
    });
  }
  return claims;
}

// A record keeps cell sources as content-addressed files instead of inline text.
export function withoutSources(h, cells) {
  const copy = structuredClone(h);
  if (copy.terminal?.cell) {
    copy.terminal.cell.source_file = cells.terminal?.file ?? null;
    copy.terminal.cell.source_sha256 = cells.terminal?.sha256 ?? null;
    delete copy.terminal.cell.source;
  }
  for (const k of copy.store ?? []) {
    if (!('source' in k)) continue;
    k.source_file = cells.store[k.key]?.file ?? null;
    k.source_sha256 = cells.store[k.key]?.sha256 ?? null;
    delete k.source;
  }
  return copy;
}
