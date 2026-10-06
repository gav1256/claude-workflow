# Codex dual-brain: design addendum (Task 2) — processes, records, quarantine

Plan: `docs/plans/2026-10-06-codex-dual.md` (Task 2 checklist, Tasks 5 and 9). Spec: Part 2 step 1, spec:160-214.
Evidence: Task 1 probe P4 plus the timing probes below (2026-10-06, codex 0.160.0, non-elevated shell). This file is
binding for Tasks 5 and 9. Where it differs from the plan text, the "Plan amendments" section says so; the addendum
wins.

Names used below: `S` = the Windows session id of the running script; `WTP`/`SP` = worktree/slot pipe; `WTR`/`SR` =
worktree/slot record; `TMP` = `<cwd>\.codex-tmp`; "own children" = processes the script spawned and still has
`ChildProcess` objects for.

## 1. Evidence

| Lister (run from node, one PowerShell spawn incl. ~0.5 s start-up) | Time | Sees the sandbox user? |
|---|---|---|
| CIM `Win32_Process` alone (pid, ppid, name, cmd, session, creation) | 0.3 s in PS | no (GetOwner fails for sandbox users, P4) |
| `tasklist /V /FO CSV /NH` (all sessions) | 29.2-31.3 s (3 runs) | yes: `HOST\CodexSandboxOffline` |
| `tasklist /FI "USERNAME eq HOST\CodexSandboxOffline" /FO CSV /NH` | 29.3 s | yes, but one user per call, no ppid |
| `tasklist /FO CSV /NH` (no `/V`) | 0.8 s | no user column |
| `tasklist /V /FO CSV /NH /FI "SESSION eq 1"` | 2.2 s alone | yes, user column filled |
| **CIM + `tasklist /V /FI "SESSION eq S"`**, one PS script, from node | **3.3-4.8 s** (6 runs) | **yes, all 3 sandbox rows** |
| **CIM + `tasklist /V` (all sessions)**, one PS script, from node | **29.2-31.3 s** | yes |
| CIM single pid `CreationDate` (`startTime`) | 0.63-0.80 s | n/a |

The `/V` cost is in session 0 (services); filtering to the script's session removes it. With a sandboxed
`PING -n 240` alive, the sandboxed tree was `codex.exe` (user, session 1) → `codex-command-runner-0.160.0.exe`
(sandbox user, session 1, ppid = codex.exe) → `PING.EXE` → `conhost.exe`, all three sandbox rows in session 1 with
owner `HOST\CodexSandboxOffline`; `codex-windows-sandbox-service.exe` runs in session 0 with user `N/A`.
`taskkill /T /F /PID <codex.exe>` from the non-elevated user killed all sandbox-user rows.

Detached-grandchild probe: a node child spawns a grandchild; the test kills the child with `process.kill`. Grandchild
spawned non-detached: dead (libuv puts non-detached children in a kill-on-close job). Spawned `detached:true,
windowsHide:true, stdio:"ignore"`: alive, `MainWindowHandle` 0 (no window), `taskkill /T /F` ends it. libuv's job has
`SILENT_BREAKAWAY_OK`, so in production killing `codex-run` kills `codex.exe` (direct child) while `codex.exe`'s
children (runner, sandbox processes) survive. That matches the spec:176-180 probe.

## 2. The lister (`lib/procs.mjs`)

### 2.1 Two scopes, chosen by cost

- `scope:"session"` (3.3-4.8 s): CIM for all processes + `tasklist /V` for session `S` only. Used on every run that
  spawned something: the end-of-run orphan check (A4b, section 6) and the lister probe (section 2.6).
- `scope:"full"` (about 30 s): CIM + `tasklist /V` for all sessions. Used only (1) for a quarantine decision on a
  record that is not clean and passed every static check (section 4.3), and (2) by `--clear-quarantine` (section 5).
  It never runs on the happy path.

Session `S` is enough at the end of a run because sandboxed processes inherit the token's session from
`codex.exe` (session `S`); a process cannot move to another session without `SeTcbPrivilege`. The full scope is used
for auto-clear so that the proof does not rely on that.

### 2.2 The command

`spawnSync(PS, ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand", b64], {encoding:"utf8",
windowsHide:true, timeout: scope==="full" ? 120000 : 60000, maxBuffer: 64*1024*1024})` where
`PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")`
and `b64 = Buffer.from(script, "utf16le").toString("base64")`. `script` is exactly (first line set per call):

