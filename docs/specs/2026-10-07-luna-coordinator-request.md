# Luna coordinator: the user's request (verbatim, 2026-10-07)

This is the user's own specification. It supersedes the DeepSeek/Claude-CLI design in
`2026-10-07-model-coordinator-design.md`; reuse only the parts the handoff names.

---

Implement the coordinator/orchestration layer described below into the existing project.

Before changing code:

1. Inspect the current orchestration/session architecture.
2. Inspect the existing Codex integration/infrastructure and reuse it rather than creating a parallel implementation.
3. Read `t10-review-notes.md` and finish the remaining small OpenAI-tool-related tasks listed there where relevant.
4. Use the existing Codex tool during planning and implementation. Ask Codex to review the intended architecture, especially:
   - Codex session handling
   - subscription/usage behavior
   - concurrency
   - worktree isolation
   - fallback behavior
   - safe integration with existing Claude sessions
5. Prefer Codex's knowledge of its own tooling/integration details over assumptions. Validate against the existing codebase before implementing.

Do not unnecessarily rebuild working infrastructure.

# Goal

Add a lightweight interactive coordinator that manages Claude and Codex worker sessions.

The coordinator itself does NOT write production code.

Architecture:

```text
User
  ↓
Coordinator service
  ↓
GPT-6 Luna
  ↓
Strict CoordinatorDecision
  ↓
Validate
  ↓
Deterministic dispatcher
  ├─ Claude workers
  └─ Codex workers
```

# Coordinator model

Use:

- Provider: OpenAI
- Model: `gpt-6-luna`
- API: Responses API
- Reasoning: `none`
- Structured output: strict JSON Schema / Structured Outputs
- API key: `OPENAI_API_KEY`

Do not hard-code secrets.

Build with a mock provider until the real key is supplied.

Use a provider abstraction:

```ts
interface CoordinatorProvider {
  decide(input: CoordinatorInput): Promise<CoordinatorDecision>;
}
```

Implement at minimum:

```text
MockCoordinatorProvider
OpenAILunaProvider
```

Keep the abstraction clean enough to benchmark another model/provider later.

# Luna responsibilities

Luna may:

- talk naturally with the user
- identify which active worker/session the user means
- route instructions to one or multiple workers
- request worker status
- decide when a new worker session is appropriate
- ask for clarification when routing is genuinely ambiguous
- maintain compact coordinator-owned records/state

Luna must NOT:

- implement features
- modify source/project files
- patch code
- run coding tasks itself
- commit changes
- directly control shell/filesystem tools
- directly invoke Codex or Claude processes

The deterministic dispatcher executes approved actions.

# Luna file permissions

Enforce this in code/tool permissions, not only through prompting.

Luna may write/update only:

`coordinator_records.md`

or the existing equivalent coordinator-owned record if the project already has one.

That file may contain only compact operational records such as:

- worker/session state
- aliases
- current focus
- important user decisions
- routing notes
- task relationships

Luna must have no write permission to any other project file.

Claude and Codex workers retain their normal implementation permissions.

# Coordinator output

Use a strict compact schema similar to:

```ts
type CoordinatorAction =
  | "respond"
  | "message_session"
  | "message_multiple"
  | "create_session"
  | "request_status"
  | "clarify";

interface CoordinatorDecision {
  action: CoordinatorAction;
  reply: string;
  target_session_ids: string[];
  worker_instruction: string | null;

  new_session: {
    needed: boolean;
    provider: "claude" | "codex" | null;
    label: string | null;
    objective: string | null;
  };

  confidence: number;
  clarification: string | null;
}
```

Adjust to existing project types where useful.

For OpenAI strict schemas:

- use strict schema enforcement
- `additionalProperties: false`
- all properties required
- nullable values where appropriate

Validate all session IDs and requested actions before dispatch.

Never execute free-form model output.

# Context strategy

Do not send Luna complete worker transcripts or unlimited conversation history.

