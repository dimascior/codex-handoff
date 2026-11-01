# codex-handoff

A persistence system that gives OpenAI Codex (Luna) its working state back after context
compaction or session resume. Without it, Luna hallucinates and runs in circles after three or
four compactions. With it, Luna continues where it was instead of rediscovering how it worked.

Luna is Codex's model, roughly Haiku 5.5 in size, running on a 258k context window. A typical
task compacts 7 to 15 times. Each compaction discards the session's detailed context and replaces
it with a summary. By the third or fourth compaction the model has lost the terminal recipes it
built, the store keys it saved, the sandbox limits it discovered and the task it was given. The
degradation is observable: it repeats steps it already took, invents procedures that do not match
the interfaces it is using, and loses track of what it was asked to do.

codex-handoff solves this by hooking two Codex lifecycle events. A `PreCompact` hook snapshots the
session state from the session record before each compaction. A `SessionStart` hook injects that
snapshot back as developer context (`hookSpecificOutput.additionalContext`) when the compacted or
resumed session continues. The model receives the injected text as a developer message before its
next request, and it carries everything the model needs to continue: what it was asked, where it
stood, the terminal recipes that last worked, its code-mode store keys, the sandbox limits it ran
into, and the gate contract of the command gate system it writes through.

## Architecture

19 library modules under `lib/`, two CLI entry points under `bin/`, and 11 test files under
`test/`. Zero npm dependencies. Every import is Node.js standard library (`node:fs`, `node:path`,
`node:crypto`, `node:child_process`, `node:os`, `node:http`, `node:test`). The one external
dependency is a shell-out to `claude-devtools/scripts/codex-export.ts` via tsx, which reads and
normalizes Codex's session JSONL into a stable `codex-export.v1` schema. codex-handoff never
parses raw rollout JSONL directly.

```
codex-handoff/
├── bin/
│   ├── handoff.mjs       CLI entry: snapshot, inject, show, resolve, index, verify, reconcile
│   └── inventory.mjs     Test runner that writes evidence/regression-inventory.json
├── lib/
│   ├── alignment.mjs     Task-path alignment: WORKSPACE, TASK_PATH, TASK_NAME, NOT_ALIGNED
│   ├── canonical.mjs     Canonical form of extracted data for comparison
│   ├── changelog.mjs     Append-only change log with hash chain and reason codes
│   ├── codeapi.mjs       Runtime routing: discover live CODEAPI windows, match by identity
│   ├── config.mjs        Configuration: env vars > config.json > defaults
│   ├── continuity.mjs    Continuity rule: successor non-regression (source coverage + primitives)
│   ├── evidence.mjs      Claims, authorities, occurrences, recipes, runtime keys, open gaps
│   ├── export.mjs        Shell-out to claude-devtools codex-export.ts
│   ├── extract.mjs       Build the hand-off from a codex-export.v1 document
│   ├── files.mjs         Atomic writes, SHA-256, LF normalization, file locking
│   ├── helios.mjs        Read-only view of the Helios gate contract (schema, policy, manifest)
│   ├── indexblock.mjs    Generated block in an index document, sync and verify
│   ├── paths.mjs         Path identity: extended-length prefix removal, win32 normalization
│   ├── producer.mjs      Producer identity: hash of bin/handoff.mjs and lib/*.mjs
│   ├── reasons.mjs       Reason codes for replaced change log rows
│   ├── records.mjs       Hand-off records: append, read, accept, verify, hash chain
│   ├── references.mjs    Standing references: SHA-256 and mtime of configured documents
│   ├── render.mjs        Render hand-off text from extracted data (the injected string)
│   └── thread.mjs        Thread-level reading: find all rollout files, merge across resumes
├── test/                 11 test files covering every module; node --test
├── package.json          Node 20+, MIT license, zero dependencies
├── LICENSE.md            MIT
└── .gitignore
```

## What codex-handoff is preserving

The hand-off exists because Luna builds working procedures during a session and loses them at
compaction. These are the patterns it builds and the systems it builds them against.

### CODEAPI terminal pattern

