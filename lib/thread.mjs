// The unit of continuity is the Codex thread, not one rollout file. A thread (the id its
// session_meta declares) can span several rollout files: a resume can continue it in a new file,
// rollout-<time>-<thread>_<segment>.jsonl, which holds only what happened after the resume
// (observed 2026-10-03 for thread 01a0fcec: the resumed file started with 8 records while the
// thread's history, 3,694 records and three compactions, stayed in the first file). A snapshot that
// read only the new file would be a partial view of the thread, not its successor state.
//
// This module finds every rollout file of a thread, exports each through the devtools export (the
// raw format stays behind that interface), keeps the files whose export declares the thread id
// (file names are only a pre-filter), orders them by their first record and merges them into one
// document whose line numbers are thread lines:
//   thread line = the file's line_offset + the line in that file
// so every comparison by line (which observation precedes which call) stays valid across files,
// and every cited line maps back to its file (the record's source.segments). A thread kept in one
// file is passed through unchanged: its thread lines are its file lines.
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { exportSession } from './export.mjs';
import { pathIdentity } from './paths.mjs';

const ROLLOUT_FILE = /^rollout-.+\.jsonl(\.zst)?$/;
const DATE_DIR = /^\d{2,4}$/;

// sessions/YYYY/MM/DD/rollout-*.jsonl → sessions; null for a file outside that layout.
export function sessionsRootOf(rolloutPath) {
  if (!rolloutPath) return null;
  const day = dirname(String(rolloutPath));
  const month = dirname(day);
  const year = dirname(month);
  if (![day, month, year].every((d) => DATE_DIR.test(basename(d)))) return null;
  return dirname(year);
}

// Rollout files under the sessions roots (YYYY/MM/DD/) whose name contains the thread id.
export function candidateFiles(roots, threadId) {
  const found = new Map();
  if (!threadId) return [];
  const walk = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (depth < 3) {
        if (DATE_DIR.test(name)) walk(join(dir, name), depth + 1);
      } else if (ROLLOUT_FILE.test(name) && name.includes(threadId)) {
        const path = join(dir, name);
        found.set(pathIdentity(path), path);
      }
    }
  };
  const seen = new Set();
  for (const root of roots) {
    const id = pathIdentity(root);
    if (!root || seen.has(id) || !existsSync(root)) continue;
    seen.add(id);
    walk(root, 0);
  }
  return [...found.values()];
}

const stamps = (doc) => [...(doc.session?.timeline ?? []), ...(doc.session?.executions ?? [])].map((e) => e.timestamp).filter(Boolean).sort();

function maxLine(doc) {
  let max = 0;
  const visit = (x) => {
    for (const k of ['lineNumber', 'outputLineNumber']) if (Number.isInteger(x?.[k]) && x[k] > max) max = x[k];
    for (const c of x?.children ?? []) visit(c);
    if (x?.execution) visit(x.execution);
  };
  for (const e of doc.session?.timeline ?? []) visit(e);
  for (const x of doc.session?.executions ?? []) visit(x);
  return max;
}

// How many lines a segment occupies in the thread: at least every line it cites and every record it read.
export const linesOf = (doc) => Math.max(doc.untilLine ? doc.untilLine - 1 : 0, Number(doc.records) || 0, maxLine(doc));

function shifted(x, offset) {
  const copy = { ...x };
  for (const k of ['lineNumber', 'outputLineNumber']) if (Number.isInteger(copy[k])) copy[k] += offset;
  if (Array.isArray(copy.children)) copy.children = copy.children.map((c) => shifted(c, offset));
  if (copy.execution) copy.execution = shifted(copy.execution, offset);
  return copy;
}

function segmentEntry(s, index, offset) {
  const at = stamps(s.doc);
  const rollout = s.doc.file ?? s.path;
  return {
    index,
    rollout,
    rollout_identity: pathIdentity(rollout),
    thread_id: s.doc.session?.metadata?.threadId ?? null,
    line_offset: offset,
    lines: linesOf(s.doc),
    records_read: s.doc.records ?? null,
    until_line: s.doc.untilLine ?? null,
    first_record_at: at[0] ?? null,
    last_record_at: at.at(-1) ?? null,
  };
}