```powershell
$scope = 'session'
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$s = (Get-Process -Id $PID).SessionId
$cim = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,SessionId,CreationDate |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name;
    cmd = $_.CommandLine; session = $_.SessionId;
    start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } })
$tlArgs = @('/V','/FO','CSV','/NH')
if ($scope -eq 'session') { $tlArgs += @('/FI', "SESSION eq $s") }
$tl = & (Join-Path $env:SystemRoot 'System32\tasklist.exe') @tlArgs
$code = $LASTEXITCODE
[pscustomobject]@{ session = $s; tlExit = $code; cim = $cim; tasklist = ($tl -join "`n") } | ConvertTo-Json -Compress -Depth 4
```

Notes: `$ProgressPreference` must be silenced (otherwise CLIXML progress records go to stderr). Build the script in JS
with `String.raw` or forward slashes; a template literal that contains `\t` turns `\tasklist` into a tab (seen in the
probe). The JSON is about 100 KB.

### 2.3 The parse: `parseListing(stdout, scope, { selfPid, listerPid })` (pure, exported)

1. `JSON.parse(stdout)`; failure → `{ok:false, error:"lister-output"}`. `tlExit !== 0` → `{ok:false,
   error:"tasklist-exit-<n>"}`.
2. `tasklist` text: split on `\n`, trim `\r`, drop empty lines. A line starting with `INFO:` means zero rows. Each
   other line: fields = `[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'))`; exactly 9 fields
   required (Image, PID, Session Name, Session#, Mem, Status, User, CPU, Title), else `{ok:false,
   error:"tasklist-parse"}`. `user` = field 6 if it contains a backslash, else `null` (covers `N/A` in any locale).
3. Merge by pid. For each CIM row: tasklist row with the same pid and the same name (case-insensitive) → `user` from it;
   same pid, different name (pid reused between the two calls) → `user:null`; no tasklist row → `user:null`.
   Tasklist rows with no CIM row (started after the CIM call) are added as `{pid, ppid:null, name, user, cmd:null,
   session:Number(field 3), start:null}`.
4. Row shape: `{ pid:number, ppid:number|null, name:string, user:string|null, cmd:string|null, session:number|null,
   start:string|null }`. `start` is CIM's UTC `'o'` format (`2026-10-06T20:16:48.9944180Z`); compare times with
   `Date.parse` (it accepts 7 fractional digits; NaN counts as `null`).
5. Positivity check (real lister only): the row for `selfPid` (node's `process.pid`) must exist with a non-null
   `user`; otherwise `{ok:false, error:"self-not-visible"}`. This proves the owner column is populated.
6. Result `{ ok:true, scope, rows, listerPid }`; `listerPid` = `spawnSync(...).pid`. A spawn error or timeout →
   `{ok:false, error:"lister-spawn"|"lister-timeout"}`.

### 2.4 Exports (supersede the plan's `procs.mjs` block)

```js
export const LISTER_PROBE;  // path.join(STATE, "lister-probe.json"): {version, ok, at}
export function listProcs({ scope = "session", maxAgeMs = 0 } = {}): { ok, scope, rows, listerPid?, error? };
  // CODEX_RUN_PROCS set → the fixture (section 8). maxAgeMs > 0 → reuse a cached listing of the same or wider scope
  // younger than that (module-level cache; quarantine calls pass 120000 so one invocation lists "full" at most once
  // for the worktree and up to 3 slots).
export function parseListing(stdout, scope, { selfPid, listerPid }): Listing;   // pure, section 2.3
export function isSandboxed(row): boolean;   // section 3.1
export function procFindings({ rec, rows, selfPid, listerPid, runId, mode }): Array<{ pid, why, text }>;  // section 3
export function startTime(pid): string|null; // CIM CreationDate, 'o' UTC; pid must be a positive integer
export function killTree(pid): { ok: boolean, out: string };  // taskkill /T /F /PID; "not found" (exit 128) → ok:true
export function listerVerified(bin): { ok: true } | { ok: false, why: string };  // section 2.6
export async function listerProbe({ bin, cwd, runId, onSpawn }): Promise<{ ok: true } | { ok: false, reason: string }>;
```

`startTime(pid)`: same PS path and flags, script
`$ProgressPreference='SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" -Property
CreationDate; if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }`, timeout 30000; empty
output or error → `null`. `killTree`: `path.join(SystemRoot,"System32","taskkill.exe")`, args `["/T","/F","/PID",
String(pid)]`, `windowsHide:true`, timeout 30000.

### 2.5 How `user` is filled when the owner cannot be read

The owner comes from `tasklist /V`, which reads it for sandbox users without elevation (P4, section 1). CIM `GetOwner`
is not used. A row with `user:null` (other session in session scope, pid race, protected process) is treated by the
name rule in section 3.1; the ancestor rule of the Task 2 checklist is section 3.3 (descendants of recorded run
processes), which works from CIM `ppid` and needs no owner.

### 2.6 Positive visibility: the lister probe (ruling (d): "the lister must actually be able to see sandbox users")

`listerProbe({ bin, cwd, runId, onSpawn })`:
1. Write `TMP\<runId>\lprobe.cmd` = `cmdFileText("C:\\Windows\\System32\\PING.EXE -n 15 127.0.0.1 >nul")`.
2. Spawn `bin.cmd` with `[...bin.args, ...sandboxArgs({ profile: ":read-only", cwd, cmdFile })]`, `windowsHide:true`,
   `stdio:"ignore"`; call `onSpawn(child)` (Task 9 adds the pid to its children and records it with `addChild`).
3. Wait 2000 ms; `L = listProcs({ scope: "session" })` (never cached). `L.ok` false → `{ok:false,
   reason:"lister-blind: <error>"}`.
4. Pass iff some row is `isSandboxed` by its `user` (not by the name rule) and is a descendant of the spawned pid
   (ppid chain over `L.rows`, each step `child.start >= parent.start`).
5. `killTree(pid)`, wait for the child's `exit` (cap 10 s). Return `{ok:true}` or `{ok:false,
   reason:"lister-blind: no sandbox-user row under the probe"}`.

`listerVerified(bin)`: `LISTER_PROBE` readable, `ok === true`, and `version === codexVersion(bin)`; else
`{ok:false, why:"lister-unverified"}`. It is called only on the quarantine path, so the `--version` spawn costs
nothing on the happy path.

## 3. Process rules (pure)

### 3.1 Sandboxed

`isSandboxed(row)` = `/(^|\\)CodexSandbox[A-Za-z0-9_-]*$/i.test(row.user)` OR (`row.user === null` AND
`/^codex-command-runner/i.test(row.name)`). The user rule covers `CodexSandboxOffline`/`Online` and future suffixes;
the name rule only applies when the owner is unknown, so fixtures that assign every row a user switch it off.

### 3.2 Excluded rows

Never counted, for any rule: the self chain (the row `selfPid` and its ancestors: follow `ppid` while the parent row
exists and `parent.start <= child.start`; this excludes the shell that ran `codex-run.mjs --continue <old id>`, whose
command line contains the old run id) and the lister subtree (`listerPid` and its descendants: `tasklist.exe`,
`conhost.exe`).

### 3.3 `procFindings({ rec, rows, selfPid, listerPid, runId, mode })`

`mode:"quarantine"` (a dead run's record) or `mode:"end"` (this run, A4b). `ms(x)` = `Date.parse(x)`, NaN → null.
`O = ms(rec.owner_start_time)`. Each pid is reported once, with the first matching reason in this order:

1. `sandbox-user` — `isSandboxed(row)`. In `mode:"end"` only if `row.start === null || ms(row.start) >= O` (a
   sandbox process older than this run is not ours; this replaces the plan's pre-run snapshot, section 6).
2. `tagged` — `row.cmd` contains `runId` (case-insensitive). `runId` = `rec.run_id`; the run dir, check files,
   `readcheck.cmd`, `lprobe.cmd` and `last.json` paths all contain it.
3. `owner-alive` (`mode:"quarantine"` only) — `row.pid === rec.owner_pid && row.start === rec.owner_start_time`.
4. `child-alive` — for some `c` in `rec.child_pids`: `row.pid === c.pid` and (`row.start === null` or
   (`ms(row.start) >= O` and `ms(row.start) <= ms(c.at) + 5000`)). A row with that pid started later is a reused pid.
5. `descendant` — fixpoint over the rows: `row.ppid` is a recorded pid (`rec.owner_pid` in `mode:"quarantine"` only,
   or any `c.pid`) and (`row.start === null` or `ms(row.start) >= O`); or `row.ppid` is the pid of a row already
   counted (`P`) and (`row.start === null` or `P.start === null` or `ms(row.start) >= ms(P.start)`).

In `mode:"end"` the owner is this live script; its direct children are known in memory, so rule 5 starts from
`child_pids` only (otherwise the script's own `conhost.exe` would count). `text` =
`"<why>:<pid>:<name>"`. Accepted false positives (the conservative side): the user's interactive Codex (rule 1), a
recorded pid reused by a process that has children (rule 5), any process whose command line mentions the run id.

## 4. Records and the quarantine decision (`lib/locks.mjs`)

### 4.1 Record schema v1 (both kinds; one object, written to WTR and SR)

```json
{ "v": 1, "kind": "worktree|slot", "key": "<sha1 of canon cwd | 1..3>", "cwd": "<canon path>",
  "run_id": "...", "run_dir": "...", "state": "active|clean",
  "owner_pid": 1234, "owner_start_time": "2026-10-06T20:16:48.9944180Z",
  "child_pids": [{ "pid": 2345, "at": "2026-10-06T20:16:50.120Z" }],
  "host_started": false,
  "baseline": "<HEAD sha>", "tree_hash_pre": "<sha256 hex>", "tree_hash_final": null,
  "updated_at": "<node ISO>", "cleared_by": "auto|user (clean records written by a clear only)" }
