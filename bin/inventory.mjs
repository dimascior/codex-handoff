#!/usr/bin/env node
// Runs the test suite and writes a regression inventory derived from that run, so test counts are
// never typed by hand (as HeliosEntitlementAuthority's regression-inventory.json):
//   evidence/test-run.tap               the run's TAP log
//   evidence/regression-inventory.json  counts parsed from the log, the invariant
//                                       tests == pass + fail + cancelled + skipped + todo and
//                                       whether it holds, the log's hash, the producer code hash
//                                       and each test file's hash
// Each file gets a sidecar. Exits 1 unless the run passed and the invariant holds.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileSha256, lf, sha256, writeAtomic, writeSidecar } from '../lib/files.mjs';
import { producerIdentity } from '../lib/producer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE = join(ROOT, 'evidence');
const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const log = lf(run.stdout ?? '');
mkdirSync(EVIDENCE, { recursive: true });
const logPath = join(EVIDENCE, 'test-run.tap');
writeAtomic(logPath, log);
writeSidecar(logPath);

const counts = Object.fromEntries(COUNTS.map((k) => [k, Number(log.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? Number.NaN)]));
const parsed = COUNTS.every((k) => Number.isInteger(counts[k]));
const invariantHolds = parsed && counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo;
const inventory = {
  schema_version: 'codex-handoff-regression-inventory.v1',
  run_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  command: 'node --test --test-reporter=tap',
  node: process.version,
  exit_code: run.status,
  producer: { code_sha256: producerIdentity(ROOT).code_sha256 },
  test_files: readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => ({ path: `test/${name}`, sha256: fileSha256(join(ROOT, 'test', name)) })),
  log: { file: 'evidence/test-run.tap', sha256: sha256(log) },
  counts: parsed ? counts : { unparsed: 'the TAP summary was not found in the log' },
  invariant: 'tests == pass + fail + cancelled + skipped + todo',
  invariant_holds: invariantHolds,
};
const path = join(EVIDENCE, 'regression-inventory.json');
writeAtomic(path, `${JSON.stringify(inventory, null, 2)}\n`);
writeSidecar(path);

const summary = parsed
  ? `${counts.pass}/${counts.tests} passed, ${counts.fail} failed, ${counts.skipped} skipped, ${counts.todo} todo, ${counts.cancelled} cancelled`
  : 'counts not found in the TAP log';
process.stdout.write(`${summary}; invariant ${invariantHolds ? 'holds' : 'does not hold'}; exit ${run.status}\n${path}\n`);
process.exitCode = run.status === 0 && invariantHolds && counts.fail === 0 ? 0 : 1;