CODEAPI is a VS Code extension that exposes an HTTP API on loopback for driving real PTY
terminals. Luna uses it to run shell commands in a specific VS Code window. The full cycle:

1. **Discover** every CODEAPI runtime on ports 47337-47400 (`GET /session` on each).
2. **Select** the target window by its `codeapiWindowId` (a durable UUID the extension persists
   in `workspaceState`), not by port. Ports drift as windows reopen; a port is a transport handle,
   not identity. Selection precedence: `codeapiRuntimeId` > `vscodeSessionId` >
   `codeapiWindowId` > `extensionHostPid` > `workspaceUri` > `serverPort`.
3. **Create** a visible terminal: `POST /term/create {"shell":"powershell.exe","show":true}` on
   the selected window's port. Returns `{id, shell, cwd, pid}`. The terminal appears in the VS
   Code window as `codeapi:<id>`.
4. **Write** a command: `POST /term/<id>/write {"data":"git status","enter":true}`. Returns
   `{wrote: N}` — bytes accepted, not success.
5. **Read** the output: `GET /term/<id>/read`. Returns the raw ANSI/VT screen buffer. Parse after
   the command echo; strip ANSI codes.
6. **Observe exit**: poll `GET /term/list` until `alive:false` and an integer `exitCode`. Liveness
   comes from node-pty's `onExit`, never from `DELETE`.
7. **Reap**: `DELETE /term/<id>`. Buffers may hold secrets.

Luna builds these calls in two physical transports: the REST `/term/*` routes (`REST_TERM_CREATE`,
`REST_TERM_WRITE`, `REST_TERM_READ`) or the JS bridge posted to `/exec`
(`codeApiTerm.create({...})`, `codeApiTerm.write("<id>", ...)`, `codeApiTerm.read("<id>")`). Both
transports hit the same backend. The hand-off captures the newest working call of each kind as a
semantic recipe (`codeapi.terminal.create`, `codeapi.terminal.write_and_enter`,
`codeapi.terminal.read`), bound to the CODEAPI window where it worked. The whole code cell that
last wrote to the terminal is saved as `terminal-cell.js` — it typically contains the
gate-writing, SHA hashing and chain-predecessor helpers Luna built during the session.

At injection, codex-handoff resolves the current endpoint of each recorded window by scanning the
port band live. It never falls back to the recorded port.

### Helios gate pattern

Helios is a command gate system. Every shell command Luna executes goes through a gate file: a
JSON document in `.command-gate/pending/` that declares the command, its SHA-256, its risk tier,
its segments, what it reads and writes, and why it is needed. The interaction cycle:

1. Luna writes a gate file with a **placeholder SHA-256** (it cannot compute the hash before
   writing the file).
2. Helios's PreToolUse hook rejects the command and returns the **correct SHA-256** in the
   rejection message.
3. Luna edits the gate file to insert the correct SHA-256.
4. Luna retries the command. Helios validates the gate and allows execution.

This round-trip happens for every shell command. Read, Grep and Glob operations bypass the gate
system entirely — they use dedicated tools that do not trigger the PreToolUse hook.

The gate contract the hand-off carries is read live from Helios at snapshot time:
- **Base fields** (`schema.sections.fields.required_base_fields`): the fields every gate needs,
  regardless of tier (`schema_version`, `correlation_id`, `created_utc`, `expires_utc`, `command`,
  `command_sha256`, `working_directory`, `shell`, `risk_tier`, `multi_command`, `segments`,
  `exit_capture`, `exit_capture_reason`, `need`, `expected`, `actual_means`, `next_logic`,
  `approval_boundary`, `read_write_impact`, `previous_correlation_id`).
- **Tier fields** (`policy.tier_required_fields`): fields a specific tier adds (e.g. tier 3
  requires `stop_conditions`).
- **Effective fields** per tier: the union of base and tier fields (`DERIVED`).
- **Fixed values**: values the schema mandates (e.g. `schema_version` must be exactly
  `"command-gate.v1"`), with VERIFIED status when a gate Helios accepted carries the same value.
- **Chain predecessor**: the session's last executed correlation id from the Helios session
  ledger, so Luna can set `previous_correlation_id` correctly.