```

- `owner_start_time` = `startTime(process.pid)` at step 5 (CIM, same clock and format as listing rows; equality is an
  exact string compare). `null` → the run is `blocked` (`procs-unavailable`) before `writeActive`.
- `child_pids[].at` = `new Date().toISOString()` taken right after `spawn()` returned (the child started before it).
- `baseline` = `git rev-parse HEAD` at step 5. `tree_hash_pre` = `diffHash(cwd, baseline)` at step 5, before any spawn
  (clean tree, the `--continue` residue, or a read-only mode's dirty tree). `tree_hash_final` = the final `diffHash`
  of step 11 (write mode), written by `markTreeFinal` before usage and ledger. Dependency: `diffHash` ignores
  `.codex-tmp/` (Task 7 contract); a leftover TMP must not change the hash.

Validation (`readRecord`): `state:"clean"` needs only `v === 1`. `state:"active"` needs: `kind` equal to the folder's
kind, `run_id` matching paths.mjs `RUN_ID_RE`, `run_dir` string, `owner_pid` positive integer, `owner_start_time`
string with a finite `Date.parse`, `child_pids` array of `{pid: positive int, at: string}`, `host_started` boolean,
`baseline` `/^[0-9a-f]{40}([0-9a-f]{24})?$/`, `tree_hash_pre` `/^[0-9a-f]{64}$/`, `tree_hash_final` null or 64-hex.
First failing field → `prevError = "invalid-schema:<field>"`. Any other `state` → `invalid-schema:state`.

### 4.2 Writes and "half-written"

- Every record write = read-modify-write of the whole object through `atomicWriteJson` (temp
  `.<basename>.<pid>.<hex>.tmp` + rename), retried up to 5 times, 100 ms apart, on `EPERM`/`EBUSY`/`EACCES`; the
  last error is thrown. The lock itself is a pipe, an OS object that cannot be half-written; the record is the only
  lock-side file.
- `readRecord(path)` → `{ prev, prevError, halfWritten }`: `ENOENT` → `prev:null`; other read error →
  `prevError:"unreadable"`; parse error → `"invalid-json"`; then validation. `halfWritten` = a file named
  `.<basename>.*.tmp` exists in the record's folder (a writer died between write and rename).
- Stale temp files are deleted by whoever holds the pipe, after the decision: always when the decision is clear, and
  by `--clear-quarantine --yes` on success.
- No fsync: an OS crash or power loss can lose the last write. After a reboot no run process is alive; the tree check
  still applies. Residual risk, accepted.

### 4.3 Conditions as a pure function

```js
export function quarantine({ kind, prev, prevError = null, halfWritten = false, procs = null, tree = null,
  selfPid = process.pid }): { clear: boolean, verdict: "no-record"|"clean"|"auto"|"quarantined", found: string[] }
