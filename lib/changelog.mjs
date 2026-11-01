// Append-only change log (markdown) of the generated block in an index document. Entries are
// never edited or removed: a superseded or removed row is kept verbatim as the original next to
// its forward value, and each entry names the SHA-256 of the previous entry's text, so the
// history can be checked (forward corrections, as in HeliosEntitlementAuthority). An entry whose
// statement the records later contradict stays as written; a CORRECTION entry names it and gives
// the corrected statement.
import { existsSync, readFileSync } from 'node:fs';

import { checkSidecar, lf, sha256, writeAtomic, writeSidecar } from './files.mjs';

const HEADING = /^## (\d{4,}) · /;
const pad = (n) => String(n).padStart(4, '0');

export function parseEntries(text) {
  const lines = lf(text).split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (HEADING.test(line)) starts.push(i);
  });
  return starts.map((start, k) => {
    const body = lines.slice(start, k + 1 < starts.length ? starts[k + 1] : lines.length);
    while (body.length && !body.at(-1).trim()) body.pop();
    const entryText = `${body.join('\n')}\n`;
    return {
      sequence: Number(lines[start].match(HEADING)[1]),
      prev: entryText.match(/^- Previous entry sha256: `([0-9a-f]{64})`$/m)?.[1] ?? null,
      sha256: sha256(entryText),
      text: entryText,
    };
  });
}

function header(documentName) {
  return [
    `# Change log: ${documentName}`,
    '',
    `Append-only history of the generated block in \`${documentName}\`, written by the codex-handoff hooks before they change the block. Entries are never edited or removed: a superseded or removed row is kept here verbatim. Each entry names the SHA-256 of the previous entry, so the chain can be checked with \`handoff.mjs verify\`.`,
    '',
  ].join('\n');
}

const indented = (rows, empty) => {
  const list = [].concat(rows ?? []);
  return list.length ? list.map((r) => `    ${r}`) : [`    ${empty}`];
};

export function renderEntry(e) {
  const lines = [`## ${pad(e.sequence)} · ${e.at} · ${e.kind}${e.corrects ? ` · entry ${pad(e.corrects)}` : ''}${e.session ? ` · session ${e.session}` : ''}`, ''];
  lines.push(`- Block sha256: \`${e.blockBefore}\` → \`${e.blockAfter}\``);
  if (e.evidence) lines.push(`- Evidence: ${e.evidence}`);
  if (e.reasonCode) lines.push(`- Reason code: ${e.reasonCode}`);
  if (e.reasonRule) lines.push(`- Derived by: ${e.reasonRule}`);
  if (e.reasonRuleSha256) lines.push(`- Rule code sha256: \`${e.reasonRuleSha256}\``);
  if (e.reason) lines.push(`- Reason: ${e.reason}`);
  lines.push(`- Previous entry sha256: ${e.prevSha ? `\`${e.prevSha}\`` : 'none (first entry)'}`);
  if ('original' in e) lines.push('', e.kind === 'BASELINE' ? 'Block as found:' : 'Original (superseded):', '', ...indented(e.original, '(none)'));
  if ('forward' in e) lines.push('', 'Forward value:', '', ...indented(e.forward, '(none: removed from the block, kept here)'));
  return `${lines.join('\n')}\n`;
}

const indentedAfter = (lines, label) => {
  const at = lines.indexOf(label);
  const rows = [];
  for (let i = at + 2; at >= 0 && i < lines.length && lines[i].startsWith('    '); i++) rows.push(lines[i].slice(4));
  return rows;
};

// The fields of an entry as renderEntry wrote them.
export function entryFields(entry) {
  const lines = entry.text.split('\n');
  const parts = lines[0].replace(/^## /, '').split(' · ');
  const evidence = entry.text.match(/^- Evidence: record `([^`]+)` \(sha256 `([0-9a-f]{64})`\)/m);
  // the replaced record, when the entry names it with its full hash
  const previous = entry.text.match(/^- Evidence: .*?(?:replaces|replacing) record `([^`]+)` \(sha256 `([0-9a-f]{64})`\)/m);
  return {
    sequence: entry.sequence,
    at: parts[1] ?? null,
    kind: parts[2] ?? null,
    corrects: Number(parts.find((p) => p.startsWith('entry '))?.slice(6)) || null,
    session: parts.find((p) => p.startsWith('session '))?.slice(8) ?? null,
    reasonCode: entry.text.match(/^- Reason code: (\S+)$/m)?.[1] ?? null,
    reasonRule: entry.text.match(/^- Derived by: (.+)$/m)?.[1] ?? null,
    reasonRuleSha256: entry.text.match(/^- Rule code sha256: `([0-9a-f]{64})`$/m)?.[1] ?? null,
    reason: entry.text.match(/^- Reason: (.+)$/m)?.[1] ?? null,
    record: evidence ? { path: evidence[1], sha256: evidence[2] } : null,
    previous: previous ? { path: previous[1], sha256: previous[2] } : null,
    original: indentedAfter(lines, 'Original (superseded):'),
    forward: indentedAfter(lines, 'Forward value:'),
  };
}

export function appendEntries(logPath, entries, { documentName }) {
  let text = existsSync(logPath) ? lf(readFileSync(logPath, 'utf8')) : header(documentName);
  let prev = parseEntries(text).at(-1) ?? null;
  for (const e of entries) {
    const sequence = (prev?.sequence ?? 0) + 1;
    const entryText = renderEntry({ ...e, sequence, prevSha: prev?.sha256 ?? null });
    text = `${text.replace(/\n*$/, '')}\n\n${entryText}`;
    prev = { sequence, sha256: sha256(entryText) };
  }
  writeAtomic(logPath, text);
  writeSidecar(logPath);
  return prev;
}

export function verifyChangeLog(logPath) {
  const results = [{ check: 'change log sidecar', ...checkSidecar(logPath) }];
  const entries = parseEntries(readFileSync(logPath, 'utf8'));
  entries.forEach((e, i) => {
    const expectedPrev = i ? entries[i - 1].sha256 : null;
    const ok = e.sequence === i + 1 && e.prev === expectedPrev;
    results.push({
      check: `change log entry ${String(e.sequence).padStart(4, '0')}`,
      ok,
      detail: ok ? e.sha256 : `expected entry ${i + 1} after ${expectedPrev ? `${expectedPrev.slice(0, 12)}…` : 'none'}`,
    });
  });
  return results;
}
