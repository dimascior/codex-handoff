// Why an index row changed, derived from the two records involved instead of assumed. A newer
// record is not by itself new evidence: two records can read the same rollout records and still
// differ because the code that wrote them changed (HeliosEvidenceCatalog 8ecd86d corrects an
// overbroad PASS forward to FAIL; it does not let it stand).
//
//   NEW_EVIDENCE              an input changed: more rollout records, the Helios ledger or policy,
//                             a standing reference, the index's task paths
//   FALSE_VERIFICATION        same inputs, and a changed producer withdrew a VERIFIED classification
//   CORRECTED_CLASSIFICATION  same inputs, and a changed producer classified them differently
//   CORRECTED_PROJECTION      same inputs and classification, and a changed producer projected the
//                             terminal endpoints differently (e.g. grouped by window identity)
//   UNEXPLAINED_CHANGE        same inputs and the same producer, yet the result differs
//   RECAPTURED                same inputs, classification and projection: captured again
//   EARLIER_CURSOR            the newer record read fewer rollout records than the one it replaces
//   PARTIAL_SOURCE_VIEW       the newer record does not read every rollout file the older one read
//                             (a thread can span several files; lib/continuity.mjs)
//   RENDERING_CHANGED         the row changed but cites the same record
//   UNRESOLVED                a record the derivation needs is missing or no longer has its hash
//
// Rule v5 reads a record's source as the list of rollout files it read (record schema v3) and the
// Helios gate contract by the hashes of the files it came from. Two records that each read one
// rollout file, without a contract on both sides, get exactly the code and wording rule v4 gave
// them, so re-deriving an earlier statement under v5 corrects nothing that v4 did not.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical.mjs';
import { coverage, sourceSegments } from './continuity.mjs';
import { fileSha256 } from './files.mjs';
import { pathIdentity } from './paths.mjs';

export const REASON_RULE = 'codex-handoff reason rule v5 (derived from the records)';
// The rule's own bytes, so an entry names exactly which implementation derived it.
export const REASON_RULE_SHA256 = fileSha256(fileURLToPath(import.meta.url));

// v1 records used other words for the same assessments. VERIFIED stays VERIFIED: it was the claim.
const V1_TERMS = { RECORDED: 'OBSERVED', BOUND: 'OBSERVED', PRESENT: 'AVAILABLE' };
// The inputs each classification is computed from.
const KEY_INPUTS = {
  TERMINAL_RECIPES: ['rollout'],
  STORE_KEYS: ['rollout'],
  SANDBOX_LIMITS: ['rollout'],
  SCOPE_ALIGNMENT: ['rollout', 'scope'],
  HELIOS_CHAIN: ['helios'],
  HELIOS_CONTRACT: ['helios'],
  STANDING_REFERENCES: ['references'],
};
const INPUT_NAMES = { rollout: 'rollout records', helios: 'Helios ledger or policy', references: 'standing references', scope: "the index's task paths" };
const HELIOS_FIELDS = ['chainPredecessor', 'gateSchemaVersion', 'tierRequiredFields', 'exitCaptureSuffixes', 'notApplicableReasons', 'separators'];

function classificationOf(record) {
  const c = record.classification ?? {};
  if (record.schema_version !== 'codex-handoff-record.v1') return c;
  return Object.fromEntries(Object.entries(c).map(([key, value]) => [key, V1_TERMS[value] ?? value]));
}

// The Helios inputs two records are compared by. The contract files enter by their hashes, and only
// when both records read them: a record from before the contract was read did not see a different
// input, its producer read less (that shows as a producer change, not as new evidence).
function heliosInputs(a, b) {
  const pick = (h) => (h ? Object.fromEntries(HELIOS_FIELDS.map((f) => [f, h[f] ?? null])) : null);
  const [x, y] = [pick(a), pick(b)];
  const both = a?.contract && b?.contract;
  const files = (h) => ({ schema: h.contract.schema?.sha256 ?? null, policy: h.contract.policy?.sha256 ?? null });
  return both ? [{ ...x, contract: files(a) }, { ...y, contract: files(b) }] : [x, y];
}

// Paths enter the comparison by identity only (lib/paths.mjs); the records keep them as written.
function inputsOf(record) {
  const segments = sourceSegments(record);
  return {
    rollout:
      segments.length > 1
        ? { files: segments.map((s) => ({ path: s.rollout_identity, records: s.records_read })), last: record.source?.last_record_at ?? null }
        : { path: record.source?.rollout_identity ?? pathIdentity(record.source?.rollout), records: record.source?.records_read ?? null, last: record.source?.last_record_at ?? null },
    references: (record.handoff?.references ?? []).map((r) => ({ path: pathIdentity(r.path), exists: r.exists ?? null, sha256: r.sha256 ?? null })),
    scope: (record.scope?.paths ?? []).map(pathIdentity),
  };
}

const filesText = (segments) => `${segments.length} rollout file${segments.length === 1 ? '' : 's'} (${segments.map((s) => `${s.records_read ?? '?'} records`).join(' + ')})`;

function producerChange(a, b) {
  if (a.schema_version !== b.schema_version) return { changed: true, text: `${a.schema_version} → ${b.schema_version}` };
  const [x, y] = [a.producer?.code_sha256, b.producer?.code_sha256];
  if (x && y) return x === y ? { changed: false, text: `unchanged (code ${x.slice(0, 12)})` } : { changed: true, text: `code ${x.slice(0, 12)} → ${y.slice(0, 12)}` };
  return { changed: null, text: 'not recorded' };
}