```

| # | Input | Result |
|---|---|---|
| 1 | `prevError` null, `prev` null, `halfWritten` false | `clear`, `no-record` (no listing) |
| 2 | `prevError` null, `prev.state === "clean"` (`halfWritten` ignored) | `clear`, `clean` (no listing; spec "a clean record: no search") |
| 3 | otherwise: a crash quarantine. `found` collects, in order: | |
| 3a | `prevError` | `record-<prevError>` |
| 3b | `halfWritten` | `record-half-written` |
| 3c | `prev` valid and `prev.host_started` | `host-check-started` (condition (c)) |
| 3d | `procs === null` | `lister-not-run` (stage token) |
| 3e | `procs.ok === false` | `lister-blind:<error>` (incl. `lister-unverified`) |
| 3f | `procs.ok` and `procs.scope !== "full"` | `lister-partial` |
| 3g | `procs.ok`, full | every `procFindings({rec: prev, mode:"quarantine", ...}).text` (conditions (a), (b), plus rules 3-5); with `prev` invalid only rule 1 runs |
| 3h | `kind === "worktree"`, `prev` valid, `tree === null` | `tree-not-checked` (stage token) |
| 3i | `tree.error` | `tree-unknown:<error>` |
| 3j | `tree.head !== prev.baseline` | `head-moved` |
| 3k | else `tree.hash` not in `[prev.tree_hash_pre, prev.tree_hash_final]` (non-null ones) | `tree-changed` |
| 3l | `found` empty | `clear`, `auto` |
| 3m | `found` non-empty | not clear, `quarantined` |

"Matches the record" (ruling (d)(2)) is therefore exactly: `HEAD === baseline` and `diffHash(cwd, baseline)` equals
the hash recorded before the first spawn or the final hash recorded after step 11. A crash while Codex was editing
leaves a tree equal to neither, so the worktree stays quarantined until the user clears it. Slot records skip 3h-3k:
a slot has no tree, and the crashed run's worktree record carries the tree proof. A slot is clear on proof (1) plus
record integrity.

### 4.4 The caller's staging (`evaluate(kind, recordPath, cwd, opts)` inside `acquireWorktree`/`acquireSlot`)

1. `r = readRecord(recordPath)`; `q = quarantine({kind, ...r})`. Verdict `no-record`/`clean` → delete stale temps,
   return clear.
2. If `q.found` holds anything except the stage tokens → return quarantined. No listing (saves 30 s; for example
   `host-check-started` can never auto-clear).
3. `procs = listerVerified(bin).ok ? listProcs({scope:"full", maxAgeMs:120000}) : {ok:false,
   error:"lister-unverified"}`; `q = quarantine({kind, ...r, procs})`. Anything except `tree-not-checked` → return
   quarantined.
4. Worktree only, after the listing showed no run process (so nothing can change the tree any more): `tree =
   opts.treeState ? opts.treeState(cwd, r.prev.baseline) : {error:"no-tree-state"}` (a throw → `{error:<message>}`);
   `q = quarantine({kind, ...r, procs, tree})`.
5. `q.clear` → `writeClean(recordPath, r.prev.run_id, {cleared_by:"auto"})`, delete stale temps, one stderr line
   `codex-run: auto-cleared quarantine of run <id> (<kind> <key>)`.

Returned `found` never contains the stage tokens. `opts.treeState(cwd, baseline)` → `{head, hash}`; Task 9 passes
`(cwd, b) => ({ head: baseline(cwd), hash: diffHash(cwd, b) })` from Task 7; Task 5 tests pass stubs.

### 4.5 Exports (supersede the plan's `locks.mjs` block where they differ)

```js
export async function acquirePipe(name), releasePipe(server), busySlots();        // as planned
export async function acquireWorktree(cwd, { treeState, bin } = {}):
  Promise<{ server, recordPath, prev, cleared?: "auto" } | { busy: true } | { blocked: "cwd-missing" }
        | { quarantined: true, found: string[] }>;   // quarantined: pipe already released
export async function acquireSlot({ bin } = {}):
  Promise<{ server, n, recordPath, prev } | { busy: true, quarantined: Array<{ n, found }> }>;
  // slot-1..3 in order; a quarantined slot's pipe is released and the next tried; "busy" with a non-empty
  // `quarantined` list → Task 9 prints `codex-slots-full` naming them.
