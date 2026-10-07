---
name: model-coordinator
description: Use when the user wants to talk to several running worker sessions (Claude lanes and Codex jobs) from one chat prompt - route a message to the right worker, start a new worker, check status, reopen closed lanes - or asks about the `coordinator` command, its config, its cost limits or its routing. A small CLI (`coordinator`) that routes plain-language messages; it never runs model output.
---

# Model coordinator

`coordinator` is a console you type messages into. Each message goes to the worker it is meant for (a Claude Code lane started
by `handoff-launch`, or a Codex job), or starts a new worker, or answers a status question. Shortcuts (`/to`, `/status`, `/new`,
`/alias`) are handled by code with no model call. Other lines are routed by a small model: the Decisions API picks the route from
probabilities, and Luna (`gpt-6-luna`, Responses API) only writes text or routes when Decisions is down. Models have no tools:
what they return is only ever shown to you or passed to a worker as text. It is never a path, a command or a file write.

It is not the loop coordinator of `handoff-launch` (`state/coord`). This one is called `model-coordinator` or `mc` everywhere.

## Run it

```
coordinator [--repo <dir>] [--status [--json]] [--once "<line>"] [--yes | --no]
```

- `coordinator` (Windows: `CONFIG/skills/model-coordinator/coordinator.cmd`; elsewhere `node CONFIG/skills/model-coordinator/cli.mjs`)
  starts the console in the git repo you are in, or in `--repo`. `CONFIG` is `CLAUDE_CONFIG_DIR` or `~/.claude`.
- `--status` prints the workers, the month's spend and the Codex state and exits (`--json` for machines). It never needs the instance.
- `--once "<line>"` handles one line and exits. `--yes` / `--no` answer the startup question "Restart closed sessions?".
- One coordinator runs at a time (a named pipe); a second one prints `coordinator already running (pid ...)` and exits 1.
- Exit codes: 0 ok, 1 another instance runs, 2 bad arguments or config (every config error is printed).

Commands inside the console:

| Command | What it does |
|---|---|
| `/to <worker>[,<worker>...] <text>` | Sends the text verbatim to one or more workers (id, label or alias; at most 8). One exception: see "Delivering messages to Claude workers" (the wake of an idle lane). |
| `/status [<worker>...]` | Shows workers (no model call). Also prints the month's spend. |
| `/new claude\|codex <label> [--in <worker>] <objective>` | Starts a worker. `--in` reuses a finished worker's worktree. |
| `/alias <worker> <alias>` | Gives a worker another name ("login worker"). |
| `/workers` | Lists workers. |
| `/restart-closed` | Reopens closed unfinished lanes (`launch.mjs resume --closed`), except a lane whose worktree a live `--in` worker uses. |
| `/help`, `/quit` | Help; leave (workers keep running). |

Worker ids are `<label>-NN` (`auth-01`). A label is 3-32 characters: lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit. A label that is a common
word (for example `tests`) works, but every message that contains that word as a whole word and names no other worker is routed
deterministically to that worker by its exact name (rule `exact-name`), with no model call. Pick labels you would not say in
ordinary sentences.

## How messages are routed

1. **Shortcuts (code, no model).** A slash command; a line that names exactly one worker by id, label or alias (and has no pronoun and
   is not a question); `continue` / `keep going` when exactly one worker can take a message. Exchange `path`: `shortcut` (decisions
   built by code), `command`, or `error`.
2. **Decisions (the router).** Any other line is first cleaned (`cleanLine` removes control characters, escape sequences and bidi
   controls before routing, so what is routed is what is dispatched), then sent to the Decisions API as a few multiple-choice
   questions: which worker, which provider for a new worker (`claude`, and `codex` only when the Codex usage reading is `ok`: the
   login works and quota and capacity are known to be fine; with no reading yet, use `/new codex ...`), and for each of up to 8
   live workers "is the message meant for it".
   Code reads the probabilities. A worker id, `new_session`, `status`, `respond` or `clarify` is chosen only when the winner is
   probable and clear enough (`decisions.min_route_probability`, `decisions.min_margin`) and the per-worker answers agree;
   otherwise code asks you a clarifying question itself. The model cannot invent an id: an answer that is not an offered value is
   unusable. Destructive wording (delete, drop, reset, force-push ...) needs a higher bar. Path: `decisions`.
3. **Luna as the writer.** When the route is decided by code but text is needed (a `respond` answer, or a new worker whose goal is
   long, vague or asks for a plan), Luna gets the route as `pinned_route` and may change only `reply`, `new_session.label`,
   `new_session.objective` and `worker_instruction`. Action, targets and provider always stay what code decided.
