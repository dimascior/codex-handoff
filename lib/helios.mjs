// Read-only view of the Helios command gate for the hand-off: the chain predecessor Helios will
// check next, and the gate contract, read live so the hand-off carries Helios's own contract
// instead of a copy. Helios owns the contract; this module keeps no list of fields:
// - the fields every gate needs are the schema's sections.fields.required_base_fields
//   (schema/helios-gate.schema.json), the array Helios's validator reads;
// - the fields a tier adds are the live policy's tier_required_fields (policy/command-policy.json);
//   the schema says it deliberately does not duplicate them;
// - what a gate needs at a tier is their union, which this module derives (DERIVED), keeping the
//   two declared lists and their sources apart.
// Each contract file is identified by the SHA-256 of its raw bytes, the form Helios's integrity
// manifest pins, and compared with that pin. A file that cannot be read is reported as such:
// nothing is filled in from memory. Nothing here writes under the Helios root.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where Helios keeps its contract: addresses, not policy.
const SCHEMA_FILE = 'schema/helios-gate.schema.json';
const POLICY_FILE = 'policy/command-policy.json';
const MANIFEST_FILE = 'manifest/helios-envelope.json';

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function findKey(node, key) {
  if (!node || typeof node !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const value of Object.values(node)) {
    const found = findKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The ledger's last posttooluse_evidence_written entry is the executable chain predecessor.
function lastEvidence(ledgerPath) {
  const lines = readFileSync(ledgerPath, 'utf8').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('posttooluse_evidence_written')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.event_type === 'posttooluse_evidence_written' && entry.correlation_id) {
        return { correlationId: entry.correlation_id, at: entry.timestamp_utc ?? null };
      }
    } catch {
      // skip a torn line
    }
  }
  return null;
}

// One contract file as read now: its raw-byte hash and parsed content, or why it is not there.
function readSource(root, rel) {
  const path = join(root, ...rel.split('/'));
  if (!existsSync(path)) return { path, status: 'MISSING' };
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { path, status: 'UNREADABLE', reason: error.message };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    return { path, sha256, status: 'READ', json: JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')) };
  } catch (error) {
    return { path, sha256, status: 'UNPARSEABLE', reason: error.message };
  }
}

// The hash Helios's integrity manifest pins for a file (its key is the file's relative path).
function manifestPin(manifest, rel) {
  let pin = null;
  (function walk(node) {
    if (pin || !node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === rel && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) {
        pin = value;
        return;
      }
      walk(value);
    }
  })(manifest);
  return pin;
}

function identity(source, rel, manifest) {
  if (!source.sha256) return { status: 'NOT_COMPARED', reason: source.status };
  const pin = manifest.status === 'READ' ? manifestPin(manifest.json, rel) : null;
  if (!pin) return { status: 'NO_MANIFEST_PIN', manifest: manifest.path, manifest_status: manifest.status };
  return { status: pin === source.sha256 ? 'MATCHES_MANIFEST_PIN' : 'DIFFERS_FROM_MANIFEST_PIN', pin };
}

const isFieldList = (v) => Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === 'string' && f);

// The consumed gate file of an executed correlation id (evidence/<date>-<id>.gate.json), if kept.
function consumedGate(evidenceDir, correlationId) {
  if (!correlationId || !existsSync(evidenceDir)) return null;
  try {
    const name = readdirSync(evidenceDir).find((n) => n === `${correlationId}.gate.json` || n.endsWith(`-${correlationId}.gate.json`));
    return name ? { file: join(evidenceDir, name), gate: readJson(join(evidenceDir, name)) } : null;
  } catch {
    return null;
  }
}