codex-handoff keeps no list of gate fields itself. A field added to the schema appears in the next
hand-off. When the schema or policy cannot be read, the hand-off says so instead of filling in
stale values.

### Code-mode store pattern

Codex's code-mode sandbox has a `store(key, value)` / `load(key)` API. Luna uses it to persist
values across code cells within a session (SHA-256 helper functions, terminal recipes, computed
hashes). The store does not survive a new process: after a `codex exec resume`, `load()` returns
`undefined` for every key. The hand-off captures each store key with its storing cell so Luna can
re-run the cell to restore the value.

### Sandbox limits pattern

Luna's code-mode sandbox lacks certain globals. When it hits a `ReferenceError` (e.g. `crypto is
not defined`) or a `typeof` probe returns `"undefined"`, that is a discovered sandbox limit. The
hand-off carries these so Luna does not rediscover them by trial and error after compaction.

## The two hooks

| Hook | Command | What it does |
|------|---------|--------------|
| `PreCompact` | `handoff.mjs snapshot` | Reads the session record through claude-devtools (every rollout file of the thread), builds the hand-off and saves it as an immutable record. Prints nothing and always exits 0, so it never blocks a compaction. |
| `SessionStart` (matcher `^(compact\|resume)$`) | `handoff.mjs inject` | Prints the hand-off as `hookSpecificOutput.additionalContext` JSON. Codex adds it as developer context before the next model request. After a compaction it prints the snapshot taken just before; on resume it rebuilds one from the full thread. Ahead of the hand-off text goes a live routing block resolved at that moment from running CODEAPI instances. |

Why two events and not one: `PreCompact` runs at the right moment to read the session record but
cannot add context. Neither can `PostCompact`. For both events Codex ignores plain stdout and
their JSON response takes only `continue`, `stopReason`, `systemMessage` (a UI warning) and
`suppressOutput`. The `SessionStart` hook matching `compact` runs once a root session has been
compacted, ahead of the next model request. When an automatic compaction happens mid-turn, the
injected context reaches the request that continues that turn.

`developer_instructions` in `config.toml` is the other channel that survives compaction. Codex
re-sends its developer-role setup after every compaction (observed in all eight compactions of a
2026-09-30 session). It is static text, the same for every session that loads that config, so it
suits standing policy ("reuse what the hand-off lists before rebuilding a procedure") but not
session state. Subagent compactions are not covered: Codex only promises `SessionStart(compact)`
for root sessions.

## What the hand-off contains

Everything comes from what the session recorded. A terminal call counts as working only if the
code cell that ran it completed without a script error, a non-zero exit code or a `wrote 0`
reply.

- **Standing references** (first): documents listed under `references` in `config.json`, such as
  an operational index, with each file's SHA-256 and modification time at snapshot time so the
  model can tell whether it changed. Read-only; the files themselves are never modified.
- **Task**: the last three user messages, with the paths of pasted files (re-read them for the
  full request).
- **Position**: the model's last three messages and what the last code cell returned.
- **Terminal recipes**: the newest working CODEAPI PTY calls for writing text, sending Enter and
  reading the buffer, and the whole code cell that last wrote to the terminal (saved as
  `terminal-cell.js`; it holds the gate-writing, hashing and chaining helpers the model built).
- **Code-mode store**: keys passed to `store()` / `load()`, how they were used, and the cell that
  stored each one (saved as `store-<key>.js`, to re-run if `load()` comes back empty after a
  restart). The code-mode store does not survive a new process, so these cells are the way back.
- **Sandbox limits**: globals the code-mode sandbox lacked (`ReferenceError`s and `typeof` probes
  that returned `"undefined"`).
- **Helios gate contract** (optional), read live from the Helios command gate system
  (`lib/helios.mjs`): the base fields every gate needs (`schema.sections.fields.required_base_fields`),
  the fields each tier adds (`policy.tier_required_fields`), their union per tier (`DERIVED`),
  fixed values the schema declares, boolean field meanings, and the chain predecessor (the
  session's last executed correlation id from the Helios session ledger). codex-handoff keeps no
  list of fields itself: a field added to the schema appears in the next hand-off, and when the
  schema cannot be read the hand-off says so instead of filling one in. The schema and policy are
  identified by the SHA-256 of their raw bytes and compared with the pins in Helios's integrity
  manifest.

The injected text stays under `maxInjectChars` (7,000 characters by default, about 2,333 tokens
at 3 characters per token) so Codex keeps it inline. Above its `additionalContextLimit` (2,500
tokens by default) Codex saves it to a file and injects only a preview, which defeats the purpose.

## Thread, not file

The unit of continuity is the Codex thread (the id its `session_meta` declares), not one rollout
file. A resume can continue a thread in a new file,
`rollout-<time>-<thread>_<segment>.jsonl`, which holds only what happened after the resume. This
was observed on 2026-10-03 when thread 01a0fcec was resumed into such a file: the hooks read only
that file (8 records) and the hand-off they injected had lost the terminal recipes, store keys,
sandbox limits and task of the 3,694 records before it.

Every snapshot therefore reads the whole thread (`lib/thread.mjs`): the rollout files under
`$CODEX_HOME/sessions/YYYY/MM/DD/` whose name contains the thread id (a pre-filter only), each
exported through claude-devtools and kept only if its export declares the thread id, ordered by
first record, up to and including the file the hook named. They are merged into one document whose
line numbers are thread lines (`line_offset` of the file + the line in it), so "which observation
precedes which call" stays right across files. The record keeps the files it read in
`source.segments` (path, identity, offset, records read, first and last record time) and the ones
it left out in `source.excluded` (another thread, export failed, starts after the transcript); a
thread kept in one file has one segment at offset 0, so its lines are its file lines. The hand-off
text cites lines as `rollout K line N` when a thread spans several files.

## Evidence and history

The state follows append-only evidence conventions: records are never rewritten, each claim cites
what it rests on, and history is appended, not replaced.

### Hand-off records

Every saved hand-off is an immutable record, `<session>/records/handoff-NNNN.json`
(`codex-handoff-record.v3`: the thread's rollout files in `source.segments`, and the continuity
verdict below; v1 and v2 records stay valid). It names its predecessor (`continuation_from`) and
carries the SHA-256 of the predecessor's LF-normalized bytes (`continuation_token_sha256`), with a
`"<hash>  <name>"` sidecar file. One record is one snapshot generation (`snapshot`: rollout
cursor, last record time, compactions so far) and names the code that wrote it (`producer`: hash
of `bin/handoff.mjs` and `lib/*.mjs`). Cell sources it cites are stored once under their own hash
in `cells/`. `handoff.txt`, `handoff.json` and the `terminal-cell.js` / `store-*.js` files remain
the current-state copies the hooks read.

### Authority model

Each claim carries an authority:
- `DECLARED`: the user's task, the model's own messages
- `OBSERVED`: a cell result, a ledger entry
- `VERIFIED`: confirmed by an independent witness (Codex's rollout and the hand-off record are
  independent writers; a value is verified when both agree)
- `DERIVED`: computed from declared and observed facts (the gate contract's effective fields)
- `SEMANTIC`: a recipe (what a terminal call does, abstracted from the physical transport)
- `RUNTIME_STATE`: terminal id and address, recheck before reuse

Each claim also carries a currency (`CURRENT_AT_SNAPSHOT`, `DURABLE_UNTIL_INTERFACE_CHANGE`,
`REVALIDATE_AFTER_RESUME`) and typed provenance (rollout line, cell id and hash, ledger
correlation). Physical `occurrences` (one per cell execution, identified by its content) come
first; `recipes` only refer to them. Each `runtime_keys` entry gives the restore expression, the
storing cell and whether re-running it is safe, and what the record shows about persistence
(`after_compaction` is `OBSERVED` only when a cell using the key completed after a compaction).
Values nobody captured keep their reason (`NOT_CAPTURED_BY_PRODUCER`, `EXPECTED_NOT_CAPTURED`,
`UNRESOLVED`, `UNKNOWN`), and `open_gaps` lists what the hooks cannot establish, with its owner.

### Accepted, not newest

`latest.json` moves only to a record that passed its integrity checks (sidecar, predecessor
binding, schema, every cited cell present with its hash) and says so (`status: ACCEPTED`,
verifier, prior). `lifecycle.jsonl` journals each step: `CAPTURED`, `ACCEPTED`, `RETAINED` or
`REJECTED`, `SUPERSEDED`, `INJECTED` (with the hash of the injected text) or `NOT_INJECTED`
(with the reason), and `ACCEPTANCE_CORRECTED` (below).

### Continuity rule

Integrity is not continuity (`lib/continuity.mjs`). A hash chain proves a record follows its
predecessor unaltered, not that it carries what its predecessor carried. A record becomes the
pointer only when it also:

1. **Covers the predecessor's source**: every rollout file the accepted record read is read again,
   at least as far. Otherwise it is a `PARTIAL_SOURCE_VIEW` of the thread.
2. **Keeps each recoverable primitive**: terminal recipes, CODEAPI windows, store keys, sandbox
   limits, task-path alignment. Each must be: `PRESERVED` (observed again), `REFRESHED` (a newer
   occurrence of the same identity) or `SUPERSEDED` (replaced by a newer one of its kind, e.g. a
   store key displaced by newer ones, shown by `storeTotal`). An absent primitive is `MISSING`,
   never taken to mean it ceased to exist.

Either failure makes the verdict `CONTINUITY_REGRESSION`: the record is kept as evidence
(`RETAINED`) and the pointer, `handoff.txt`, `handoff.json` and the cell copies stay on the
accepted hand-off. A session start whose snapshot is retained injects the accepted hand-off,
prefixed with one line saying which snapshot was not used and why. Runtime values (ports, PIDs,
liveness) are not primitives: they are resolved again at injection.

### Forward repair

`handoff.mjs reconcile --session-id <id> [--transcript <rollout>]` corrects records that were
accepted under earlier checks although they did not read what the record before them read: each
gets one `ACCEPTANCE_CORRECTED` event (record and predecessor with their hashes, the coverage
detail, the rule). The journal is only appended to. The pointer stands for the newest accepted
record not corrected since. Then a snapshot is taken from the whole thread and the index is brought
up to date.

### Task-path alignment

The index's task paths are the ones it declares on its `**Scope checked:**` line (or
`index.scopePaths` in `config.json`). A session is listed only when its records show work there:
`WORKSPACE` (its cwd is inside a scope path), `TASK_PATH` (a user message names a scope path) or
`TASK_NAME` (a user message names a scope directory on its own). Other sessions are recorded as
`NOT_ALIGNED` and not listed.

### Change log

Before the generated block changes, every change is appended to `change.log.md` next to the index
(or `index.changeLog`): `BASELINE`, `ADDED`, `REPLACED` (original row kept verbatim next to the
forward value) and `REMOVED` (a row dropped from the block is kept in the log with the reason).
Each entry names the SHA-256 of the previous entry; the log has a sidecar. Nothing is ever
deleted. A replaced row's reason code is derived by comparing the records (`lib/reasons.mjs`):
`NEW_EVIDENCE` only when an input changed (more rollout records, the Helios ledger, a standing
reference, the task paths); with the same inputs, `FALSE_VERIFICATION`, `CORRECTED_CLASSIFICATION`,
`UNEXPLAINED_CHANGE`, `RECAPTURED`, `CORRECTED_PROJECTION`, `EARLIER_CURSOR`, `RENDERING_CHANGED`
or `UNRESOLVED`.

### Paths

Records keep the rollout path exactly as received (Codex's hook input names it
`\\?\C:\Users\...`, manual runs `C:/Users/...`) next to its identity
(`source.rollout_identity`: extended-length prefix removed, win32-normalized, case-folded, e.g.
`c:\users\...`); comparisons use the identity only (`lib/paths.mjs`).

### Verifier

`handoff.mjs verify` re-derives all of it: record sidecars and chain tokens, the cells each
record cites, each record's continuity verdict from the predecessor it names, each
`ACCEPTANCE_CORRECTED` event from the two records it names, that `latest.json` names the newest
accepted record not corrected since, the change log chain and sidecar, every reason statement in
force under the current rule, and whether the index block is still the one the continuation index
records.

## Runtime routing (CODEAPI)

A VS Code window's CODEAPI port is not its identity: reopened windows take the next free port, so
a port can belong to another window later. Records therefore keep identity and locator apart.

### At capture

Each CODEAPI response in the session that reports a `codeapiWindowId` is an observation of who
owned that port at that rollout line (`codeapi_windows`; JSON, escaped JSON or PowerShell lists,
PTY soft wraps undone; a response whose `serverPort` differs from the port addressed is a phantom
and is skipped). Each terminal call is bound to the window of the nearest preceding observation on
its port (`NEAREST_PRECEDING_SESSION_OBSERVATION`); without one it stays unbound. Terminal
creation is one semantic recipe, `codeapi.terminal.create`, in either physical transport
(`REST_TERM_CREATE`: `POST /term/create`; `EXTENSION_EXEC_CREATE`: `codeApiTerm.create({...})`
via `/exec`); the same holds for write, Enter and read.

### At injection (resolved live, never stored)

`inject` asks every CODEAPI instance on `127.0.0.1:47337-47400` for `/session`, matches each
recorded window id and checks the terminal with `/term/list`:
- `CURRENT`: one match, its endpoint, and the terminal alive with its PID (or absent)
- `UNRESOLVED`: no match; the recorded endpoint is marked `DO NOT USE AS CURRENT`
- `AMBIGUOUS`: several matches; check `/session` before using any of them
- `IDENTITY_NOT_RECORDED`: the session recorded no window identity for that terminal

The recorded port is never offered as current. The routing block goes ahead of the hand-off text,
the record is not changed, and `INJECTED` journals both hashes (`rendered_sha256` of the record's
text, `injected_sha256` of exactly what was injected) and the resolution.

## Observed behaviour

- **Compaction** (session 01a0fcec, 2026-10-02): the hand-off was injected after both compactions
  (rollout lines 1797 and 2480), and two store keys were used after a compaction.
- **Resume in a new process** (`codex exec resume`, codex-cli 0.159.0-alpha.12.1): the
  `SessionStart(resume)` hand-off reaches the model as a developer message before the user's
  message, and its bytes hash to the rendered SHA-256 that the accepted record and the `INJECTED`
  event state (VERIFIED: Codex's rollout and the hand-off record are independent writers). A value
  `store()`d before the process exited read back `undefined` after it: the code-mode store does
  not survive a new process, so the storing cells the hand-off names are the way back.
- **Compaction with runtime identity** (session 01a0fcec, 2026-10-03 03:41-03:42Z): `PreCompact`
  wrote record 0006, `SessionStart(compact)` injected it within a second with the live routing
  block (`codeapi:NewSession` in window 8030da57 CURRENT on port 47338, PID 96056). The model
  continued the chain from the predecessor the hand-off named and reused the terminal. Its first
  gate was rejected for two base fields the hand-off did not name (`schema_version`,
  `multi_command`), which the schema-derived contract now carries.
- **Resume into a new rollout file** (session 01a0fcec, 2026-10-03 16:00:29Z): the model
  continued the thread in a new file. The hooks read only that file: record 0007 (8 records) and
  then record 0008 (368 records) were accepted and replaced 0006. This is what the thread view and
  the continuity rule prevent: a partial view that lost 21 of the predecessor's primitives.
- **Forward repair** (2026-10-03 17:06Z, `reconcile`): `ACCEPTANCE_CORRECTED` for records 0007
  (21 of record 0006's primitives missing) and 0008 (18 missing), both `PARTIAL_SOURCE_VIEW`.
  Record 0009 read both files (4,183 thread lines) and, against 0006, kept every primitive: 18
  preserved, 2 refreshed (the write-and-Enter and read recipes), 1 superseded (a store key
  displaced by newer ones), none missing. It became the pointer. `verify`: 54/54.

## Index document

With `"index": { "path": "<document.md>", "maxSessions": 5 }` in `config.json`, every saved
hand-off also brings a generated block in that document up to date: one row per aligned session
(newest first) with its workspace, its task-path evidence, its newest record and hash, and the
terminal endpoints last seen working. Only the text between these two markers is replaced:

```markdown
<!-- codex-handoff:begin (generated by the codex-handoff hooks; edits inside are overwritten) -->
<!-- codex-handoff:end -->
```

Writes take a lock in the state directory and replace files atomically, since two Codex windows
can compact at the same moment. `handoff.mjs index` brings it up to date by hand.

## Dependencies

codex-handoff does not run in isolation. It reads session records through claude-devtools, resolves
terminal endpoints through CODEAPI, and reads the gate contract from Helios. Each dependency is a
separate repo that must be cloned and configured before the corresponding feature works.

### Required

| Dependency | Repo | What codex-handoff uses it for |
|-----------|------|-------------------------------|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) | Runtime. codex-handoff is pure ESM with zero npm dependencies; Node's standard library is all it imports. |
| **OpenAI Codex** | [openai.com/codex](https://openai.com/index/introducing-codex/) | The platform. codex-handoff hooks into Codex's `PreCompact` and `SessionStart` lifecycle events via `~/.codex/hooks.json`. Codex provides the session rollout files (`~/.codex/sessions/`) and the `hookSpecificOutput.additionalContext` injection channel. Requires the Codex CLI (`codex-cli`). |
| **Codex_claude_devtools** | [github.com/dimascior/Codex_claude_devtools](https://github.com/dimascior/Codex_claude_devtools) | Session record reader. codex-handoff shells out to `scripts/codex-export.ts` (run via tsx) to read and normalize Codex's session JSONL into a stable `codex-export.v1` schema. Codex documents its transcript format as unstable; the export script is the same reader and normalizer the devtools viewer uses, so this keeps the raw-format dependency in the project whose tests track it. Clone and run `pnpm install` so tsx and the export script are available. Set `devtoolsDir` in config to point to the checkout root. |

### Optional

| Dependency | Repo | What codex-handoff uses it for | What happens without it |
|-----------|------|-------------------------------|------------------------|
| **CODEAPI** | [github.com/dimascior/CODEAPI](https://github.com/dimascior/CODEAPI) | Terminal routing. At injection time, codex-handoff scans ports 47337-47400 for running CODEAPI instances, matches each recorded `codeapiWindowId` against live `/session` responses, and checks terminal liveness via `/term/list`. This tells the model which endpoint to use right now, instead of reusing a stale port from the record. CODEAPI is a VS Code extension that exposes an HTTP API on loopback for terminal control: create visible PTY terminals, write commands, read screen buffers, observe exit. | Terminal routing is skipped. The hand-off still carries the terminal recipes and recorded endpoints, but without the live routing block the model must rediscover which port its window is on. Set `codeapi.enabled` to `false` or `CODEX_HANDOFF_CODEAPI_PORTS` to `off`. |
| **Helios** | [github.com/dimascior/Helios-](https://github.com/dimascior/Helios-) | Gate contract. codex-handoff reads the Helios gate schema, policy, and integrity manifest from the `.command-gate` directory to build the gate contract section of the hand-off. This tells the model which fields every gate needs at each tier, which values the schema fixes, and what the chain predecessor is (so it can set `previous_correlation_id` correctly). Helios is the PreToolUse gated execution policy layer that sits in front of Bash and PowerShell commands and enforces explicit intent at command time. | The gate contract section is left out of the hand-off. The model must rediscover the gate fields by reading the schema or by trial and error. Set `heliosRoot` to `null`. |
| **Akashic** | [github.com/dimascior/Akashic](https://github.com/dimascior/Akashic) | Not used directly by codex-handoff. Akashic is the oversight, validation, installer, and trust witness layer around Helios. It prepares, installs, activates, validates, rebaselines, restores, and audits the Helios runtime. If you use Helios, Akashic is how the Helios runtime gets installed and validated against the trusted manifest. | No effect on codex-handoff. Akashic matters for Helios installation, not for the hand-off. |

### Dependency graph

```
codex-handoff
  ├── [required] Codex CLI (the platform; provides hooks.json and session rollouts)
  ├── [required] Codex_claude_devtools (session record export via codex-export.ts)
  ├── [optional] CODEAPI (live terminal endpoint resolution at injection)
  └── [optional] Helios (gate contract: schema, policy, chain predecessor)
                   └── [optional] Akashic (installs and validates the Helios runtime)
```

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
| `references` | `[]` | Documents the hand-off points to first (an operational index, for example). Each is `{ "path": "<absolute path>", "note": "..." }`. |
| `index` | not set | An index document with generated rows; set `path` and optionally `maxSessions`, `changeLog`, `scopePaths`. |

A minimal config that sets only the required path (without Helios):

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

A fuller config with standing references, an index, and CODEAPI:

```json
{
  "devtoolsDir": "C:\\Users\\accountName\\Desktop\\Codex_claude_devtools",
  "heliosRoot": "C:\\Users\\accountName\\Desktop\\MythosJustAFable\\.command-gate",
  "references": [
    { "path": "C:\\Users\\accountName\\Desktop\\Operational-Index.md", "note": "Map of operational documents." }
  ],
  "index": {
    "path": "C:\\Users\\accountName\\Desktop\\Operational-Index.md",
    "maxSessions": 5,
    "scopePaths": [
      "C:\\Users\\accountName\\Desktop\\CODEAPI",
      "C:\\Users\\accountName\\Desktop\\HeliosEvidenceCatalog"
    ]
  },
  "codeapi": {
    "ports": "47337-47400",
    "timeoutMs": 1500,
    "enabled": true
  }
}
```

Environment variables override config.json, which overrides the defaults.

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
2 seconds for a 12,000-record rollout; 2.3 seconds for two files totalling 4,183 thread lines
with the Helios contract included).

## State

Per session in `~/.codex-handoff/<session_id>/`: `handoff.json` (everything extracted),
`handoff.txt` (the injected text), `terminal-cell.js`, `store-<key>.js`, and `snapshots.jsonl`
(one line per snapshot). Errors go to `~/.codex-handoff/errors.log`. These files hold session
content (commands, messages, cell code): treat them like the rollout itself. Nothing is written to
this repository, to claude-devtools or to Helios.

## CLI reference

| Command | What it does |
|---------|-------------|
| `snapshot` | PreCompact hook. Reads session from stdin, builds and saves the hand-off. Always exits 0. |
| `inject` | SessionStart hook. Prints the hand-off as `additionalContext` JSON. `--text` prints plain text. |
| `show --transcript <file> [--until-line N] [--session-id ID]` | Dry run: prints the hand-off without writing. `--json` for the extracted data. `--live` adds the CODEAPI routing block. |
| `resolve --session-id <id> [--record handoff-NNNN.json]` | Prints the live CODEAPI routing block for a session's accepted record. |
| `index` | Rewrites the generated block of the configured index document from the saved hand-offs. |
| `verify` | Re-derives and checks all records, chain tokens, cells, continuity verdicts, change log entries, and reason codes. |
| `reconcile --session-id <id> [--transcript <file>]` | Forward repair: corrects records accepted under earlier checks, takes a new snapshot from the whole thread, updates the index. |

All commands accept `--state <dir>` to use an alternate state directory (with its own
`config.json`), `--transcript`, `--session-id`, `--until-line`, and `--source`.

## Dry run

```bash
node bin/handoff.mjs show --transcript <rollout.jsonl> --until-line <line> --session-id <thread>
```

prints the hand-off the model would have received at that compaction. It reads the whole thread
the transcript belongs to; `--until-line` cuts only that transcript, and files that start after it
are left out.

## Tests

```bash
node --test
```

or with evidence output:

```bash
node bin/inventory.mjs
```

which runs the tests and writes `evidence/regression-inventory.json` (with a TAP log and
sidecars). The tests cover every module: record integrity (rewritten records, broken chain tokens,
missing cells), continuity verdicts (PRESERVED, REFRESHED, SUPERSEDED, MISSING), change log
entries and reason codes, CODEAPI runtime routing (CURRENT, UNRESOLVED, AMBIGUOUS), path identity
normalization, thread merging across files, resume behaviour, and injected text verification.

## License

MIT. See [LICENSE.md](LICENSE.md).