4. **Luna as the fallback router.** When Decisions is unavailable or its answer is unusable, Luna makes one strict decision for the
   line (stricter bar: `decisions.fallback_min_confidence`, default 0.8). Path: `luna-fallback`. With `decisions.enabled: false`, or
   without a Decisions price, Luna routes every non-shortcut line (path `luna`). With no provider at all the reply says
   `Luna is unavailable (no-provider ...)`; shortcuts keep working.
5. **Dispatcher (code).** Every route ends in the dispatcher: it validates the decision, acts once per turn (a retried turn is a
   replay, never a second dispatch) and writes the ledgers. A turn is one `turnId` and at most one dispatch, whatever retries or
   fallbacks happened.

At the hard spend limit no model is called: the reply says so (`path: shortcuts-only`) and shortcuts, `/status` and running workers
keep working. Every exchange line in `exchanges.jsonl` has a `path` field (`shortcut`, `command`, `error`, `decisions`, `luna`,
`luna-fallback`, `shortcuts-only`) and, for Decisions routes, `route_p1` and `route_margin`.

Rollback: set `"decisions": {"enabled": false}` in the config and restart the coordinator. Luna then routes every non-shortcut line
as before; nothing else changes.

## Config

`CONFIG/state/model-coordinator/config.json` (read only; the coordinator never writes it). Missing keys keep their defaults, and a
bad value is an error that is printed and stops the start (nothing silently becomes a default).

| Key | Default | Meaning |
|---|---|---|
| `provider` | `"none"` | `"none"` or `"openai"`. With `none` no model is ever called: shortcuts only. |
| `openai.model` | `"gpt-6-luna"` | The Luna model. `key_file`, `reasoning_effort`, `timeout_ms` (20000), `max_retries` (2), `max_output_tokens` (600). |
| `pricing.<model>` | none | `input_per_mtok`, `cached_input_per_mtok`, `output_per_mtok` (USD per million tokens); Decisions also needs `decisions_input_per_mtok`. |
| `limits` | 7 / 10 | `monthly_soft_usd`, `monthly_hard_usd`. |
| `min_confidence` | 0.6 | A Luna message/create decision below this becomes a clarifying question. |
| `decisions` | enabled | `enabled`, `model` (`gpt-6-luna` only), `timeout_ms` (10000), `max_retries` (1), `min_route_probability` (0.8), `min_margin` (0.2), `concern_high` (0.8), `concern_low` (0.3), `needs_text_threshold` (0.5), `risky_min_probability` (0.9), `fallback_min_confidence` (0.8), `max_input_chars` (16000), `max_message_chars` (6000: a longer line is not routed automatically; use `/to`). |
| `codex` | see below | `max_parallel_jobs` (2; 1-3), `model` (`sol`), `effort` (`medium`), `queue_max` (4), `fallback` (`claude` or `refuse`), `login_cache_ms` (300000). |
| `claude` | opus / high | The model and effort of Claude workers it starts. Sonnet and Haiku are refused (`launch.mjs` refuses them too). |
| `context` | 3000 / 5 | `max_tokens` caps the input sent to Luna; `exchanges` is how many recent exchanges it sees. `target_tokens` is reserved and unused. |

## Turning OpenAI on (off by default)

The default is `provider: "none"`: nothing is sent anywhere and no spend is possible. To enable it:

1. Put the key in the environment (`OPENAI_API_KEY`) or in a file under `CONFIG/secrets/` named by `openai.key_file`
   (the file must resolve inside the secrets folder). The coordinator reads the key once at start; every worker it starts gets an
   environment without `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_RUN_ENV_ALLOW`.
2. Set `"provider": "openai"` and the prices: `pricing["gpt-6-luna"]` with `input_per_mtok`, `cached_input_per_mtok` and
   `output_per_mtok` (Luna), plus `decisions_input_per_mtok` (Decisions). Without a complete price table Luna does not start; without
   the Decisions price Decisions does not start (a note is printed and Luna routes every line). There is no built-in price.

## Cost limits

Spend is counted from `usage.jsonl` for the current UTC month, **combined** for Decisions and Luna: soft limit $7, hard limit $10
(configurable). Each line has an `api` field (`decisions` or `responses`) and `cost_usd`; a call whose usage is missing is charged at
its worst case. Past the soft limit every reply carries a notice. At the hard limit neither API is called (a check runs before every
attempt, retries included); shortcuts, `/status` and running workers keep working and every reply shows the condition.
`/status` and `--status` print `Spend this month: $X (Decisions $a, Luna $b) of $7 soft / $10 hard` followed by the state: `- ok.`, `- soft limit reached.` or `- hard limit reached: model calls paused.`

## Codex workers and the fallback policy