// The gate contract: base fields (schema), tier fields (policy), their union per tier (derived),
// the values the schema fixes, what its boolean base fields mean, and the command Helios answers
// with its own projection of the contract. Requirements are never turned into values: a value is
// given only where the schema states it, and it counts as VERIFIED only when a gate Helios
// accepted also carries it (a second, independent witness).
export function gateContract(root, { chainPredecessor = null, evidenceDir = join(root, 'evidence') } = {}) {
  const schema = readSource(root, SCHEMA_FILE);
  const policy = readSource(root, POLICY_FILE);
  const manifest = readSource(root, MANIFEST_FILE);
  const s = schema.json;
  const base = s?.sections?.fields?.required_base_fields;
  const tiers = policy.json?.tier_required_fields;
  const baseOk = isFieldList(base);
  const tierEntries = tiers && typeof tiers === 'object' ? Object.entries(tiers).filter(([, f]) => isFieldList(f)) : [];
  const tiersOk = tierEntries.length > 0;
  const meanings = s?.sections?.fields?.types_and_meaning ?? {};

  const contract = {
    status: baseOk && tiersOk ? 'AVAILABLE' : baseOk || tiersOk ? 'PARTIAL' : 'UNAVAILABLE',
    read_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    schema: {
      path: schema.path,
      status: schema.status,
      sha256: schema.sha256 ?? null,
      identity: identity(schema, SCHEMA_FILE, manifest),
      doc_version: s?.schema_doc_version ?? null,
      gate_schema_version: s?.gate_schema_version ?? null,
      ...(schema.reason ? { reason: schema.reason } : {}),
    },
    policy: {
      path: policy.path,
      status: policy.status,
      sha256: policy.sha256 ?? null,
      identity: identity(policy, POLICY_FILE, manifest),
      ...(policy.reason ? { reason: policy.reason } : {}),
    },
    base_fields: baseOk
      ? { authority: 'DECLARED', source: 'schema sections.fields.required_base_fields', fields: [...base] }
      : { availability: 'UNAVAILABLE', reason: schema.status === 'READ' ? 'the schema has no sections.fields.required_base_fields list' : `schema ${schema.status}` },
    tier_fields: tiersOk
      ? { authority: 'DECLARED', source: 'policy tier_required_fields', tiers: Object.fromEntries(tierEntries.map(([t, f]) => [t, [...f]])) }
      : { availability: 'UNAVAILABLE', reason: policy.status === 'READ' ? 'the policy has no tier_required_fields' : `policy ${policy.status}` },
    effective: baseOk && tiersOk
      ? { authority: 'DERIVED', rule: 'base fields ∪ tier fields', tiers: Object.fromEntries(tierEntries.map(([t, f]) => [t, [...new Set([...base, ...f])]])) }
      : { availability: 'UNAVAILABLE', reason: 'needs both the base and the tier fields' },
    fixed_values: [],
    boolean_fields: [],
    projection: null,
  };

  // Values the schema fixes ("string - exactly '<value>'"), with an accepted gate as second witness.
  const witness = consumedGate(evidenceDir, chainPredecessor?.correlationId);
  for (const [field, meaning] of Object.entries(meanings)) {
    const m = typeof meaning === 'string' ? meaning.match(/\bexactly '([^']+)'/) : null;
    if (!m) continue;
    const carried = witness?.gate ? witness.gate[field] : undefined;
    contract.fixed_values.push({
      field,
      value: m[1],
      declared_by: `schema sections.fields.types_and_meaning.${field}`,
      authority: carried === m[1] ? 'VERIFIED' : 'DECLARED',
      witness: witness?.gate
        ? { type: 'HELIOS_CONSUMED_GATE', file: witness.file, correlation_id: chainPredecessor.correlationId, carries: carried === undefined ? null : carried, matches: carried === m[1] }
        : { availability: chainPredecessor ? 'EXPECTED_NOT_CAPTURED' : 'UNKNOWN', reason: chainPredecessor ? 'no consumed gate file for the chain predecessor' : 'no executed command in this session yet' },
    });
  }
  // Boolean base fields: their value depends on the command; only their meaning is carried.
  for (const field of baseOk ? base : []) {
    const meaning = meanings[field];
    if (typeof meaning === 'string' && /^boolean\b/.test(meaning)) contract.boolean_fields.push({ field, meaning, authority: 'DECLARED' });
  }
  // Helios's own projection of the contract for one tier and shell (a virtual command it answers).
  // Whether asking consumes a gate is taken from the schema's own rules text, not assumed.
  const grammar = s?.sections?.virtual?.grammar;
  const rules = s?.sections?.virtual?.rules;
  const projection = Array.isArray(grammar) ? grammar.find((g) => typeof g === 'string' && g.includes('--tier') && g.includes('--shell') && !g.includes('--example')) : null;
  if (projection) {
    contract.projection = {
      command: projection,
      source: 'schema sections.virtual.grammar',
      consumes_gate: typeof rules === 'string' && /\bno gate is consumed\b/i.test(rules) ? false : null,
    };
  }
  return contract;
}

export function readHelios(config, sessionId) {
  const root = config.heliosRoot;
  if (!root || !existsSync(root)) return null;
  const helios = { root, pendingDir: join(root, 'pending'), evidenceDir: join(root, 'evidence'), chainPredecessor: null };
  if (sessionId) {
    const ledger = join(root, 'session', `session-ledger-${sessionId}.jsonl`);
    if (existsSync(ledger)) helios.chainPredecessor = lastEvidence(ledger);
  }
  const policy = readJson(join(root, POLICY_FILE));
  helios.exitCaptureSuffixes = policy?.exit_capture_suffixes ?? null;
  helios.tierRequiredFields = policy?.tier_required_fields ?? null;
  helios.notApplicableReasons = policy?.exit_capture_not_applicable_reasons ?? null;
  const schema = readJson(join(root, SCHEMA_FILE));
  helios.gateSchemaVersion = schema?.gate_schema_version ?? null;
  const separators = findKey(schema, 'separators');
  helios.separators = Array.isArray(separators) ? separators : null;
  helios.contract = gateContract(root, { chainPredecessor: helios.chainPredecessor, evidenceDir: helios.evidenceDir });
  return helios;
}
