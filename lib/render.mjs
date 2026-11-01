// Renders the hand-off as the plain text a SessionStart hook injects: short, factual, and within
// maxChars so Codex keeps it inline instead of spilling it to a file.
import { runtimeKeysOf } from './evidence.mjs';
import { bounded } from './extract.mjs';
import { lineRef } from './thread.mjs';

const KIND_LABEL = { write: 'write text', write_enter: 'write text + Enter', enter: 'Enter', read: 'read', create: 'create terminal' };

const at = (iso) => (iso ? String(iso).replace(/\.\d+Z$/, 'Z') : 'unknown time');

function taskLines(task, max, ref) {
  return task.map((m) => {
    const parts = m.attachments.map((a) => `pasted "${bounded(a.title, 80)}" → ${a.path}`);
    if (m.request) parts.push(`"${bounded(m.request, max)}"`);
    return `- ${at(m.timestamp)} (${ref(m.lineNumber)}): ${parts.join('; ') || '(empty)'}`;
  });
}

// The gate contract as Helios declares it (lib/helios.mjs): base fields from the schema, the fields
// each tier adds from the policy, the values the schema fixes, and the command Helios answers its
// own contract with. Nothing is filled in when Helios could not be read.
function contractLines(c) {
  const lines = [];
  const pin = (src) => (src?.identity?.status === 'MATCHES_MANIFEST_PIN' ? ', matches the Helios manifest pin' : src?.identity?.status === 'DIFFERS_FROM_MANIFEST_PIN' ? ', DIFFERS from the Helios manifest pin' : '');
  const base = c.base_fields?.fields;
  if (base) {
    lines.push(`- Fields every gate needs (schema required_base_fields; schema sha256 ${c.schema.sha256.slice(0, 12)}…${pin(c.schema)}): ${base.join(', ')}.`);
  } else {
    lines.push(`- Fields every gate needs: not available (${c.base_fields?.reason ?? 'unknown'}; ${c.schema?.path ?? 'schema'}). No list is given from memory: read the schema before writing a gate.`);
  }
  const tiers = c.tier_fields?.tiers;
  if (tiers) {
    const added = Object.entries(tiers).map(([t, f]) => {
      const extra = base ? f.filter((x) => !base.includes(x)) : f;
      return `tier ${t}: ${extra.length ? extra.join(', ') : 'none'}`;
    });
    lines.push(`- ${base ? 'Added by tier' : 'Required by tier'} (policy tier_required_fields${pin(c.policy)}): ${added.join('; ')}.`);
  } else {
    lines.push(`- Fields by tier: not available (${c.tier_fields?.reason ?? 'unknown'}; ${c.policy?.path ?? 'policy'}).`);
  }
  const fixed = (c.fixed_values ?? []).map((v) => `${v.field} "${v.value}"${v.authority === 'VERIFIED' ? ` (also in Helios-accepted gate ${v.witness.correlation_id})` : ''}`);
  const perCommand = (c.boolean_fields ?? []).map((b) => `${b.field} (${b.meaning})`);
  if (fixed.length || perCommand.length) {
    lines.push(`- ${[fixed.length ? `Values the schema fixes: ${fixed.join(', ')}.` : '', perCommand.length ? `Set per command: ${perCommand.join('; ')}.` : ''].filter(Boolean).join(' ')}`);
  }
  if (c.projection?.command) {
    lines.push(`- Helios answers its contract for one tier and shell: ${c.projection.command}${c.projection.consumes_gate === false ? ' (no gate consumed)' : ''}.`);
  }
  return lines;
}