`/new codex ...` makes a git worktree `codex-<id>` and starts the Codex run (`codex-run`, from the `dispatching-codex` skill) on it.
The gate checks in order: the Codex skill is present, the ChatGPT login works (an API-key login is never used silently), the
coordinator's own job cap (`codex.max_parallel_jobs`), the machine's three Codex slots, the weekly quota, the worktree. Busy: the run is
queued (up to `codex.queue_max`) and starts on a later poll. A new Codex worker that cannot start follows `codex.fallback`:

- `claude` (default): start a Claude worker with the same label instead (`launch.mjs --mode bg`).
- `refuse`: start nothing and say why.
- `paid_api` is deferred to V2 and is refused when the config loads.

An existing Codex worker is never moved to another provider. When a lane is busy with a Codex run, a follow-up `/to` is queued
behind it.

## Delivering messages to Claude workers

`/to` writes the text to `state/model-coordinator/messages/<lane key>/<request id>.json`. The lane's hook (`deliver-hook.mjs`, on
every tool call and prompt) claims it (renamed to `.delivered.json`) and hands it to the worker as context; an idle background lane
is woken with `claude --resume <session> --bg "<text>"` instead. The hook output is capped at 8 KiB: a longer message to a busy
lane arrives **cut**, with a marker `[cut: N more characters; full text in <...>.delivered.json]` that names the claimed file
holding the full text (Claude Code itself saves hook output over 10,000 characters to disk with a short preview, so the cap stays
below that). A wake of an idle lane carries the full text, with one change: the wake text is a single argument of the
`claude` command, and it is passed through the same rule as the launcher's prompts (`launch.mjs`), so every `"` becomes `'` and
every `;` becomes `,` in what the woken lane reads. The claimed `.delivered.json` file keeps the original text, and a message the
hook hands over (a busy lane) is always verbatim. (Why the rule stays: it matches the launcher's, whose prompts avoid those two
characters because Windows PowerShell 5.1 and `wt.exe` mangle them; with `shell: false` on a `claude.exe` they are probably safe,
but that was never verified against the real CLI, so the wake keeps the rule.) If a wake fails and the message cannot be put back
(the claimed file cannot be renamed, for example it is held open), the reply says it was not delivered and to send it again as a
new message; a repeat of the same request would only answer "already delivered or queued". The worker's last fenced `coordinator-state` JSON block (status,
summary, blockers, `needs_user`, files) is what `/status` shows for it.

## The Luna write rule

Models never write files. `store.mjs` is the only module of the coordinator process that writes, and only through an allowlist of
paths under the state folder (real paths compared, links refused). Model-derived text (`record_update` notes and aliases, and the exchange's instruction and reply) is stored only as JSON data
in the state-folder ledgers (for example `workers.jsonl`, `exchanges.jsonl`, `codex-attempts.jsonl`) and rendered into
`coordinator_records.md` by a renderer that takes no path; it never names a path or a file. Worker text (`worker_instruction`, a new
worker's objective) is only ever the text of a message file or a brief. The two provider modules import no write functions and no
`child_process` (a test scans every module). Worker completion summaries use the compact format
`{session_id, provider, status, summary, changes[], blockers[], needs_user, files_changed[]}`; transcripts never reach a model.

## State folder

`CONFIG/state/model-coordinator/`:

| Path | Holds |
|---|---|
| `config.json` | Your config (you write it; the coordinator only reads it). |
| `instance.json` | The running instance (pid, start time). |
| `workers.jsonl` | Worker events (created, status, placed, alias, focus, ended, note). The worker table is a fold of it. |
| `exchanges.jsonl` | One line per turn: `turn_id`, `user`, `reply`, `action`, `targets`, `instruction`, `rule`, `path`. |
| `dispatch.jsonl` | Dispatcher intent and done lines per request id (idempotency). |
| `usage.jsonl` | Model calls and their cost (`api`, `model`, `cost_usd`). Never holds the key. |
| `codex-attempts.jsonl` | Every Codex attempt (queued, reserved, spawned, done, failed, blocked, unknown). |
| `coordinator_records.md` | A readable summary: workers, aliases, focus and notes. |
| `briefs/<id>.md` | The brief handed to a new worker. |
| `messages/<key>/<rid>[.delivered].json` | Messages for a lane: pending, then claimed. |
| `codex-out/<attempt>.out`, `.err` | Output of a Codex run. |

## Check it

`node "CONFIG/skills/model-coordinator/cli.mjs" --status` prints the worker table (or `No workers yet.`), the `Spend this month:` line and
the `Codex:` state line, and exits 0. Run the tests with `node --test "claude/skills/model-coordinator/tests/*.test.mjs"`; they start nothing real
(mock providers, a fake fetch, fake `claude` and `codex` stand-ins, temp state folders).