Normal coordinator context should contain:

1. stable coordinator instructions
2. compact project state
3. active worker summaries
4. worker provider/type
5. `focused_session_id`
6. last 4–6 raw coordinator/user exchanges
7. current user message

Target roughly 1–3K input tokens per normal call.

Worker summaries should stay compact:

```ts
interface WorkerSummary {
  id: string;
  provider: "claude" | "codex";
  label: string;
  aliases: string[];
  status: string;
  objective: string;
  current_task: string | null;
  last_result: string | null;
  blockers: string[];
}
```

Keep full worker context inside the worker session.

# Coreference

Resolve references approximately in this order:

1. explicit session ID
2. explicit worker/task name
3. alias
4. focused session
5. most recently discussed compatible session
6. semantic match
7. clarification if still materially ambiguous

Track `focused_session_id` explicitly.

Examples that should work:

```text
"tell the auth worker to keep going"

"tell him not to change the backend"

"have the other one check it too"

"do that for both"

"continue"

"make another worker for the migration"

"what did the invoice worker say?"
```

# Deterministic shortcuts

Avoid an LLM call when routing is obvious.

Examples:

- explicit worker/session ID
- explicit command syntax
- unique exact worker name
- only one appropriate active worker + "continue"

Use Luna primarily for conversational interpretation and ambiguous routing.

# Claude workers

Preserve the current Claude session infrastructure.

Claude workers remain responsible for:

- implementation
- coding
- debugging
- architecture
- refactoring
- tests
- file edits
- heavy reasoning

Do not interfere with existing Claude sessions when adding Codex support.

# Codex integration

The user has ChatGPT Codex subscription access.

Codex should be available as another implementation worker.

Important:

- reuse the project's CURRENT Codex infrastructure
- do not create a redundant Codex integration if one already exists
- inspect how current Claude sessions already use Codex as a tool
- preserve compatibility with those sessions

Use the Codex tool yourself while implementing this feature to review the design and implementation.

Codex should help determine the safest way to manage its own:

- sessions
- concurrency
- subscription usage
- limits
- workspaces/worktrees
- resumability
- failures
- fallback behavior

# Codex resource manager

Treat Codex subscription usage as a shared resource.

Do NOT assume each Codex session has an independent quota.

Create or reuse a central Codex resource manager.

Conceptually:

```ts
interface CodexResourceState {
  active_jobs: number;
  max_parallel_jobs: number;
  available: boolean;
  capacity_available: boolean;

  usage_status:
    | "ok"
    | "near_limit"
    | "exhausted"
    | "unknown";
}
```

Start conservatively with:

```text
max_parallel_codex_jobs = 2
```

Make it configurable.

Before scheduling a new Codex job:

1. check Codex availability
2. check configured concurrency
3. check current usage/limit state if available
4. ensure workspace isolation
5. dispatch only if safe

If Codex cannot accept another task, do not disrupt existing Codex or Claude jobs.

# Codex usage/fallback

Preferred behavior:

```text
Codex task requested
      ↓
ChatGPT/Codex subscription available?
      ↓ yes
Use existing authenticated Codex infrastructure

      ↓ unavailable / exhausted
Fallback according to configured policy:
  → Claude worker
  OR
  → explicitly configured paid OpenAI API worker
```

Do not automatically create paid API spend unless that fallback is explicitly enabled.

A Codex usage-limit problem should only prevent NEW Codex jobs.

It must not:

- terminate unrelated Claude sessions
- interrupt existing Codex jobs unnecessarily
- corrupt active worker state
- block the entire orchestration system

If Codex reports that an active task can finish despite nearing a limit, allow it to finish and stop assigning new Codex work afterward.

# Codex and Claude isolation

Parallel workers must not edit the same working tree unsafely.

Reuse existing worktree/sandbox infrastructure if available.

Otherwise ensure implementation workers use isolated:

- git worktrees
- branches
- sandboxes
- or equivalent workspace isolation