export function readRecord(recordPath): { prev, prevError, halfWritten };
export function quarantine(input): {...};                       // section 4.3, pure
export function writeActive(recordPath, rec): void;             // full v1 object, state "active"
export function addChild(recordPath, pid): void;                // appends {pid, at: now}
export function markHostStarted(recordPath): void;              // host_started:true, BEFORE the first --check-host spawn
export function markTreeFinal(recordPath, hash): void;
export function writeClean(recordPath, runId, extra = {}): void;  // throws if the record is active for another run_id
export async function clearQuarantine(target, { yes, bin, treeState }): Promise<ClearResult>;   // section 5
```

Every mutation is applied to WTR first, then SR. `bin` defaults to `resolveCodex()` and is only used by
`listerVerified`.

## 5. `--clear-quarantine <worktree|slot-N> [--yes]`

The confirmation is a file plus a second call: the first call lists and saves the listing, the controller shows it
to the user, and only after the user says yes in chat does the controller call again with `--yes`, which kills only
what was listed.

1. Target: `slot-1|slot-2|slot-3` → slot record; else `canonPath(target)` (throws → `reason:"cwd-missing"`).
2. Take the target's pipe; busy → `reason:"busy"` (a live run holds it; nothing is touched).
3. `readRecord`. `state:"clean"`, no `prevError`, no temp → `reason:"not-quarantined"`, release, done (no listing).
4. `L = listProcs({scope:"full"})` (fresh, about 30 s; print `codex-run: listing processes (about 30 s)` to stderr).
   `L.ok` false → `reason:"lister-blind:<error>"`, `cleared:false`. The user may then inspect Task Manager and delete
   the record file by hand; the script never does it.
5. Candidates = `procFindings({rec: prev (or null if invalid), mode:"quarantine", rows: L.rows, ...})`, plus notes for
   the static findings: `note: host-check-started (a host check ran outside the sandbox; untagged children of it
   that were never recorded cannot be traced)`, `note: tree-changed|head-moved|tree-unknown (inspect git status and
   git diff before using the worktree)`, `note: record-<error>`, `note: record-half-written`, and
   `note: lister-unverified` when `listerVerified` fails. With `--yes` these notes are waived: the user accepted them.
6. Listing line per candidate: `"<pid> <name> <why> user=<user|?> start=<start|?> cmd=<first 120 chars|?>"`.
7. Without `--yes`, or with `--yes` but no valid confirmation file: write
   `<WT_LOCKS|SLOT_LOCKS>/<key>.clear-listing.json` = `{at, run_id, candidates:[{pid, start, name, why}]}`, release,
   `cleared:false, reason:"confirm"`. A confirmation file is valid when it is at most 30 min old and its `run_id`
   equals the record's (`null` for an invalid record).
8. With `--yes` and a valid file: kill = fresh candidates that match a confirmed one (same pid and same `start`, or
   both `start` null and same name). Fresh candidates not confirmed are not killed; they go to `new_candidates`.
   Kill order: (i) `tagged`, `owner-alive`, `child-alive` rows sorted by `start` ascending (oldest first, so `/T`
   takes the whole tree); (ii) `descendant` rows; (iii) `sandbox-user` rows. Before each kill, `startTime(pid)` must
   equal the row's `start` (not null and different → reused pid, skip; null → already gone, skip); then
   `killTree(pid)`. Record `{pid, ok, out}` in `killed`.
9. Wait 1000 ms; fresh `listProcs({scope:"full"})`; recompute `procFindings`. Any finding, or a blind listing →
   `cleared:false, reason:"survivors"`, `survivors:[text]`, record untouched, confirmation file kept.
10. None → `writeClean(recordPath, prev?.run_id ?? null, {cleared_by:"user"})`, delete stale temps and the
    confirmation file. Worktree target: delete TMP (best effort), then for n = 1..3 try `acquirePipe("slot-"+n)`;
    if taken and the slot record is `active` with the same `run_id`, `writeClean` it (the re-listing just proved the
    run's processes gone); release. Release the target pipe. `cleared:true, reason:null`.

`ClearResult` and the CLI's single stdout JSON line (exit 0):
`{"clear_quarantine":"<canon path|slot-N>","run":"<run id|null>","listed":[...],"notes":[...],"killed":[{"pid":1,"ok":true}],
"new_candidates":[...],"survivors":[...],"cleared":false,"reason":"confirm|busy|not-quarantined|cwd-missing|survivors|lister-blind:<e>|null"}`.
Two full listings: about 1 min, so the controller runs it with a timeout of at least 300 s.

## 6. A4b: the end-of-run orphan rule

End routine `E` (sections 7 and 9 use it):
1. Kill own children still running (`exitCode === null && signalCode === null`) with `killTree`, then await each
   one's `exit` (cap 5 s each).
2. `spawned === 0` → `orphans = []`, skip the listing. `spawned` counts every `codex sandbox` (read check, lister
   probe, version-gate probes, `--check`), `codex exec` and `--check-host` spawn. It does not count `git`, the
   PowerShell lister, `startTime`, `codex --version` or `codex features list` (synchronous, no descendants).
3. Else `L = listProcs({scope:"session"})`; `F = procFindings({rec, rows: L.rows, mode:"end", runId, selfPid,
   listerPid})`. Non-empty → wait 1500 ms and list again, at most 3 listings in total; `F` of the last listing
   counts. `L.ok` false → `orphans = ["lister-blind"]`. Else `orphans = F.map(f => f.pid)`.
4. `orphans` empty → delete TMP (`rmSync` recursive, force, `maxRetries:5`; a failure is a stderr note
   `codex-tmp-left`, status unchanged) → `writeClean(SR)` → `writeClean(WTR)`, each in its own `try/catch` (a failed
   write leaves that record `active` with a stderr note; the next run takes the quarantine path). Non-empty → leave both records
   `active` and TMP in place (the next run is quarantined; the quarantine path lists them again); stderr line
   `codex-run: orphans <list>`.
5. `releasePipe(SP)` then `releasePipe(WTP)`.

`orphans` in the result is `Array<number|"lister-blind">`; the status (done/failed/blocked) is not changed by it.
Rule 1 of 3.3 in `mode:"end"` replaces the plan's "absent from a pre-run snapshot": it needs one listing per run
instead of two, and it is not fooled by pid reuse. A sandbox process started during the run by the user's own Codex
counts as an orphan (spec:190, accepted).

## 7. Task 9: run sequence and the held-resources × failure-step matrix

Run sequence (amended, section 10): (1) args, brief, `secretScan`, `parseBrief` → (2) `isLinkedWorktree`,
`laneCheck` → (3) `acquireWorktree(cwd, {treeState, bin})` → (4) `acquireSlot({bin})` → (5) 5a remove leftover TMP,
create `TMP\<runId>`; 5b `baseline`, `tree_hash_pre`; 5c `owner_start_time = startTime(process.pid)`; 5d
`writeActive(WTR)`, 5e `writeActive(SR)` → (6) write mode `isClean` or `continueCheck` → (7) `quotaDecision` → (8)
version minimum; if the version differs from `TESTED_VERSION`: 8a `listerProbe` (ok → `LISTER_PROBE =
{version, ok:true, at}`), 8b `versionGate`; `aclScan` when due → (9) `runReadCheck` → (10) `brief.md`, `meta.json`,
spawn `codex exec`, `addChild` → (11) write mode: scope, `--check` (each `addChild`), `markHostStarted` then each
`--check-host` (`addChild`), cleanup, final scope, `diffHash` → `markTreeFinal`, `fileStats`, `meta.json` → (12)
`recordUsage`, `appendRun` → (13) routine `E` → (14) print `buildResult`.

Cleanup paths:
- **P0**: print the `blocked` result. Holds nothing.
- **P1**: release the pipes held (SP, then WTP); print `blocked`. No ledger line, records untouched.
- **P2 (A4a)**, any guard failure after 5d succeeded: `appendRun({status:"blocked", ...})` → routine `E` → print
  `blocked` with one reason. With `spawned === 0` this costs no listing.
- **P3**: normal end and every failure after the `codex exec` spawn: (11 as far as it applies) → (12) → `E` → print.
- Every path after 5d runs inside `try/finally`; an uncaught error goes to P3 with `failed` (`internal: <message>`).
  If `E` throws, the records stay as written (active) and the process exit frees the pipes.

| Step that fails | Held at failure | Path | Result | Ledger | WTR / SR after | TMP after |
|---|---|---|---|---|---|---|
| 1 brief, secret | — | P0 | blocked `brief-invalid`/`secret-in-brief` | no | untouched | untouched |
| 2 linked, lane | — | P0 | blocked | no | untouched | untouched |
| 3 cwd missing | — | P0 | blocked `cwd-missing` | no | untouched | untouched |
| 3 busy | — | P0 | blocked `worktree-busy` | no | untouched | untouched |
| 3 quarantined | (WTP released by locks) | P0 | blocked `worktree-quarantined: <found>` | no | untouched (active) | untouched |
| 4 all busy/quarantined | WTP | P1 | blocked `codex-slots-full[: quarantined slot-n ...]` | no | untouched | untouched |
| 5a TMP removal fails | WTP SP | P1 | blocked `codex-tmp-locked` | no | untouched | partial |
| 5b git fails | WTP SP | P1 | blocked `git-failed` | no | untouched | `TMP\<runId>` (empty; next run removes) |
| 5c `startTime` null | WTP SP | P1 | blocked `procs-unavailable` | no | untouched | same |
| 5d `writeActive(WTR)` throws | WTP SP | P1 | blocked `state-write-failed` | no | WTR unchanged (rename did not happen) | same |
| 5e `writeActive(SR)` throws | WTP SP WTR | P2, no listing | blocked `state-write-failed` | blocked | clean / unchanged | deleted |
| 6 dirty, continue mismatch | WTP SP WTR SR | P2, no listing | blocked `dirty`/`continue-mismatch` | blocked | clean / clean | deleted |
| 7 quota block | same | P2, no listing | blocked `codex-quota <ISO>` | blocked | clean / clean | deleted |
| 8 version too old | same | P2, no listing | blocked `codex-version-old` | blocked | clean / clean | deleted |
| 8a lister probe fails | same + probe child | P2, listing | blocked `codex-version-untested: lister-blind` | blocked | clean, or active + orphans | deleted, or kept |
| 8b gate / ACL scan fails | same | P2, listing | blocked `codex-version-untested`/`acl-missing`/... | blocked | same | same |
| 9 read check | same | P2, listing | blocked `read-boundary-open`/`read-check-failed` | blocked | same | same |
| 10 `brief.md`/`meta.json` write | same | P2, listing (read check ran) | blocked `state-write-failed` | blocked | same | same |
| 10 spawn error | same | P3 | failed `codex-spawn: <code>` | failed | same | same |
| 10 Codex timeout | + codex tree | `killTree(codex)` → P3 | blocked `timeout` | blocked | same | same |
| 10 Codex exit ≠ 0 / bad `last.json` / no thread | same | P3 | failed (Review Focus 5) | failed | same | same |
| 11 initial scope | same | P3, no check runs | blocked `out-of-scope: ...` | blocked | same | same |
| 11 a check fails / times out | + check tree | timeout → `killTree` → P3 | failed | failed | same | same |
| 11 final scope | same | P3 | blocked `out-of-scope: ...` | blocked | same | same |
| 12 `recordUsage`/`appendRun` throws | same | continue to `E` (stderr note) | unchanged | maybe lost | same | same |
| 13 orphans or blind end listing | WTP SP WTR SR | `E` keeps records | unchanged, `orphans:[...]` | as decided | active / active | kept |
| 13 `writeClean` throws | same | release pipes | unchanged + stderr note | as decided | active (next run: quarantine path) | deleted |
| process killed anywhere | OS frees pipes; direct children die (libuv job); grandchildren live | — | none | none | as last written | as is |

"same" in the last two columns = `E` decides: no orphans → both records clean and TMP deleted; orphans or a blind
listing → both records active and TMP kept. Pipes are always released last (SP, then WTP) on every path that holds
them. The run dir is never deleted (it is the run's log).

## 8. Fault injection: `CODEX_RUN_PROCS` fixtures and the six spec cases

### 8.1 Fixture format

`CODEX_RUN_PROCS=<abs path>`; the file is re-read on every call (tests may rewrite it between calls):

```json
{ "log": "<abs path, optional: each call appends 'list:<scope>' or 'start:<pid>' plus a newline>",
  "session": "Listing | Listing[] (optional)",
  "full":    "Listing | Listing[] (optional)",
  "overlay": { "users": [{ "pid": 1, "cmd": "substring", "name": "x.exe", "user": "TESTHOST\\CodexSandboxOffline" }],
               "default_user": "TESTHOST\\me" },
  "startTimes": { "<pid>": "<iso>", "*": "<iso>" } }
