import assert from 'node:assert/strict';
import { test } from 'node:test';

import { replacementReason } from '../lib/reasons.mjs';

const CLASSIFIED = { TERMINAL_RECIPES: 'OBSERVED', STORE_KEYS: 'OBSERVED', SANDBOX_LIMITS: 'OBSERVED', HELIOS_CHAIN: 'OBSERVED', STANDING_REFERENCES: 'AVAILABLE', SCOPE_ALIGNMENT: 'TASK_NAME' };

const record = (over = {}) => ({
  schema_version: 'codex-handoff-record.v2',
  source: { rollout: 'C:/sessions/rollout-a.jsonl', records_read: 2634, until_line: null, last_record_at: '2026-10-02T15:56:49.596Z' },
  scope: { paths: ['C:\\Work\\CODEAPI'] },
  producer: { code_sha256: 'a'.repeat(64) },
  classification: { ...CLASSIFIED },
  handoff: {
    helios: { chainPredecessor: { correlationId: 'c-106', at: '2026-10-02T15:53:53Z' }, gateSchemaVersion: 'command-gate.v1' },
    references: [{ path: 'C:\\Index.md', exists: true, sha256: 'b'.repeat(64) }],
  },
  ...over,
});

test('same rollout records, a v1 VERIFIED withdrawn by v2: a false verification, not new evidence', () => {
  const v1 = record({
    schema_version: 'codex-handoff-record.v1',
    producer: undefined,
    classification: { TERMINAL_RECIPES: 'VERIFIED', STORE_KEYS: 'RECORDED', SANDBOX_LIMITS: 'RECORDED', HELIOS_CHAIN: 'BOUND', STANDING_REFERENCES: 'PRESENT', SCOPE_ALIGNMENT: 'TASK_NAME' },
  });
  const why = replacementReason(v1, record());
  assert.equal(why.code, 'FALSE_VERIFICATION');
  assert.match(why.detail, /rollout records read 2634 → 2634 \(same rollout file\)/);
  assert.match(why.detail, /inputs changed: none/);
  // the v1 words for the same assessments are not counted as changes
  assert.match(why.detail, /classification: TERMINAL_RECIPES VERIFIED → OBSERVED; producer: codex-handoff-record\.v1 → codex-handoff-record\.v2/);
});

test('one rollout file named in two spellings is the same file, not new evidence', () => {
  // the SessionStart hook passes Codex's extended-length path; manual runs pass forward slashes
  const fromHook = record({ source: { ...record().source, rollout: '\\\\?\\C:\\Sessions\\rollout-a.jsonl' } });
  const fromManual = record({ source: { ...record().source, rollout: 'C:/sessions/rollout-a.jsonl' } });
  const why = replacementReason(fromHook, fromManual);
  assert.equal(why.code, 'RECAPTURED');
  assert.match(why.detail, /\(same rollout file\); inputs changed: none/);
  // records written now carry the identity next to the raw path; it is preferred when present
  const raw = record({ source: { ...record().source, rollout: 'D:/elsewhere/r.jsonl', rollout_identity: 'c:\\sessions\\rollout-a.jsonl' } });
  assert.match(replacementReason(fromHook, raw).detail, /\(same rollout file\)/);
});

test('same inputs and classification, terminal endpoints projected differently: a corrected projection', () => {
  const byLocator = { endpoints: [{ term: 't', url: 'http://127.0.0.1:47339', transport: '/term routes', lines: [2558] }] };
  const byIdentity = { endpoints: [{ term: 't', window: { id: 'w' }, url: 'http://127.0.0.1:47339', urls: ['http://127.0.0.1:47339'], transports: ['/term routes'], lines: [2558] }] };
  const before = record({ handoff: { ...record().handoff, ...byLocator } });
  const after = record({ producer: { code_sha256: 'd'.repeat(64) }, handoff: { ...record().handoff, ...byIdentity } });
  const why = replacementReason(before, after);
  assert.equal(why.code, 'CORRECTED_PROJECTION');
  assert.match(why.detail, /inputs changed: none; classification: unchanged; producer: code aaaaaaaaaaaa → dddddddddddd; projection changed: terminal endpoints$/);
  assert.equal(replacementReason(before, { ...after, producer: before.producer }).code, 'UNEXPLAINED_CHANGE');
  // with new evidence the projection clause is not added: it decides nothing
  const advanced = { ...after, source: { ...after.source, records_read: 2700 } };
  assert.doesNotMatch(replacementReason(before, advanced).detail, /projection/);
});

test('more rollout records are new evidence; fewer are an earlier cursor', () => {
  assert.equal(replacementReason(record(), record({ source: { ...record().source, records_read: 2700 } })).code, 'NEW_EVIDENCE');
  assert.equal(replacementReason(record(), record({ source: { ...record().source, records_read: 1500 } })).code, 'EARLIER_CURSOR');
});

test('a changed standing reference or Helios ledger is new evidence, even with the classification unchanged', () => {
  const edited = record({ handoff: { ...record().handoff, references: [{ path: 'C:\\Index.md', exists: true, sha256: 'c'.repeat(64) }] } });
  const why = replacementReason(record(), edited);
  assert.equal(why.code, 'NEW_EVIDENCE');
  assert.match(why.detail, /inputs changed: standing references/);
  // the chain predecessor appears in the ledger: the classification change follows the evidence
  const before = record({ classification: { ...CLASSIFIED, HELIOS_CHAIN: 'EXPECTED_NOT_CAPTURED' }, handoff: { ...record().handoff, helios: { gateSchemaVersion: 'command-gate.v1' } } });
  assert.equal(replacementReason(before, record()).code, 'NEW_EVIDENCE');
});

test('same inputs: recaptured, a corrected classification, or an unexplained change when the producer is the same', () => {
  assert.equal(replacementReason(record(), record()).code, 'RECAPTURED');
  const reclassified = record({ producer: { code_sha256: 'd'.repeat(64) }, classification: { ...CLASSIFIED, STORE_KEYS: 'NONE_RECORDED' } });
  assert.equal(replacementReason(record(), reclassified).code, 'CORRECTED_CLASSIFICATION');
  const sameProducer = record({ classification: { ...CLASSIFIED, STORE_KEYS: 'NONE_RECORDED' } });
  assert.equal(replacementReason(record(), sameProducer).code, 'UNEXPLAINED_CHANGE');
  // no producer identity recorded on either side: attributed to the producer, and said so
  const unknown = replacementReason(record({ producer: undefined }), record({ producer: undefined, classification: { ...CLASSIFIED, STORE_KEYS: 'NONE_RECORDED' } }));
  assert.equal(unknown.code, 'CORRECTED_CLASSIFICATION');
  assert.match(unknown.detail, /producer: not recorded/);
});
