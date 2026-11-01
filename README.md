# codex-handoff

Gives Codex its working state back after a context compaction or a resume, so it continues
where it was instead of rediscovering how it worked.

Two Codex hooks do this:

| Hook | Command | What it does |
|------|---------|--------------|
| `PreCompact` | `handoff.mjs snapshot` | Reads the session record through claude-devtools (every rollout file of the thread, see [Thread, not file](#thread-not-file)), builds the hand-off and saves it. Prints nothing and always exits 0, so it never blocks a compaction. |
| `SessionStart` (matcher `^(compact\|resume)$`) | `handoff.mjs inject` | Prints the hand-off as `hookSpecificOutput.additionalContext`; Codex adds it as developer context before the next model request. After a compaction it prints the snapshot taken just before, if `handoff.txt` still has the hash its accepted record states; on resume, without a recent snapshot, or when that check fails, it rebuilds one. Ahead of it goes a block resolved at that moment from the running CodeAPI instances: each recorded terminal's current endpoint, found by its CodeAPI window identity (see [Runtime routing](#runtime-routing-codeapi)). |

Why two events: `PreCompact` runs at the right moment to read the session but cannot add context,
and neither can `PostCompact`. For both, Codex ignores plain stdout and their JSON takes only
`continue`, `stopReason`, `systemMessage` (a UI warning) and `suppressOutput`. `SessionStart`
hooks matching `compact` run once a root session has been compacted, ahead of the next model
request; when an automatic compaction happens mid-turn, their context reaches the request that
continues that turn.

`developer_instructions` in `config.toml` is the other channel that survives compaction: Codex
re-sends its developer-role setup after every compaction (seen in all eight compactions of the
2026-09-30 session). It is static text, the same for every session that loads that config, so it
suits standing policy, such as "reuse what the hand-off lists before rebuilding a procedure", not
session state. Subagent compactions are not covered: the docs only promise `SessionStart(compact)`
for root sessions.

## What the hand-off contains

Everything comes from what the session recorded. A terminal call counts as working only if the
code cell that ran it completed without a script error, a non-zero exit code or a `wrote 0`
reply.

- **Standing references** (first): documents listed under `references` in `config.json`, such as
  an operational index, with each file's SHA-256 and modification time at snapshot time so Codex
  can tell whether it changed. Read-only; the files themselves are never modified.
- **Task**: the last three user messages, with the paths of pasted files (re-read them for the
  full request).
- **Position**: Codex's last three messages and what the last code cell returned.
- **Terminal recipes**: the newest working CodeAPI PTY calls for writing text, sending Enter and
  reading the buffer, and the whole code cell that last wrote to the terminal (saved as
  `terminal-cell.js`; it holds the gate-writing, hashing and chaining helpers Codex built).
- **Code-mode store**: keys passed to `store()` / `load()`, how they were used, and the cell that
  stored each one (saved as `store-<key>.js`, to re-run if `load()` comes back empty after a
  restart).
- **Sandbox limits**: globals the code-mode sandbox lacked (`ReferenceError`s and `typeof` probes).
- **Helios gate contract**, read live from Helios, which owns it (`lib/helios.mjs`): the fields
  every gate needs are the schema's `sections.fields.required_base_fields` (the array Helios's
  validator reads), the fields a tier adds are the policy's `tier_required_fields`, and what a gate
  needs at a tier is their union (`DERIVED`). codex-handoff keeps no list of its own: a field added
  to the schema appears in the next hand-off, and when the schema cannot be read the hand-off says
  so instead of filling one in. A value is carried only where the schema fixes it ("exactly
  '…'"), and counts as `VERIFIED` only when a gate Helios accepted carries the same value; boolean
  base fields are carried as their meaning (`multi_command`: set per command). The schema and
  policy are identified by the SHA-256 of their raw bytes and compared with the pins in Helios's
  integrity manifest. The hand-off also names the command Helios answers its own contract with
  (`helios gate schema --tier <0-3> --shell <bash|powershell>`, taken from the schema's grammar),
  and the chain predecessor (the session's last executed correlation id from the Helios session
  ledger).

The injected text stays under `maxInjectChars` (7,000 characters by default) so Codex keeps it
inline; above its `additionalContextLimit` (2,500 tokens by default) Codex would save it to a file
and inject only a preview.

## Thread, not file

The unit of continuity is the Codex thread (the id its `session_meta` declares), not one rollout
file. A resume can continue a thread in a new file, `rollout-<time>-<thread>_<segment>.jsonl`,
which holds only what happened after the resume. On 2026-10-03 thread 01a0fcec was resumed into
such a file; the hook read only that file (8 records) and the hand-off it injected had lost the
terminal recipes, store keys, sandbox limits and task of the 3,694 records before it.

Every snapshot therefore reads the whole thread (`lib/thread.mjs`): the rollout files under
`$CODEX_HOME/sessions/YYYY/MM/DD/` whose name contains the thread id (a pre-filter only), each
exported through claude-devtools and kept only if its export declares the thread id, ordered by
first record, up to and including the file the hook named. They are merged into one document whose
line numbers are thread lines (`line_offset` of the file + the line in it), so "which observation
precedes which call" stays right across files. The record keeps the files it read in
`source.segments` (path, identity, offset, records read, first and last record time) and the ones it
left out in `source.excluded` (another thread, export failed, starts after the transcript); a thread
kept in one file has one segment at offset 0, so its lines are its file lines. The hand-off text
cites lines as `rollout K line N` when a thread spans several files.

## Evidence and history

The state follows the evidence conventions of HeliosEntitlementAuthority: records are never
rewritten, each claim cites what it rests on, and history is appended, not replaced.

- **Hand-off records.** Every saved hand-off is an immutable record,
  `<session>/records/handoff-NNNN.json` (`codex-handoff-record.v3`: the thread's rollout files in
  `source.segments`, and the `continuity` verdict below; v1 and v2 records stay valid). It
  names its predecessor (`continuation_from`) and carries the SHA-256 of the predecessor's
  LF-normalized bytes (`continuation_token_sha256`), with a `"<hash>  <name>"` sidecar. One record
  is one snapshot generation (`snapshot`: rollout cursor, last record time, compactions so far)
  and names the code that wrote it (`producer`: hash of `bin/handoff.mjs` and `lib/*.mjs`).
  Cell sources it cites are stored once under their own hash in `cells/`. `handoff.txt`,
  `handoff.json` and the `terminal-cell.js` / `store-*.js` files remain the current-state copies
  the hooks read.
- **Authority, not just state.** Each claim carries an authority (`DECLARED`: the user's task,
  Codex's own messages; `OBSERVED`: a cell result, a ledger entry; `VERIFIED`: confirmed by an
  independent witness, which nothing provides yet; `DERIVED`; `SEMANTIC`: a recipe;
  `RUNTIME_STATE`: terminal id and address, recheck before reuse), a currency
  (`CURRENT_AT_SNAPSHOT`, `DURABLE_UNTIL_INTERFACE_CHANGE`, `REVALIDATE_AFTER_RESUME`) and typed
  provenance (rollout line, cell id and hash, ledger correlation). Physical `occurrences` (one per
  cell execution, identified by its content) come first; `recipes` only refer to them. Each
  `runtime_keys` entry gives the restore expression, the storing cell and whether re-running it is
  safe, and what the record shows about persistence (`after_compaction` is `OBSERVED` only when a
  cell using the key completed after a compaction). Values nobody captured keep their reason
  (`NOT_CAPTURED_BY_PRODUCER`, `EXPECTED_NOT_CAPTURED`, `UNRESOLVED`, `UNKNOWN`), and `open_gaps`
  lists what the hooks cannot establish, with its owner.
- **Accepted, not newest.** `latest.json` moves only to a record that passed its checks
  (sidecar, predecessor binding, schema, every cited cell present with its hash) and says so
  (`status: ACCEPTED`, verifier, prior). `lifecycle.jsonl` journals each step: `CAPTURED`,
  `ACCEPTED`, `RETAINED` or `REJECTED`, `SUPERSEDED`, `INJECTED` (with the hash of the injected
  text) or `NOT_INJECTED` (with the reason), and `ACCEPTANCE_CORRECTED` (below).
- **Integrity is not continuity** (`lib/continuity.mjs`). A hash chain proves a record follows its
  predecessor unaltered, not that it carries what its predecessor carried. A record becomes the
  pointer only when it also (1) reads every rollout file the accepted record read, at least as far,
  and (2) keeps each of its recoverable primitives (terminal recipes, CodeAPI windows, store keys,
  sandbox limits, task-path alignment): observed again (`PRESERVED`), in a newer occurrence of the
  same identity (`REFRESHED`) or replaced by a newer one of its kind (`SUPERSEDED`, e.g. a store key
  displaced by newer ones, shown by `storeTotal`). A primitive that is merely absent is `MISSING`,
  never taken to mean it ceased to exist. The verdict is part of the record (`continuity`: rule,
  predecessor and its hash, coverage, primitive counts); a `CONTINUITY_REGRESSION`
  (`PARTIAL_SOURCE_VIEW` or `PRIMITIVE_LOST`) is journaled `RETAINED`: kept as evidence, while the
  pointer, `handoff.txt`, `handoff.json` and the `terminal-cell.js` / `store-*.js` copies stay on
  the accepted hand-off. A session start whose snapshot is retained injects the accepted hand-off,
  prefixed with one line saying which snapshot was not used and why. Runtime values (ports, PIDs,
  liveness) are not primitives: they are resolved again at injection.
- **Forward repair** (`handoff.mjs reconcile --session-id <id> [--transcript <rollout>]`). Records
  accepted under the earlier checks although they did not read what the record before them read
  get one `ACCEPTANCE_CORRECTED` event each (record and predecessor with their hashes, the
  coverage detail, the rule); the journal is only appended to. The pointer stands for the newest
  accepted record not corrected since. Then a snapshot is taken from the whole thread (it is
  checked against that record) and the index is brought up to date.
- **Task-path alignment.** The index's task paths are the ones it declares on its
  `**Scope checked:**` line (or `index.scopePaths` in `config.json`). A session is listed only when
  its records show work there: `WORKSPACE` (its cwd is inside a scope path), `TASK_PATH` (a user
  message names a scope path) or `TASK_NAME` (a user message names a scope directory on its own).
  Other sessions are recorded as `NOT_ALIGNED` and not listed.
- **Change log.** Before the generated block changes, every change is appended to
  `change.log.md` next to the index (or `index.changeLog`): `BASELINE` (the block as found when the
  log was created), `ADDED`, `REPLACED` (original row kept verbatim next to the forward value) and
  `REMOVED` (a row dropped from the block is kept in the log with the reason). Each entry names
  the SHA-256 of the previous entry; the log has a sidecar. Nothing is ever deleted.
- **Reason codes from the records.** A replaced row's reason code is derived by comparing the
  record its old row cites with the new one (`lib/reasons.mjs`): `NEW_EVIDENCE` only when an
  input changed (more rollout records, the Helios ledger or policy, a standing reference, the
  task paths); with the same inputs, `FALSE_VERIFICATION` (a changed producer withdrew a
  `VERIFIED`), `CORRECTED_CLASSIFICATION`, `UNEXPLAINED_CHANGE` (same producer) or `RECAPTURED`;
  also `CORRECTED_PROJECTION` (same inputs and classification, terminal endpoints projected
  differently by a changed producer), `EARLIER_CURSOR`, `RENDERING_CHANGED` and `UNRESOLVED`.
  Each entry names the two records with their full hashes, the rule that derived it (`Derived
  by`, with the rule file's SHA-256) and the complete reason text. When the rule changes, the
  statement in force for each entry (its newest `CORRECTION`'s forward value, else its own) is
  derived again from those two records, each checked against its hash; a rule change alone
  appends nothing, and only a different code or reason gets one `CORRECTION` entry (original:
  code, reason and rule in force; forward: the derived ones). `CORRECTION` entries are never
  evaluated themselves, and a statement whose records are missing or changed is reported, not
  re-derived. The entry itself is kept as written. Rule v5 reads a record's source as the list of
  rollout files it read (`PARTIAL_SOURCE_VIEW` when the newer record skips one the older read) and
  the Helios contract by its files' hashes; for two records that each read one file it gives
  exactly the code and wording of v4, so the rule change re-derives every earlier statement as
  agreeing. An `ADDED`, `REPLACED` or `REMOVED` entry that rested on a record whose acceptance was
  later corrected (the record its evidence names; for a removal, the record the journal had
  accepted at that moment) gets one `CORRECTION` under the continuity rule, naming that record and
  the correction event.
- **Paths: recorded as written, compared by identity** (`lib/paths.mjs`). Records keep the
  rollout path exactly as received (Codex's hook input names it `\\?\C:\Users\...`, manual runs
  `C:/Users/...`) next to its identity (`source.rollout_identity`: extended-length prefix
  removed, win32-normalized, case-folded, e.g. `c:\users\...`); comparisons use the identity
  only.
- **Continuation index.** `index/continuation-index.json` (with a sidecar) records what the block
  was derived from: listed sessions with their record hashes, sessions not listed and why, the
  block and index hashes, the change log head, and an append-only history.
- **Verifier.** `handoff.mjs verify` re-derives all of it: record sidecars and chain tokens, the
  cells each record cites, each record's continuity verdict from the predecessor it names (with
  that record's hash), each `ACCEPTANCE_CORRECTED` event from the two records it names, that
  `latest.json` names the newest accepted record not corrected since, the change log chain and
  sidecar, every reason statement in force under the current rule (failing on one that differs and
  is not yet corrected, or that cannot be re-derived), that every change log entry resting on a
  corrected record has its correction, and whether the index block is still the one the
  continuation index records (it fails if someone edited inside the block). It does not yet
  re-export the rollouts to recompute a record's claims, nor re-read the Helios files a record's
  contract cites.

## Runtime routing (CodeAPI)

A VS Code window's CodeAPI port is not its identity: reopened windows take the next free port, so
a port can belong to another window later. Records therefore keep identity and locator apart.

- **Per call, at capture.** Each CodeAPI response in the session that reports a `codeapiWindowId`
  is an observation of who owned that port at that rollout line (`codeapi_windows`; JSON, escaped
  JSON or PowerShell lists, PTY soft wraps undone; a response whose `serverPort` differs from the
  port addressed is a phantom and is skipped). Each terminal call is bound to the window of the
  nearest preceding observation on its port (`NEAREST_PRECEDING_SESSION_OBSERVATION`); without
  one it stays unbound. Index rows and `handoff.endpoints` group calls by window and terminal and
  show the newest endpoint. Terminal creation is one semantic recipe, `codeapi.terminal.create`,
  in either physical transport (`REST_TERM_CREATE`: `POST /term/create`; `EXTENSION_EXEC_CREATE`:
  `codeApiTerm.create({...})` via `/exec`); the same holds for write, Enter and read.
- **At injection, never stored.** `inject` asks every instance on `127.0.0.1:47337-47400` for
  `/session`, matches each recorded window id and checks the terminal with `/term/list`:
  `CURRENT` (one match: its endpoint, and the terminal alive with its PID, or absent),
  `UNRESOLVED` (no match), `AMBIGUOUS` (several), `IDENTITY_NOT_RECORDED` (an unbound call). An
  unresolved window is reported with its recorded endpoint marked `DO NOT USE AS CURRENT`; the
  recorded port is never offered as current. The block goes ahead of the hand-off text, the
  record is not changed, and `INJECTED` journals both hashes (`rendered_sha256` of the record's
  text, `injected_sha256` of exactly what was injected) and the resolution.
- `handoff.mjs resolve --session-id <id> [--record handoff-NNNN.json]` prints the block for a
  record now; `show ... --live` adds it to a dry run. Settings: `codeapi` in `config.json`
  (`ports`, `timeoutMs`, `enabled`) or `CODEX_HANDOFF_CODEAPI_PORTS` (`47337-47400`, a list, or
  `off`).

## Observed behaviour

- **Compaction** (session 01a0fcec, 2026-10-02): the hand-off was injected after both
  compactions (rollout lines 1797 and 2480), and two store keys were used after a compaction.
- **Resume in a new process** (`codex exec resume`, codex-cli 0.159.0-alpha.12.1, throwaway
  session; `evidence/resume-probe-2026-10-02.json`): the `SessionStart(resume)` hand-off reaches
  the model as a developer message before the user's message, and its bytes hash to the rendered
  SHA-256 that the accepted record and the `INJECTED` event state (VERIFIED: Codex's rollout and
  the hand-off record are independent writers). A value `store()`d before the process exited read
  back `undefined` after it: the code-mode store does not survive a new process, so the storing
  cells the hand-off names are the way back. A new thread gets no hand-off.
- **Compaction with runtime identity** (session 01a0fcec, 2026-10-03 03:41–03:42Z): `PreCompact`
  wrote record 0006, `SessionStart(compact)` injected it within a second with the live block
  (`codeapi:NewSession` in window 8030da57 CURRENT on 47338, PID 96056). Codex continued the chain
  from the predecessor the hand-off named and reused the terminal; its first gate was rejected for
  two base fields the hand-off did not name (`schema_version`, `multi_command`; Helios blocked
  record and ledger DENY 03:43:15Z), which the schema-derived contract now carries.
- **Resume into a new rollout file** (session 01a0fcec, 2026-10-03 16:00:29Z, VS Code): Codex
  continued the thread in `rollout-2026-10-03T12-00-29-…_01a1027e….jsonl`. The hooks read that
  file alone: record 0007 (8 records) and then record 0008 (368 records, before the file's first
  compaction) were accepted and replaced 0006; change log entry 0011 removed the session from the
  index (`NOT_ALIGNED`) and 0012 added it back from the partial record. This is what the thread
  view and the continuity rule above prevent; the records and entries stay as they are, and their
  correction is forward (`reconcile`).
- **Forward repair of that thread** (2026-10-03 17:06Z, `reconcile`;
  `evidence/thread-continuity-2026-10-03.json`): `ACCEPTANCE_CORRECTED` for record 0007 (21 of
  record 0006's primitives missing) and 0008 (18 missing), both `PARTIAL_SOURCE_VIEW`. Record 0009
  read both files (4,183 thread lines) and, against 0006, kept every primitive: 18 preserved, 2
  refreshed (the write-and-Enter and read recipes), 1 superseded (a store key displaced by newer
  ones), none missing. It became the pointer; its recipes are bound to window 8030da57 again.
  Change log entries 0013 and 0014 correct 0011 and 0012, and 0015 replaces the row (0008 → 0009,
  `NEW_EVIDENCE`). `verify`: 54/54.
- **Not tested yet:** resume inside a running VS Code app-server (same process); a snapshot and
  injection by the hooks themselves under the thread view and the continuity rule (the next
  compaction or resume of a thread after 2026-10-03 17:06Z).

## Index document

With `"index": { "path": "<document.md>", "maxSessions": 5 }` in `config.json`, every saved hand-off
also brings a generated block in that document up to date: one row per aligned session (newest
first) with its workspace, its task-path evidence, its newest record and hash, and the terminal
endpoints last seen working with their rollout lines, linked to its `handoff.txt`. Only the text
between these two markers is replaced; the rest of the document stays byte for byte, and nothing
is written when the markers are missing:

```markdown
<!-- codex-handoff:begin (generated by the codex-handoff hooks; edits inside are overwritten) -->
<!-- codex-handoff:end -->
```

Writes take a lock in the state directory and replace files atomically, since two Codex windows
can compact at the same moment. The block holds metadata only: no commands, outputs or message
text. `handoff.mjs index` brings it up to date by hand. As a standing reference, an index with
markers is identified by the hash of its text outside the block, so the hooks' own updates do not
change it.

## Requirements

- Node.js 20 or later.
- A claude-devtools checkout with dependencies installed (`pnpm install`): the session record is
  read by its `scripts/codex-export.ts`, the same reader and normalizer the viewer uses. Codex
  documents its transcript format as unstable; this keeps that dependency in the project whose
  tests track it.
- Helios is optional. Without it the gate section is left out.

## Setup

Clone the repo and create `~/.codex-handoff/config.json`. Two paths have no defaults and must be
set before the hooks can run:

| Setting | Environment variable | What it points to |
|---------|---------------------|-------------------|
| `devtoolsDir` | `CODEX_HANDOFF_DEVTOOLS` | The root of your claude-devtools checkout (the directory that contains `scripts/codex-export.ts` and has `tsx` installed). Without it, exports fail and the hooks cannot read session records. |
| `heliosRoot` | `CODEX_HANDOFF_HELIOS_ROOT` | The `.command-gate` directory of your Helios gate system, if you use one. Without it, the Helios gate contract section is left out of the hand-off (this is safe; set it only if you have a gate system). |

The remaining settings have sensible defaults:

| Setting | Default | What it does |
|---------|---------|--------------|
| `codexHome` / `CODEX_HOME` | `~/.codex` | The Codex data directory whose `sessions/` tree is searched for rollout files. |
| `stateDir` / `CODEX_HANDOFF_STATE` | `~/.codex-handoff` | Where hand-off records, snapshots, and the config are stored. |
| `codeapi.ports` / `CODEX_HANDOFF_CODEAPI_PORTS` | `47337-47400` | The port band scanned for live CODEAPI instances at injection time. Set to `off` if you do not use CODEAPI. |
| `exportTimeoutMs` | `45000` | Timeout for the claude-devtools export of a rollout file. |
| `maxInjectChars` | `7000` | Character limit for the injected text (keeps it under Codex's 2,500-token `additionalContextLimit`). |
| `references` | `[]` | Documents the hand-off points to first (an operational index, for example). |
| `index` | not set | An index document with generated rows; set `path` and optionally `maxSessions`, `changeLog`, `scopePaths`. |

A minimal config that sets only the required paths:

```json
{
  "devtoolsDir": "/home/accountName/claude-devtools",
  "heliosRoot": null
}
```

On Windows the paths are typically:

```json
{
  "devtoolsDir": "C:\\Users\\accountName\\Desktop\\Codex_claude_devtools",
  "heliosRoot": "C:\\Users\\accountName\\Desktop\\MythosJustAFable\\.command-gate"
}
```

## Install

Clone this repo, then add two events inside the `"hooks"` object of `~/.codex/hooks.json`, after
the existing entries (leave those unchanged), and trust the two new hooks in Codex. Replace
`<path-to-codex-handoff>` with the absolute path where you cloned this repo:

```json
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<path-to-codex-handoff>/bin/handoff.mjs\" snapshot",
            "statusMessage": "Saving hand-off before compaction",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "^(compact|resume)$",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<path-to-codex-handoff>/bin/handoff.mjs\" inject",
            "statusMessage": "Restoring hand-off",
            "timeout": 60
          }
        ]
      }
    ]
```

`inject` usually prints a saved snapshot at once; the 60-second timeout covers a rebuild (about
2 seconds for a 12,000-record rollout; 2.3 seconds for thread 01a0fcec's two files, 3,694 + 489
records, Helios contract included).

## State

Per session in `%USERPROFILE%\.codex-handoff\<session_id>\`: `handoff.json` (everything
extracted), `handoff.txt` (the injected text), `terminal-cell.js`, `store-<key>.js`, and
`snapshots.jsonl` (one line per snapshot). Errors go to `%USERPROFILE%\.codex-handoff\errors.log`.
These files hold session content (commands, messages, cell code): treat them like the rollout
itself. Nothing is written to this repository, to claude-devtools or to Helios.

Settings: `%USERPROFILE%\.codex-handoff\config.json` (see [Setup](#setup) for the full table), or
the environment variables `CODEX_HOME`, `CODEX_HANDOFF_STATE`, `CODEX_HANDOFF_DEVTOOLS`,
`CODEX_HANDOFF_HELIOS_ROOT` and `CODEX_HANDOFF_CODEAPI_PORTS`. Environment variables override
config.json, which overrides the defaults. `devtoolsDir` and `heliosRoot` have no defaults and
must be set via config or environment before the hooks can produce a hand-off. A run with
`--state <dir>` uses that directory's `config.json`, so it never reads, or writes the index
configured in, the default state. For example:

```json
{
  "references": [
    { "path": "<path-to-your-index-document>.md", "note": "Map of the operational documents; an index, not a policy source." }
  ]
}
```

## Dry run

```bash
node bin/handoff.mjs show --transcript <rollout.jsonl> --until-line <line of a compaction record> --session-id <thread id>
```

prints the hand-off Codex would have received at that compaction (`--json` for the extracted
data). It reads the whole thread the transcript belongs to; `--until-line` cuts only that
transcript, and files that start after it are left out. Manual `snapshot` / `inject` runs accept
`--transcript`, `--session-id`, `--until-line`, `--source` and `--state <dir>` instead of hook
input; `inject --text` prints plain text instead of the hook JSON. `reconcile --session-id <id>`
is the forward repair described under [Evidence and history](#evidence-and-history).

## Tests

```bash
node bin/inventory.mjs
```

runs `node --test` and writes `evidence/regression-inventory.json` (with the TAP log
`evidence/test-run.tap`, both with sidecars): the counts parsed from the run, whether
`tests == pass + fail + cancelled + skipped + todo` holds, the log's hash, the producer hash and
each test file's hash. Quote the inventory, not a count typed by hand.

The tests include a regression case for each failure the verifier reports (a rewritten record, a
broken chain token, a missing or changed cell, a `latest.json` that is not the newest accepted
record, an edited change log entry, a hand edit inside the index block), for an injected text
that no longer matches its record, and for each reason code.