```

`Listing` = `{"ok":true,"rows":[Row]}` or `{"ok":false,"error":"..."}`. Rules:
- `overlay` present → a real CIM-only listing (same script without the `tasklist` part; about 0.8 s), filtered to
  session `S` for `scope:"session"`. Each row's `user` = the first `users` entry whose given keys all match (`pid`
  equal, `cmd` substring case-insensitive, `name` equal case-insensitive), else `default_user`. `ok:true`, no
  positivity check. `startTime` is real.
- Else static: an array is consumed one per call per scope within one process (the last entry repeats); a missing
  scope → `{ok:false, error:"fixture: no <scope>"}`. `startTime(pid)` = `startTimes[pid] ?? startTimes["*"] ??
  "2026-01-01T00:00:00.0000000Z"`.
- `maxAgeMs` caching applies to fixtures too (tests that need two different listings in one process pass
  `maxAgeMs:0`, which every non-quarantine caller does).
- Tests always write `LISTER_PROBE = {version:"0.160.0", ok:true, at}` when they expect auto-clear (the fake reports
  0.160.0), and leave it absent to assert `lister-blind:lister-unverified`.

### 8.2 Helper `tests/crash-controller.mjs` (new, Task 5)

`node crash-controller.mjs <mode> <cwd> <outFile>`, env from `tmpEnv()` (same pipe prefix, CFG, fixture). It calls
`acquireWorktree(cwd, {treeState: stub})` and `acquireSlot()` (both must be clear), writes both records with
`writeActive` (owner = itself, `owner_start_time = startTime(process.pid)`, `baseline`/`tree_hash_pre` from argv
`--tree <head>:<hash>`), writes `outFile` (`{ownerPid, runId, runDir, ...pids}`), then:
- `exec-detached`: spawns the fake `codex exec` with `detached:true, windowsHide:true, stdio:["pipe","ignore","ignore"]`
  and args `-C <cwd> -o <runDir>\last.json` (tagged), ends stdin; does NOT call `addChild` (unless `--add-child`);
  adds `codexPid` to `outFile`; then idles (`setInterval`) until killed.
- `host`: `markHostStarted`, writes `TMP\<runId>\check-1.cmd` = `cmdFileText("C:\\Windows\\System32\\PING.EXE -n 60
  127.0.0.1 >nul")`, spawns `C:\Windows\System32\cmd.exe /d /c <file>` non-detached, `addChild(cmd pid)` on both
  records, adds `cmdPid`; idles.
- `active-exit`: optional `--add-child <pid>`; exits 0 at once without `writeClean` (a stale active record whose
  owner is gone).

The test kills it with `process.kill(ownerPid)` (TerminateProcess) and waits until `process.kill(ownerPid, 0)` throws.
The kill frees its pipes. Every test registers `t.after(() => killTree(pid))` for each pid in `outFile` and in the
fake's `pidFile`.

### 8.3 Fake codex change (decision: yes, add a detached mode)

`tests/fake-codex.mjs` (Task 5 owns this edit): `scenario.grandchild` accepts `true`/`"attached"` (today's behaviour:
non-detached, dies with the fake through libuv's job) and `"detached"` (`spawn(process.execPath, ["-e",
"setTimeout(()=>{},<ms>)", ...tag], {detached:true, stdio:"ignore", windowsHide:true})`, then `unref()`; it survives
the fake's death, as sandboxed grandchildren survive `codex.exe` in production). `scenario.grandchildTag` (string)
is appended as an extra argv, so overlay fixtures can match it by `cmd`. `scenario.grandchildMs` (default 120000,
both modes) replaces `1e9`, so a leaked grandchild dies within 2 minutes even if a test crashes. `pidFile` keeps
`{pid, grandchild}`. Cleanup is explicit: the test calls `killTree(grandchild)` in `t.after` and asserts the pid is gone.
The probe in section 1 shows a detached child opens no window.

### 8.4 The six cases (spec:197-203), each a `locks.test.mjs` test

Common setup: `tmpEnv()`, `makeRepo()` + `addWorktree()`, stub `treeState = () => ({head: H, hash: X})` with the same
`H`/`X` the controller recorded (unless a case says otherwise), `LISTER_PROBE` written.

1. **Controller killed right after spawn, before any pid is recorded** → quarantined via (b), then (a).
   `crash-controller exec-detached` with scenario `{sleepMs: 60000, grandchild: "detached", grandchildTag:
   "cdx-gc-<rand>", pidFile}`; wait for `pidFile`; `process.kill(ownerPid)`. Fixture: overlay, `users: []`.
   Assert `acquireWorktree` → `quarantined`, `found` has `tagged:<codexPid>:node.exe` (the grandchild also shows as
   `descendant`, its parent being a counted row). Leave both processes alive, rewrite the fixture with
   `users: [{cmd: "cdx-gc-<rand>", user: "TESTHOST\\CodexSandboxOffline"}]` and assert `found` now has
   `sandbox-user:<gc>:node.exe`. Cleanup kills both.
2. **Tagged parent exits, untagged sandboxed grandchild survives** → quarantined via (a) only.
   Same mode with scenario `{sleepMs: 0, grandchild: "detached", grandchildTag, pidFile}` (the fake exits at once);
   wait until the fake's pid is gone, kill the controller. Overlay with the `cmd` user mark → `found` =
   `[sandbox-user:<gc>:node.exe]` exactly. Each variant below uses a fresh worktree and controller, because an
   auto-clear rewrites the record: `users: []` → `clear`, verdict `auto` (nothing but (a) can see the grandchild,
   which proves (a) is what caught it); controller run with `--add-child` (it records the fake's pid) and
   `users: []` → `descendant:<gc>:node.exe` (rule 5). Kill `gc` in `t.after`.
3. **Host check started, controller killed** → quarantined via (c) until cleared.
   `crash-controller host`; kill the controller (cmd.exe dies with it through libuv's job; PING, a grandchild, is
   outside the job and survives; the test asserts it is alive, finding its pid in an overlay listing as the child
   of `cmdPid`). Fixture: `{log, overlay:
   {users: []}}`. Assert `found` has `host-check-started` and the `log` file has no `list:` line (static stage
   skipped the 30 s listing). Then `clearQuarantine(cwd, {yes:false})` → `reason:"confirm"`, `listed` names the
   PING pid as `descendant` (ppid = the recorded cmd.exe) plus the `host-check-started` note, confirmation file
   written; `clearQuarantine(cwd, {yes:true})` → `killed` has the PING pid with `ok:true`, `cleared:true`; the next
   `acquireWorktree` → clear. `clearQuarantine` without a prior confirmation file and `yes:true` → `reason:"confirm"`.
4. **Two runs racing for one worktree** → exactly one wins. Two child node processes call `acquireWorktree` on two
   Review Focus 1 spellings of the same path at the same time (released by a start file); one returns `server`, the
   other `busy`. No fixture needed (fresh worktree: `no-record`).
5. **Stale active record, no survivors** → auto-cleared. `crash-controller active-exit`; fixture static `{log, full:
   {ok:true, rows:[<an unrelated row>]}}`. Assert `clear`, `cleared:"auto"`, WTR now `clean` with
   `cleared_by:"auto"`, `log` has exactly one `list:full`. Variants (each → quarantined with the named finding):
   `full: {ok:false, error:"x"}` → `lister-blind:x`; no `LISTER_PROBE` → `lister-blind:lister-unverified`; stub
   head ≠ `H` → `head-moved`; stub hash ≠ `X` → `tree-changed`; stub hash = a `tree_hash_final` written with
   `markTreeFinal` → clear; a `.<name>.1.ab.tmp` file next to the record → `record-half-written`; record text
   `{` → `record-invalid-json`; `owner_start_time` missing → `record-invalid-schema:owner_start_time`; a row with
   `user: "TESTHOST\\CodexSandboxOnline"` → `sandbox-user`; a row whose `cmd` contains the run id in upper case →
   `tagged`; a row whose `pid`/`start` equal the owner's → `owner-alive`.
6. **Clean record** → clear, no search. Fixture `{log}` only (any listing would return `fixture: no full`). Assert
   `clear`, verdict `clean`, `log` absent or empty.

Also in `procs.test.mjs` (pure): `parseListing` on an inline sanitized sample (section 9); `procFindings` table for
every rule incl. the self chain (`--continue <old id>` in an ancestor's `cmd`), the lister subtree, the 5 s `at`
slack, pid reuse (same pid, later `start` → not `child-alive`), and `mode:"end"` ignoring a sandbox row older than the
owner; `isSandboxed` on `HOST\CodexSandboxOffline`, `CodexSandboxOnline`, `HOST\me`, `null` + runner name.

Task 9 (`run.test.mjs`) uses static fixtures `{session: {ok:true, rows: []}, full: {ok:true, rows: []}}` by default.
The A4b test: `session: {ok:true, rows: [{pid: 999999, ppid: 4, name: "PING.EXE", user: "TESTHOST\\CodexSandboxOffline",
cmd: null, session: 1, start: "2099-01-01T00:00:00.0000000Z"}, {pid: 999998, ..., start:
"2000-01-01T00:00:00.0000000Z"}]}` → `orphans:[999999]` (999998 predates the run), WTR and SR stay `active`, TMP
kept. The read-check-open guard failure → ledger `blocked`, both records `clean`, pipes released (a second run gets
the pipe). The quota block → `log` has no `list:` line (`spawned === 0`). The timeout test uses an overlay fixture
(`users: []`) and scenario `{sleepMs: 60000, grandchild: "detached"}`: both pids gone after the run, `orphans:[]`.
The lister-probe path: overlay `users: [{cmd: "lprobe.cmd", user: "TESTHOST\\CodexSandboxOffline"}]` with
`TESTED_VERSION` absent → `LISTER_PROBE` written; `users: []` → blocked `codex-version-untested: lister-blind`.

## 9. Sanitized sample for the parse test (from the probe, user and host replaced)

`tasklist` lines (CSV, session scope):
```
"codex-command-runner-0.160.0.exe","24552","Console","1","10,644 K","Unknown","HOST\CodexSandboxOffline","0:00:00","N/A"
"PING.EXE","26648","Console","1","5,652 K","Unknown","HOST\CodexSandboxOffline","0:00:00","N/A"
"csrss.exe","2092","Console","1","10,052 K","Unknown","N/A","0:00:50","N/A"
"node.exe","4242","Console","1","40,000 K","Unknown","HOST\USER","0:00:01","N/A"
```
CIM rows: `{pid:25652, ppid:22252, name:"codex.exe", session:1, cmd:"\"...\\codex.exe\" sandbox -P :workspace ..."}`,
`{pid:24552, ppid:25652, name:"codex-command-runner-0.160.0.exe", session:1, cmd:"C:\\Users\\USER\\.codex\\.sandbox-bin\\codex-command-runner-0.160.0.exe --pipe-in=...", start:"2026-10-06T20:16:49.1000000Z"}`,
`{pid:26648, ppid:24552, name:"PING.EXE", session:1, cmd:"C:\\Windows\\System32\\PING.EXE -n 240 127.0.0.1"}`,
`{pid:14852, ppid:2156, name:"codex-windows-sandbox-service.exe", session:0, cmd:null}` (no tasklist row in session
scope → `user:null`, not a runner → not sandboxed). Expected: runner and PING sandboxed by user, codex.exe `user:null`
(no tasklist row in the sample) and not sandboxed, csrss `user:null`, node `HOST\USER`.

## 10. Plan amendments (this addendum supersedes the plan text here)

1. **Step 5** now also computes `baseline` and `tree_hash_pre` and `owner_start_time`, so the first `active` record
   already carries them (a crash between 5 and 6 stays decidable). Step 6 no longer records the baseline.
2. **Step 8** runs `listerProbe` before `versionGate` whenever the version differs from `TESTED_VERSION`; failure
   blocks (`codex-version-untested: lister-blind`), so a Codex update that hides sandbox users from the lister
   cannot silently disable A4b.
3. **Step 13** order: kill and await own children → listing → (no orphans) delete TMP → `writeClean` SR, WTR →
   release SP, WTP. The plan deleted TMP before the listing; TMP is now kept as evidence when orphans exist.
4. **A4b**: start-time rule instead of a pre-run snapshot (section 6).
5. **`quarantine`** takes one input object (section 4.3), not `(prev, procs)`; `listProcs` returns a `Listing`
   object, not an array; rows gain `session` and `start`; `child_pids` entries are `{pid, at}`.
6. **`--clear-quarantine`** also accepts `slot-N`; `--yes` requires the confirmation file of a prior listing call;
   (c) and the tree findings are listed as notes and waived by `--yes`.
7. **Task 5 files** gain `tests/crash-controller.mjs` (new) and `tests/fake-codex.mjs` (edit, section 8.3).
8. **Ledger** on P2 is appended before routine `E` (the plan's order: after `writeClean`); a crash inside `E` then
   still leaves the ledger line.

## 11. Open risks

- **Session-0 sandbox processes.** The end-of-run check (session scope) assumes sandboxed processes live in session
  `S`, true for 0.160.0 (token session inheritance). If a Codex version launched them from its session-0 service,
  A4b would miss them; the lister probe (section 2.6) would not catch this either, since it only proves that
  session-`S` rows are visible. The quarantine path uses the full scope and is not affected.
- **Owner column per version.** Visibility of the sandbox owner is proven per Codex version by the lister probe,
  not continuously. A Windows update that changes `tasklist /V` output makes `parseListing` fail closed (`ok:false`).
- **Blind lister means manual clears.** If PowerShell or CIM breaks, every crash needs the user, and
  `--clear-quarantine` cannot clear either (it needs a listing); the user deletes the record by hand.
- **False positives** (accepted, conservative): the user's interactive Codex, pid reuse with children, command lines
  that mention a run id. Each costs a manual `--clear-quarantine`.
- **Untraced host-check descendants.** A host-check child started before its `addChild` landed, or one that
  re-parents, is invisible to rule 5; (c) keeps such a worktree quarantined and the note tells the user.
- **Cost.** Happy path: `startTime` (0.7 s) + one session listing (3.3-4.8 s, up to 3 when something lingers) per
  run that spawned; about 8 s once per Codex version for the lister probe; 30 s only on the crash path; about 60 s
  per `--clear-quarantine --yes`.
- **No fsync** on record writes (section 4.2).
