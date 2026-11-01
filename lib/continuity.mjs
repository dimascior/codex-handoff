// Whether a new record may replace the accepted one as the pointer (latest.json).
//
// A record's own checks prove its integrity: its sidecar matches, it names and hashes its
// predecessor, the cells it cites are there. They do not prove that it carries what its
// predecessor carried. Newest is not best (record 0007 of thread 01a0fcec read 8 records of a
// resumed rollout file and replaced a record built from the thread's 3,358 earlier ones). So a
// successor must also:
// 1. cover the predecessor's source: every rollout file the predecessor read is read again, at
//    least as far; otherwise it is a partial view of the thread (PARTIAL_SOURCE_VIEW);
// 2. keep every recoverable primitive of the predecessor: each terminal recipe, CodeAPI window,
//    store key, sandbox limit and the task-path alignment is observed again (PRESERVED), seen in a
//    newer occurrence of the same identity (REFRESHED), or replaced by a newer one of its kind
//    (SUPERSEDED). An absent primitive is never read as "it ceased to exist": it is MISSING.
// Either failure makes the verdict CONTINUITY_REGRESSION: the record is kept as evidence
// (RETAINED) and the pointer stays where it is. Runtime values (ports, PIDs, liveness) are not
// primitives: they are resolved again when a hand-off is injected.
import { pathIdentity } from './paths.mjs';

export const CONTINUITY_RULE = 'codex-handoff continuity rule v1 (successor non-regression)';

// The rollout files a record read: [{ rollout_identity, rollout, records_read }].
export function sourceSegments(record) {
  const s = record?.source ?? {};
  if (Array.isArray(s.segments) && s.segments.length) {
    return s.segments.map((g) => ({ rollout_identity: g.rollout_identity ?? pathIdentity(g.rollout), rollout: g.rollout ?? null, records_read: g.records_read ?? null }));
  }
  const id = s.rollout_identity ?? pathIdentity(s.rollout);
  return id ? [{ rollout_identity: id, rollout: s.rollout ?? null, records_read: s.records_read ?? null }] : [];
}

export function coverage(prev, next) {
  const have = sourceSegments(next);
  const missing = [];
  const shorter = [];
  for (const p of sourceSegments(prev)) {
    const n = have.find((x) => x.rollout_identity === p.rollout_identity);
    if (!n) missing.push(p);
    else if (Number.isInteger(p.records_read) && Number.isInteger(n.records_read) && n.records_read < p.records_read) {
      shorter.push({ ...p, successor_records_read: n.records_read });
    }
  }
  return { covered: !missing.length && !shorter.length, missing, shorter };
}

const sameList = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

// Each primitive class is compared only when both records carry it (older schemas lack some).
export function primitiveContinuity(prev, next) {
  const out = [];
  const add = (kind, id, status, detail) => out.push({ kind, id, status, ...(detail ? { detail } : {}) });

  if (Array.isArray(prev.recipes) && Array.isArray(next.recipes)) {
    for (const r of prev.recipes) {
      const n = next.recipes.find((x) => x.recipe_id === r.recipe_id);
      if (!n) add('terminal_recipe', r.recipe_id, 'MISSING');
      else if (sameList(n.derived_from, r.derived_from)) add('terminal_recipe', r.recipe_id, 'PRESERVED');
      else if (n.runtime?.terminal_id === r.runtime?.terminal_id && n.runtime?.codeapi_window_id === r.runtime?.codeapi_window_id) add('terminal_recipe', r.recipe_id, 'REFRESHED');
      else add('terminal_recipe', r.recipe_id, 'SUPERSEDED', `newer ${r.recipe_id} for ${n.runtime?.terminal_id ?? 'another terminal'}`);
    }
  }
  if (Array.isArray(prev.codeapi_windows) && Array.isArray(next.codeapi_windows)) {
    const seen = new Set(next.codeapi_windows.map((w) => w.codeapi_window_id));
    for (const id of new Set(prev.codeapi_windows.map((w) => w.codeapi_window_id))) add('codeapi_window', id, seen.has(id) ? 'PRESERVED' : 'MISSING');
  }
  if (Array.isArray(prev.runtime_keys) && Array.isArray(next.runtime_keys)) {
    const total = next.handoff?.storeTotal;
    for (const k of prev.runtime_keys) {
      const n = next.runtime_keys.find((x) => x.key === k.key);
      if (n) add('store_key', k.key, n.stored_at_line === k.stored_at_line ? 'PRESERVED' : 'REFRESHED');
      else if (Number.isInteger(total) && total > next.runtime_keys.length) add('store_key', k.key, 'SUPERSEDED', `displaced by ${total - next.runtime_keys.length} newer key(s) beyond the ${next.runtime_keys.length} carried`);
      else add('store_key', k.key, 'MISSING');
    }
  }
  if (Array.isArray(prev.handoff?.sandbox) && Array.isArray(next.handoff?.sandbox)) {
    const names = new Set(next.handoff.sandbox.map((s) => s.name));
    for (const s of prev.handoff.sandbox) add('sandbox_limit', s.name, names.has(s.name) ? 'PRESERVED' : 'MISSING');
  }
  if (prev.alignment && next.alignment && prev.alignment.class !== 'NOT_ALIGNED') {
    add('task_path_alignment', prev.alignment.class, next.alignment.class === 'NOT_ALIGNED' ? 'MISSING' : 'PRESERVED');
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The verdict, with the evidence it rests on. `predecessor` names the record compared against.
export function continuityVerdict(prev, next, predecessor = null) {
  if (!prev) return { rule: CONTINUITY_RULE, predecessor: null, verdict: 'NO_PREDECESSOR' };
  const cov = coverage(prev, next);
  const prims = primitiveContinuity(prev, next);
  const counts = Object.fromEntries(['PRESERVED', 'REFRESHED', 'SUPERSEDED', 'MISSING'].map((s) => [s, prims.filter((p) => p.status === s).length]));
  const missing = prims.filter((p) => p.status === 'MISSING');
  const reason = !cov.covered ? 'PARTIAL_SOURCE_VIEW' : missing.length ? 'PRIMITIVE_LOST' : null;
  const sourceText = cov.covered
    ? `covers the ${plural(sourceSegments(prev).length, 'rollout file')} its predecessor read`
    : [
        ...cov.missing.map((m) => `does not read ${m.rollout ?? m.rollout_identity} (${m.records_read ?? '?'} records in the predecessor)`),
        ...cov.shorter.map((m) => `reads ${m.successor_records_read} of the ${m.records_read} records of ${m.rollout ?? m.rollout_identity} the predecessor read`),
      ].join('; ');
  const primText = `primitives: ${counts.PRESERVED} preserved, ${counts.REFRESHED} refreshed, ${counts.SUPERSEDED} superseded, ${counts.MISSING} missing${missing.length ? ` (${missing.map((m) => `${m.kind} ${m.id}`).join(', ')})` : ''}`;
  return {
    rule: CONTINUITY_RULE,
    predecessor,
    verdict: reason ? 'CONTINUITY_REGRESSION' : 'CONTINUOUS',
    reason,
    detail: `${sourceText}; ${primText}`,
    coverage: { covered: cov.covered, missing: cov.missing, shorter: cov.shorter },
    primitives: { counts, missing },
  };
}
