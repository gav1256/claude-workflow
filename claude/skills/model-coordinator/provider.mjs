/**
 * @typedef {{id: string, provider: "claude"|"codex", label: string, aliases: string[],
 *   status: "starting"|"running"|"idle"|"waiting_for_user"|"queued"|"blocked"|"failed"|"unknown"|"finished"|"dead",
 *   objective: string, current_task: string, last_result: string, blockers: string[]}} WorkerSummary
 *
 * @typedef {{v: 1, instructions: string, project: object, workers: WorkerSummary[], focused_session_id: string|null,
 *   referents: object, exchanges: object[], message: string, validation_errors?: object[]}} CoordinatorInput
 *
 * A provider is any object with `decide(input: CoordinatorInput): Promise<CoordinatorDecision>`.
 * It returns one decision per call and never runs tools.
 */

export class ProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** A provider that cannot start because its config is incomplete or unsafe. One home, so `instanceof` works across modules. */
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

/** Scripted provider for tests. `script` is an array of decisions or `input => decision`, or one function used for every call. */
export class MockCoordinatorProvider {
  constructor(script) {
    this.script = script;
    this.calls = [];
    this._i = 0;
  }
  async decide(input) {
    this.calls.push(input);
    if (typeof this.script === "function") return this.script(input);
    if (this._i >= this.script.length) throw new ProviderError("mock-exhausted", "mock provider script is exhausted");
    const next = this.script[this._i++];
    return typeof next === "function" ? next(input) : next;
  }
}

/** Used when no provider is configured (default `provider: "none"`). */
export class NullProvider {
  async decide() {
    throw new ProviderError("no-provider", "Luna is not configured (provider is \"none\"); set provider in the coordinator config to enable it");
  }
}