// One document for the thread, from its segments in order.
export function mergeSegments(segments) {
  if (segments.length === 1) return { doc: segments[0].doc, segments: [segmentEntry(segments[0], 0, 0)] };
  let offset = 0;
  const table = [];
  const timeline = [];
  const executions = [];
  segments.forEach((s, i) => {
    table.push(segmentEntry(s, i, offset));
    for (const e of s.doc.session?.timeline ?? []) timeline.push(shifted(e, offset));
    for (const x of s.doc.session?.executions ?? []) executions.push(shifted(x, offset));
    offset += linesOf(s.doc);
  });
  const last = segments.at(-1).doc;
  return {
    doc: { ...last, untilLine: null, records: offset, session: { ...last.session, timeline, executions } },
    segments: table,
  };
}

// The thread view up to and including `transcript`: every rollout file of the thread, exported,
// confirmed by the thread id its export declares, ordered by first record. The thread id is the one
// given (the hook's session id), else the one the transcript's export declares. `untilLine` applies
// to the transcript only. Files that start after the transcript are left out (a dry run over an
// older file must not see later ones). Each file left out is listed with the reason.
export function threadView(config, { transcript, threadId = null, untilLine, roots = [], exporter = exportSession }) {
  const transcriptId = pathIdentity(transcript);
  const own = exporter(config, transcript, untilLine);
  const thread = threadId ?? own.session?.metadata?.threadId ?? null;
  const segments = [{ path: transcript, doc: own, isTranscript: true, firstAt: stamps(own)[0] ?? '' }];
  const excluded = [];
  const others = thread ? candidateFiles([sessionsRootOf(transcript), ...roots], thread).filter((p) => pathIdentity(p) !== transcriptId) : [];
  for (const path of others) {
    let doc;
    try {
      doc = exporter(config, path, undefined);
    } catch (error) {
      excluded.push({ rollout: path, reason: 'EXPORT_FAILED', detail: String(error.message).slice(0, 300) });
      continue;
    }
    const declared = doc.session?.metadata?.threadId ?? null;
    if (declared !== thread) {
      excluded.push({ rollout: path, reason: declared ? 'OTHER_THREAD' : 'NO_THREAD_ID', declared });
      continue;
    }
    segments.push({ path, doc, isTranscript: false, firstAt: stamps(doc)[0] ?? '' });
  }
  segments.sort((a, b) => (a.firstAt && b.firstAt && a.firstAt !== b.firstAt ? a.firstAt.localeCompare(b.firstAt) : basename(a.path).localeCompare(basename(b.path))));
  const upTo = segments.findIndex((s) => s.isTranscript);
  for (const s of segments.slice(upTo + 1)) excluded.push({ rollout: s.path, reason: 'STARTS_AFTER_TRANSCRIPT' });
  const merged = mergeSegments(segments.slice(0, upTo + 1));
  return { ...merged, threadId: thread, excluded };
}

// The newest rollout file of a thread, by the start time in its name (rollout-<time>-...).
export function newestRollout(roots, threadId) {
  return candidateFiles(roots, threadId).sort((a, b) => basename(a).localeCompare(basename(b))).at(-1) ?? null;
}

// Where a thread line is: { segment, line } (segment 0 for a thread kept in one file).
export function locate(segments, threadLine) {
  if (!Number.isInteger(threadLine) || !segments?.length) return { segment: 0, line: threadLine };
  for (let i = segments.length - 1; i >= 0; i--) {
    if (threadLine > segments[i].line_offset) return { segment: i, line: threadLine - segments[i].line_offset };
  }
  return { segment: 0, line: threadLine };
}

// "line N" for a thread kept in one file; "rollout K line N" when it spans several.
export function lineRef(segments, threadLine) {
  if (!segments || segments.length < 2) return `line ${threadLine}`;
  const at = locate(segments, threadLine);
  return `rollout ${at.segment + 1} line ${at.line}`;
}