function sections(h, files, max) {
  const out = [];
  const segments = h.thread?.segments ?? [];
  const ref = (n) => lineRef(segments, n);
  const lastLine = h.untilLine ? h.untilLine - 1 : h.records;
  const when =
    h.takenAt === 'session_start'
      ? `rebuilt at session start (${h.source ?? 'unknown source'}) after ${h.compactions} context compaction(s)`
      : h.takenAt === 'manual'
        ? `saved by hand after ${h.compactions} context compaction(s)`
        : `recorded just before context compaction #${h.compactions + 1}`;
  const extent = segments.length > 1 ? `session record across ${segments.length} rollout files, up to ${ref(lastLine)}` : `session record up to line ${lastLine}`;
  out.push(
    `[codex-handoff] Working state of this session, ${when} ` +
      `(${extent}, last entry ${at(h.lastRecordAt)}). ` +
      'Everything below was recorded in this session; verify anything that may have changed since.'
  );

  if (h.references?.length) {
    const refs = ['START HERE: standing references (re-read before acting; they say which source is authoritative for what)'];
    for (const r of h.references) {
      const hash = r.sha256 ? `sha256 ${r.sha256.slice(0, 12)}…` : 'sha256 not computed';
      const state = !r.exists
        ? 'not found at snapshot time'
        : r.hashed === 'outside the generated block'
          ? `${hash} of its text outside the hooks' block at snapshot time`
          : `${hash}, modified ${at(r.modified)} at snapshot time`;
      refs.push(`- ${r.path}${r.note ? `: ${bounded(r.note, 220)}` : ''} (${state})`);
    }
    out.push(refs.join('\n'));
  }

  if (h.task.length) {
    out.push(['TASK (last user messages, oldest first; re-read pasted files for the full request)', ...taskLines(h.task, max.message, ref)].join('\n'));
  }

  const pos = ['WHERE YOU WERE (your last messages, oldest first)'];
  for (const m of h.position.agentMessages) pos.push(`- ${at(m.timestamp)}: ${bounded(m.text, max.message)}`);
  const c = h.position.lastCell;
  if (c && max.lastResult > 0) pos.push(`Last code cell (${ref(c.lineNumber)}, ${c.status}) returned: ${bounded(c.result, max.lastResult) || '(nothing)'}`);
  if (pos.length > 1) out.push(pos.join('\n'));

  const { recipes, cell } = h.terminal;
  const kinds = ['write', 'write_enter', 'enter', 'read', 'create'].filter((k) => recipes[k]);
  if (kinds.length) {
    const term = [
      'TERMINAL (CodeAPI PTY): the newest calls observed working (their cells completed); reuse them instead of rebuilding. Their ports are history: VS Code windows change ports when they reopen, so send each call to the current endpoint of its CodeAPI window (named here; resolved at injection when CodeAPI answers), not to the port written in it.',
    ];
    // One line can serve several kinds (a write and an Enter defined together): show it once.
    const groups = [];
    for (const k of kinds) {
      const r = recipes[k];
      const same = groups.find((g) => g.r.line === r.line && g.r.lineNumber === r.lineNumber);
      if (same) same.kinds.push(k);
      else groups.push({ r, kinds: [k] });
    }
    for (const { r, kinds: ks } of groups) {
      const wrote = r.wrote === undefined ? '' : `, wrote ${r.wrote}`;
      const window = r.window?.codeapi_window_id ? `, CodeAPI window ${r.window.codeapi_window_id.slice(0, 8)}` : r.window ? ', CodeAPI window not identified' : '';
      term.push(`- ${ks.map((k) => KIND_LABEL[k]).join(', ')} (cell at ${ref(r.lineNumber)}, ${at(r.timestamp)}${wrote}${window}): ${bounded(r.line, max.recipe)}`);
    }
    if (cell) {
      const where = files.terminalCell ? `saved as ${files.terminalCell}` : segments.length > 1 ? ref(cell.lineNumber) : `rollout line ${cell.lineNumber}`;
      const helpers = cell.helpers.length ? ` Helpers it defines: ${cell.helpers.join(', ')}.` : '';
      term.push(`Whole cell that last wrote to the terminal (${ref(cell.lineNumber)}): ${where}.${helpers} Change only the data you send.`);
    }
    out.push(term.join('\n'));
  }

  // Helios and the sandbox limits come before the store section: if the text must be cut, the cut
  // falls on the store's detail, never on the gate rules or the chain.
  const hel = h.helios;
  if (hel) {
    const contract = hel.contract;
    const g = [contract ? 'HELIOS GATE (contract and chain read live from Helios, which owns them)' : 'HELIOS GATE (read live from the Helios policy and ledger)'];
    const version = hel.gateSchemaVersion && !contract ? ` (schema ${hel.gateSchemaVersion})` : '';
    const split = hel.separators?.length ? `split on ${hel.separators.join(' ')}` : "split as the schema's segments section says";
    g.push(`- Every exec_command needs a gate JSON in ${hel.pendingDir}\\<name>.gate.json${version} whose command, command_sha256 (UTF-8 SHA-256), working_directory, shell, risk_tier and segments (${split}) match the call.`);
    if (contract) {
      g.push(...contractLines(contract));
    } else if (hel.tierRequiredFields) {
      const tiers = Object.entries(hel.tierRequiredFields).map(([t, f]) => `tier ${t}: ${f.join(', ')}`);
      g.push(`- Required fields: ${tiers.join('; ')}.`);
    }
    if (hel.exitCaptureSuffixes) {
      const sfx = Object.entries(hel.exitCaptureSuffixes).map(([sh, list]) => `${sh} ${list[0]}`);
      const na = hel.notApplicableReasons ? ` or "not_applicable" with exit_capture_reason (${hel.notApplicableReasons.join(', ')})` : '';
      g.push(`- exit_capture: "suffix" (${sfx.join('; ')})${na}.`);
    }
    if (hel.chainPredecessor) {
      g.push(
        `- Chain: set previous_correlation_id to ${hel.chainPredecessor.correlationId} (last command Helios executed for this session, ${at(hel.chainPredecessor.at)}). ` +
          'Use this value, not a copy kept in the store.'
      );
    }
    g.push('- Unknown hash: write the gate with "command_sha256": "", run once, and copy expected=\'<sha>\' from the GATE REJECTED message.');
    out.push(g.join('\n'));
  }

  if (h.sandbox.length) {
    out.push(`SANDBOX LIMITS (code mode): not available here: ${h.sandbox.map((x) => x.name).join(', ')}. Use pure-JS helpers instead.`);
  }

  if (h.store.length) {
    const dir = max.storeFiles && files.storeDir ? `; the cells that stored them are saved in ${files.storeDir}` : '';
    const st = [`CODE-MODE STORE (in-memory store()/load(); values live in the runtime only${dir})`];
    const persistence = new Map(runtimeKeysOf(h).map((k) => [k.key, k.persistence.after_compaction]));
    for (const k of h.store.slice(0, max.storeKeys)) {
      const stored = !k.stores
        ? 'not stored by any recorded cell'
        : k.lastStoreLine
          ? `stored ${k.stores}x (last working store at ${ref(k.lastStoreLine)})`
          : `stored ${k.stores}x, never by a cell that completed`;
      st.push(`- ${k.key}: ${stored}, loaded ${k.loads}x`);
      // A bare `x = load("k")` says little on its own; show the earlier usage next to it.
      const bare = /^(?:const|let|var)\s+[\w$]+\s*=\s*load\(\s*["'`][^"'`]+["'`]\s*\)\s*;?$/;
      const usage = k.usage.length > 1 && bare.test(k.usage[0]) ? k.usage : k.usage.slice(0, 1);
      for (const u of usage) st.push(`    working usage: ${bounded(u, max.usage)}`);
      const kept = persistence.get(k.key);
      if (kept?.status === 'OBSERVED') {
        st.push(`    a cell using it completed after ${kept.compactions_crossed} compaction(s) (${ref(kept.load_line)}); after a restart: unknown`);
      }
      const file = max.storeFiles ? files.store?.[k.key]?.split(/[\\/]/).pop() : null;
      if (file && k.storeCellRunsTools) {
        st.push(`    if load() returns undefined, rebuild it from the store() call in ${file} (that cell also runs tools; do not re-run it whole)`);
      } else if (file) {
        st.push(`    if load() returns undefined, re-run ${file}`);
      }
    }
    if (h.store.length > max.storeKeys) st.push(`- … ${h.store.length - max.storeKeys} more key(s), listed in the full hand-off`);
    out.push(st.join('\n'));
  }

  // Only point at "the working call above" when the text shows one.
  const compareWith = [kinds.length ? 'the working call above' : null, hel ? `the gates of earlier successful calls in ${hel.evidenceDir}` : null].filter(Boolean);
  if (compareWith.length) out.push(`IF A CALL FAILS: compare it with ${compareWith.join(' and with ')} before trying a new approach.`);
  return out.join('\n\n');
}

export function renderHandoff(h, { maxChars = 7000, files = {} } = {}) {
  // Shorten free text and the store's detail first, then drop the last-result excerpt, before
  // cutting the text itself (the cut falls on the store section, which comes last).
  const budgets = [
    { message: 450, recipe: 450, lastResult: 400, storeKeys: 8, usage: 220, storeFiles: true },
    { message: 280, recipe: 400, lastResult: 250, storeKeys: 6, usage: 160, storeFiles: true },
    { message: 160, recipe: 320, lastResult: 0, storeKeys: 4, usage: 120, storeFiles: false },
  ];
  let text = '';
  for (const max of budgets) {
    text = sections(h, files, max);
    if (text.length <= maxChars) return text;
  }
  const note = files.handoffJson ? `\n… (cut; full hand-off: ${files.handoffJson})` : '\n… (cut)';
  return text.slice(0, maxChars - note.length) + note;
}
