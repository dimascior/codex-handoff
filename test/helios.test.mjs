import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { claimsOf } from '../lib/evidence.mjs';
import { gateContract, readHelios } from '../lib/helios.mjs';
import { renderHandoff } from '../lib/render.mjs';

// A Helios root shaped like the live one (schema sections, policy, integrity manifest, ledger,
// consumed gates), written with CRLF line endings as the live files are.
const crlf = (obj) => `${JSON.stringify(obj, null, 2)}\n`.replace(/\n/g, '\r\n');
const rawSha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const SCHEMA = (base, meanings = {}) => ({
  schema_doc_version: 'helios-gate-schema.v1',
  gate_schema_version: 'gate-x.v9',
  sections: {
    virtual: {
      grammar: ['helios gate schema', 'helios gate schema --tier <0-3> --shell <bash|powershell>', 'helios gate schema --tier <0-3> --shell <bash|powershell> --example'],
      rules: 'Exact grammar only. Nothing executes through PATH, no gate is consumed, and the answer must not be retried.',
    },
    fields: {
      required_base_fields: base,
      types_and_meaning: { schema_version: "string - exactly 'gate-x.v9'", multi_command: 'boolean - true when the command decomposes into more than one segment', ...meanings },
    },
    segments: { separators: [';', '&&'] },
  },
});
const POLICY = { tier_required_fields: { 0: ['need', 'expected'], 2: ['need', 'stop_conditions'], 3: ['need', 'stop_conditions', 'read_write_impact'] }, exit_capture_suffixes: { bash: ['; echo EXIT=$?'] } };
const BASE = ['schema_version', 'correlation_id', 'command', 'multi_command', 'need', 'expected'];