Conceptually track:

```ts
interface WorkerWorkspace {
  worker_id: string;
  provider: "claude" | "codex";
  worktree: string;
  branch: string;
  status: "active" | "idle" | "done";
}
```

Prevent conflicting write ownership.

Do not allow:

```text
Claude A editing file X
Codex B editing file X
```

in the same worktree concurrently unless the existing architecture explicitly handles this safely.

# Choosing Claude vs Codex

Luna may recommend a provider, but deterministic code must validate availability.

General intent:

Use Claude when:
- existing Claude context is important
- task belongs to an active Claude worker
- Codex capacity is unavailable
- architectural reasoning dominates

Use Codex when:
- implementation/code-writing is appropriate
- Codex infrastructure is available
- task is naturally isolated
- additional parallel implementation capacity is useful

Do not migrate an existing task between providers casually if doing so loses important session context.

# Worker completion summaries

Both Claude and Codex workers should return compact state updates when practical.

Example:

```json
{
  "session_id": "auth-03",
  "provider": "codex",
  "status": "waiting_for_user",
  "summary": "OAuth callback fixed.",
  "changes": [
    "Fixed redirect URI construction",
    "Added callback validation"
  ],
  "blockers": [],
  "needs_user": "Choose redirect or inline error handling.",
  "files_changed": [
    "src/auth/callback.ts"
  ]
}
```

Do not feed full implementation transcripts back into Luna.

# Historical state

Keep old project decisions/events outside the normal Luna prompt.

Use the project's current storage system.

If none exists, simple SQLite/Postgres storage is enough for V1.

Do not add a vector database unless the existing architecture already uses one or it becomes genuinely necessary.

Retrieve historical information only when needed.

# Cost control

Track coordinator API usage:

- input tokens
- cached input tokens
- output tokens
- latency
- retries
- estimated cost

Use configurable limits:

```text
monthly_soft_limit = $7
monthly_hard_limit = $10
```

At the hard limit:

- stop new Luna API spending
- surface the condition
- preserve worker/session state
- do not break running workers

# Reliability

Implement/reuse:

- strict schema validation
- session ID validation
- bounded API retries
- timeout handling
- rate-limit handling
- duplicate-dispatch prevention
- idempotency/request IDs
- missing/dead worker handling
- Codex exhaustion handling
- safe worker fallback
- workspace conflict prevention

# Testing

Before requiring the real OpenAI key, use the mock coordinator.

Test at least:

```text
explicit worker reference
alias reference
focused-session follow-up
"him"
"that one"
"the other one"
"do that for both"
"continue"
new worker creation
multiple targets
ambiguous target → clarification
nonexistent session
completed worker
duplicate dispatch retry
worker failure
Codex busy
Codex exhausted
Codex unavailable
Claude fallback
parallel Claude/Codex work
workspace conflict
Luna attempting unauthorized file edit
```

Verify that Luna cannot modify anything except its own coordinator record.

# Existing project work

Before implementation, specifically inspect:

`t10-review-notes.md`

Finish the small outstanding tasks there that relate to the OpenAI tool/integration and are needed for this coordinator work.

Do not expand unrelated scope from that file.

# Implementation approach

Use Codex during planning and building.

Suggested sequence:

1. inspect existing orchestration code
2. inspect existing Codex infrastructure
3. read `t10-review-notes.md`
4. ask Codex to review how the new coordinator should integrate with its existing infrastructure
5. create a concise implementation plan
6. implement incrementally
7. ask Codex to review relevant Codex-specific changes
8. run targeted tests
9. fix failures/regressions
10. verify existing Claude/Codex sessions still work

Reuse existing abstractions whenever possible.

Do not build a new orchestration framework around working code.

Final architecture principle:

**Luna interprets and routes.**

**The dispatcher validates and controls resources.**

**Claude and Codex workers reason, code, and edit files.**

**Luna may only update its own coordinator record.**
