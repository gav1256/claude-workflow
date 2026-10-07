import { test } from "node:test";
import assert from "node:assert/strict";
import { MockCoordinatorProvider, NullProvider, ProviderError } from "../provider.mjs";
import { emptyDecision } from "../schema.mjs";

test("M9 mock returns scripted decisions in order, records calls, throws mock-exhausted", async () => {
  const a = emptyDecision({ reply: "one" }), b = emptyDecision({ reply: "two" });
  const p = new MockCoordinatorProvider([a, (input) => ({ ...b, reply: `two:${input.message}` })]);
  assert.equal((await p.decide({ message: "m1" })).reply, "one");
  assert.equal((await p.decide({ message: "m2" })).reply, "two:m2");
  assert.deepEqual(p.calls.map((c) => c.message), ["m1", "m2"]);
  await assert.rejects(p.decide({ message: "m3" }), (e) => e instanceof ProviderError && e.code === "mock-exhausted");
  assert.equal(p.calls.length, 3);
});

test("M9 mock with one function is used for every call", async () => {
  const p = new MockCoordinatorProvider((input) => emptyDecision({ reply: input.message }));
  assert.equal((await p.decide({ message: "x" })).reply, "x");
  assert.equal((await p.decide({ message: "y" })).reply, "y");
});

test("M9 NullProvider throws no-provider", async () => {
  await assert.rejects(new NullProvider().decide({}), (e) => e instanceof ProviderError && e.code === "no-provider" && e.retryable === false);
});

test("ProviderError carries code and retryable", () => {
  const e = new ProviderError("rate", "slow", { retryable: true });
  assert.equal(e.code, "rate");
  assert.equal(e.retryable, true);
  assert.ok(e instanceof Error);
  assert.equal(new ProviderError("x", "y").retryable, false);
});