function heliosRoot({ schema = SCHEMA(BASE), policy = POLICY, pins = true, ledger = 'corr-9', gate = { schema_version: 'gate-x.v9' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-handoff-helios-'));
  for (const d of ['schema', 'policy', 'manifest', 'session', 'evidence', 'pending']) mkdirSync(join(root, d));
  const schemaText = schema === null ? null : typeof schema === 'string' ? schema : crlf(schema);
  const policyText = crlf(policy);
  if (schemaText !== null) writeFileSync(join(root, 'schema', 'helios-gate.schema.json'), schemaText);
  writeFileSync(join(root, 'policy', 'command-policy.json'), policyText);
  const pinned = { 'policy/command-policy.json': rawSha(policyText), ...(schemaText !== null ? { 'schema/helios-gate.schema.json': pins === 'wrong' ? '0'.repeat(64) : rawSha(schemaText) } : {}) };
  if (pins) writeFileSync(join(root, 'manifest', 'helios-envelope.json'), crlf({ integrity: { files: pinned } }));
  if (ledger) {
    writeFileSync(join(root, 'session', 'session-ledger-thread-1.jsonl'), `${JSON.stringify({ event_type: 'posttooluse_evidence_written', correlation_id: ledger, timestamp_utc: '2026-10-03T03:41:09Z' })}\n`);
    if (gate) writeFileSync(join(root, 'evidence', `20261003-${ledger}.gate.json`), crlf(gate));
  }
  return root;
}

const withRoot = (options, fn) => {
  const root = heliosRoot(options);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// The minimal hand-off render needs, with a given Helios state.
const handoffWith = (helios) => ({ takenAt: 'pre_compact', compactions: 2, records: 10, untilLine: null, lastRecordAt: null, task: [], position: { agentMessages: [], lastCell: null }, terminal: { recipes: {}, cell: null }, sandbox: [], store: [], helios });

test('the gate contract is the schema base fields plus the policy tier fields: one union per tier, each field once', () => {
  withRoot({}, (root) => {
    const c = gateContract(root);
    assert.equal(c.status, 'AVAILABLE');
    assert.deepEqual(c.base_fields, { authority: 'DECLARED', source: 'schema sections.fields.required_base_fields', fields: BASE });
    assert.deepEqual(c.tier_fields.tiers, POLICY.tier_required_fields);
    assert.equal(c.effective.authority, 'DERIVED');
    // need and expected are base and tier fields: listed once
    assert.deepEqual(c.effective.tiers['0'], BASE);
    assert.deepEqual(c.effective.tiers['3'], [...BASE, 'stop_conditions', 'read_write_impact']);
    for (const fields of Object.values(c.effective.tiers)) assert.equal(new Set(fields).size, fields.length);
  });
});

test('a base field added to the schema reaches the contract and the text with no code change; one removed is gone', () => {
  withRoot({ schema: SCHEMA([...BASE, 'approval_note']) }, (root) => {
    const c = gateContract(root);
    assert.ok(c.base_fields.fields.includes('approval_note'));
    assert.ok(Object.values(c.effective.tiers).every((f) => f.includes('approval_note')));
    assert.match(renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1'))), /Fields every gate needs[^\n]*approval_note/);
  });
  withRoot({ schema: SCHEMA(BASE.filter((f) => f !== 'multi_command')) }, (root) => {
    const c = gateContract(root);
    assert.ok(!c.base_fields.fields.includes('multi_command'));
    assert.ok(Object.values(c.effective.tiers).every((f) => !f.includes('multi_command')));
    // its meaning is only carried for base fields
    assert.deepEqual(c.boolean_fields, []);
    assert.doesNotMatch(renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1'))), /multi_command/);
  });
});

test('a value the schema fixes is DECLARED, and VERIFIED only when a gate Helios accepted carries it too', () => {
  withRoot({}, (root) => {
    const [v] = gateContract(root, { chainPredecessor: { correlationId: 'corr-9' } }).fixed_values;
    assert.deepEqual([v.field, v.value, v.authority, v.witness.matches], ['schema_version', 'gate-x.v9', 'VERIFIED', true]);
    // the requirement alone does not make the value verified
    const alone = gateContract(root).fixed_values[0];
    assert.deepEqual([alone.authority, alone.witness.availability], ['DECLARED', 'UNKNOWN']);
  });
  withRoot({ gate: { schema_version: 'something-else' } }, (root) => {
    const [v] = gateContract(root, { chainPredecessor: { correlationId: 'corr-9' } }).fixed_values;
    assert.deepEqual([v.authority, v.witness.carries, v.witness.matches], ['DECLARED', 'something-else', false]);
  });
});

test('boolean base fields are carried as their meaning, never as a value', () => {
  withRoot({}, (root) => {
    const c = gateContract(root);
    assert.deepEqual(c.boolean_fields, [{ field: 'multi_command', meaning: 'boolean - true when the command decomposes into more than one segment', authority: 'DECLARED' }]);
    const text = renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1')));
    assert.match(text, /Set per command: multi_command \(boolean - true when the command decomposes/);
    assert.doesNotMatch(text, /multi_command"?\s*[:=]\s*(true|false)/);
  });
});

test('contract files are identified by their raw bytes and compared with the Helios manifest pins', () => {
  withRoot({}, (root) => {
    const c = gateContract(root);
    const raw = readFileSync(join(root, 'schema', 'helios-gate.schema.json'));
    assert.equal(c.schema.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.notEqual(c.schema.sha256, rawSha(raw.toString('utf8').replace(/\r\n/g, '\n')), 'not the LF-normalized hash');
    assert.equal(c.schema.identity.status, 'MATCHES_MANIFEST_PIN');
    assert.equal(c.policy.identity.status, 'MATCHES_MANIFEST_PIN');
  });
  withRoot({ pins: 'wrong' }, (root) => assert.equal(gateContract(root).schema.identity.status, 'DIFFERS_FROM_MANIFEST_PIN'));
  withRoot({ pins: false }, (root) => assert.equal(gateContract(root).schema.identity.status, 'NO_MANIFEST_PIN'));
});

test('a missing or malformed schema is reported as such, and no field list is filled in from memory', () => {
  for (const schema of [null, '{ not json', crlf({ sections: { fields: {} } })]) {
    withRoot({ schema }, (root) => {
      const helios = readHelios({ heliosRoot: root }, 'thread-1');
      const c = helios.contract;
      assert.equal(c.status, 'PARTIAL', 'tier fields still come from the policy');
      assert.equal(c.base_fields.availability, 'UNAVAILABLE');
      assert.equal(c.effective.availability, 'UNAVAILABLE');
      assert.deepEqual(c.fixed_values, []);
      const text = renderHandoff(handoffWith(helios));
      assert.match(text, /Fields every gate needs: not available/);
      // the fixture schema's base fields; the policy names none of them
      assert.doesNotMatch(text, /\bschema_version\b|\bmulti_command\b|\bcorrelation_id\b/, 'nothing from a remembered list');
    });
  }
  // the separators come from the schema too: without it the text says so instead of assuming them
  withRoot({ schema: null }, (root) => assert.match(renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1'))), /split as the schema's segments section says/));
});

test('compaction #3: the hand-off then in force named neither base field; the candidate names both', () => {
  // record handoff-0006's Helios state as captured (the tier lists only), and the gate rejected after
  // the compaction (blocked 20261002-234315: missing base fields schema_version, multi_command)
  const before = {
    pendingDir: 'C:\\gate\\pending',
    evidenceDir: 'C:\\gate\\evidence',
    chainPredecessor: { correlationId: '20261002-catalog-resume-165', at: '2026-10-03T03:41:09.2436771Z' },
    exitCaptureSuffixes: { bash: ['; echo EXIT=$?'] },
    tierRequiredFields: { 0: ['need', 'expected', 'actual_means', 'next_logic'], 1: ['need', 'expected', 'actual_means', 'next_logic'], 2: ['need', 'expected', 'actual_means', 'next_logic', 'stop_conditions'], 3: ['need', 'expected', 'actual_means', 'next_logic', 'stop_conditions', 'read_write_impact'] },
    gateSchemaVersion: 'command-gate.v1',
    separators: [';', '&&', '||', '|'],
  };
  const rejected = { command_sha256: '5df96910ff873e3b5f26aaf4699841f2e103d3953ca07d3b736be333130e1279', previous_correlation_id: '20261002-catalog-resume-165', need: 'x', expected: 'x', actual_means: 'x', next_logic: 'x' };
  const old = renderHandoff(handoffWith(before));
  assert.ok(old.includes('20261002-catalog-resume-165') && old.includes('need, expected, actual_means, next_logic'), 'chain and tier fields were there');
  for (const missing of ['schema_version', 'multi_command']) {
    assert.ok(!(missing in rejected));
    assert.ok(!old.includes(missing), `the text then in force did not name ${missing}`);
  }
  withRoot({ schema: SCHEMA(['schema_version', 'correlation_id', 'command', 'command_sha256', 'multi_command', 'need', 'expected', 'actual_means', 'next_logic']), ledger: '20261002-catalog-resume-165' }, (root) => {
    const now = renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1')));
    assert.match(now, /Fields every gate needs[^\n]*schema_version[^\n]*multi_command/);
    assert.match(now, /Values the schema fixes: schema_version "gate-x\.v9" \(also in Helios-accepted gate 20261002-catalog-resume-165\)/);
    assert.ok(now.includes('20261002-catalog-resume-165'), 'the chain stays');
  });
});

test("Helios's own projection command comes from the schema grammar, and whether it consumes a gate from the schema rules", () => {
  withRoot({}, (root) => {
    const c = gateContract(root);
    assert.deepEqual(c.projection, { command: 'helios gate schema --tier <0-3> --shell <bash|powershell>', source: 'schema sections.virtual.grammar', consumes_gate: false });
    assert.match(renderHandoff(handoffWith(readHelios({ heliosRoot: root }, 'thread-1'))), /helios gate schema --tier <0-3> --shell <bash\|powershell> \(no gate consumed\)/);
  });
  const quiet = SCHEMA(BASE);
  quiet.sections.virtual.rules = 'Exact grammar only.';
  withRoot({ schema: quiet }, (root) => assert.equal(gateContract(root).projection.consumes_gate, null));
});

test('contract claims keep the declared lists, the derived union and a verified value apart, each with its file', () => {
  withRoot({}, (root) => {
    const claims = claimsOf({ task: [], position: { agentMessages: [] }, terminal: { recipes: {} }, store: [], sandbox: [], helios: readHelios({ heliosRoot: root }, 'thread-1') });
    const by = (text) => claims.find((c) => c.claim === text);
    assert.equal(by('fields every Helios gate needs').authority, 'DECLARED');
    assert.equal(by('fields every Helios gate needs').provenance[0].type, 'HELIOS_GATE_SCHEMA');
    assert.equal(by('fields each risk tier adds').provenance[0].type, 'HELIOS_COMMAND_POLICY');
    assert.equal(by('fields a gate needs at each tier').authority, 'DERIVED');
    const value = by('gate field schema_version is "gate-x.v9"');
    assert.equal(value.authority, 'VERIFIED');
    assert.deepEqual(value.provenance.map((p) => p.type), ['HELIOS_GATE_SCHEMA', 'HELIOS_CONSUMED_GATE']);
  });
});

test('the contract reader and the renderer keep no field list of their own', () => {
  for (const file of ['../lib/helios.mjs', '../lib/render.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    // as words: the schema's own key gate_schema_version is an address, not a field list
    for (const name of ['schema_version', 'multi_command', 'approval_boundary', 'expires_utc']) {
      assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), `${file} names ${name}`);
    }
    assert.ok(!source.includes('command-gate.v1'), `${file} names a schema version`);
  }
});