// Compares the record a row cited with the record that replaces it. The detail text is part of
// the claim: it only gains a clause where that clause decides the code, so a rule change that
// does not change a derivation does not change its text either.
export function replacementReason(oldRecord, newRecord) {
  const [a, b] = [inputsOf(oldRecord), inputsOf(newRecord)];
  [a.helios, b.helios] = heliosInputs(oldRecord.handoff?.helios, newRecord.handoff?.helios);
  // the key order of v4, so single-file comparisons keep their wording
  const order = ['rollout', 'helios', 'references', 'scope'];
  const changedInputs = order.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]));
  const [ca, cb] = [classificationOf(oldRecord), classificationOf(newRecord)];
  const changedKeys = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].filter((k) => ca[k] !== cb[k]).sort();
  const producer = producerChange(oldRecord, newRecord);
  const [sa, sb] = [sourceSegments(oldRecord), sourceSegments(newRecord)];
  const singleFile = sa.length <= 1 && sb.length <= 1;
  const rolloutText = singleFile
    ? `rollout records read ${a.rollout.records ?? '?'} → ${b.rollout.records ?? '?'} (${a.rollout.path === b.rollout.path ? 'same' : 'different'} rollout file)`
    : `rollout files read: ${filesText(sa)} → ${filesText(sb)}${coverage(oldRecord, newRecord).covered ? ', every earlier file read again' : ', not every earlier file read again'}`;
  const detail = [
    rolloutText,
    `inputs changed: ${changedInputs.length ? changedInputs.map((k) => INPUT_NAMES[k]).join(', ') : 'none'}`,
    `classification: ${changedKeys.length ? changedKeys.map((k) => `${k} ${ca[k] ?? 'absent'} → ${cb[k] ?? 'absent'}`).join(', ') : 'unchanged'}`,
    `producer: ${producer.text}`,
  ].join('; ');
  if (singleFile && a.rollout.path === b.rollout.path && Number.isInteger(a.rollout.records) && Number.isInteger(b.rollout.records) && b.rollout.records < a.rollout.records) {
    return { code: 'EARLIER_CURSOR', detail };
  }
  if (!singleFile && !coverage(oldRecord, newRecord).covered) return { code: 'PARTIAL_SOURCE_VIEW', detail };
  // a classification whose inputs did not change was changed by the producer
  const byProducer = changedKeys.filter((k) => !(KEY_INPUTS[k] ?? Object.keys(INPUT_NAMES)).some((input) => changedInputs.includes(input)));
  if (byProducer.length) {
    if (producer.changed === false) return { code: 'UNEXPLAINED_CHANGE', detail };
    const withdrawn = byProducer.some((k) => ca[k] === 'VERIFIED' && cb[k] !== 'VERIFIED');
    return { code: withdrawn ? 'FALSE_VERIFICATION' : 'CORRECTED_CLASSIFICATION', detail };
  }
  if (changedInputs.length) return { code: 'NEW_EVIDENCE', detail };
  if (canonicalJson(oldRecord.handoff?.endpoints ?? []) !== canonicalJson(newRecord.handoff?.endpoints ?? [])) {
    const projected = `${detail}; projection changed: terminal endpoints`;
    return { code: producer.changed === false ? 'UNEXPLAINED_CHANGE' : 'CORRECTED_PROJECTION', detail: projected };
  }
  return { code: 'RECAPTURED', detail };
}

const ROW_RECORD = /record (\d{4,}), sha256 `([0-9a-f]{12})`/;

// The record an index row cites ("record 0001, sha256 `3893d4ce9640`"), found in the session's
// records and checked against the hash prefix the row states.
export function recordCitedByRow(row, sessionDir) {
  const m = String(row ?? '').match(ROW_RECORD);
  if (!m) return { reason: 'the replaced row cites no record' };
  const path = join(sessionDir, 'records', `handoff-${m[1]}.json`);
  if (!existsSync(path)) return { reason: `record ${m[1]} cited by the replaced row is missing` };
  const sha256 = fileSha256(path);
  if (!sha256.startsWith(m[2])) return { reason: `record ${m[1]} no longer has the hash the replaced row cites` };
  return { path, sha256, record: JSON.parse(readFileSync(path, 'utf8')) };
}

// A record named with its full hash (a change-log entry's "replaces record ..."), checked.
function recordWithHash({ path, sha256 }) {
  if (!existsSync(path)) return { reason: `record ${path} is missing` };
  const actual = fileSha256(path);
  if (actual !== sha256) return { reason: `record ${path} no longer has the hash the entry states` };
  return { path, sha256, record: JSON.parse(readFileSync(path, 'utf8')) };
}

// The reason a row citing one record was replaced by a row for `next` ({ dir, path, sha256 }).
// `previous` ({ path, sha256 }), when the entry names the replaced record with its full hash, is
// used instead of the row's 12-character citation.
export function rowReplacementReason(oldRow, next, previous = null) {
  const cited = previous ? recordWithHash(previous) : recordCitedByRow(oldRow, next.dir);
  if (cited.reason) return { code: 'UNRESOLVED', detail: cited.reason, from: null };
  const from = { path: cited.path, sha256: cited.sha256 };
  if (cited.sha256 === next.sha256) return { code: 'RENDERING_CHANGED', detail: 'the row was rendered again from the same record', from };
  return { ...replacementReason(cited.record, JSON.parse(readFileSync(next.path, 'utf8'))), from };
}
