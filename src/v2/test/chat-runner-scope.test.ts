import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  resolveFrameRunId,
  resolveFrameSessionKey,
  shouldDispatchFrameForActiveRun,
} from "../chat-runner.js";

test("frame scoping reads sessionKey from top-level and nested data", () => {
  assert.equal(
    resolveFrameSessionKey({
      event: "chat",
      payload: { sessionKey: "agent:a:cli", runId: "r1" },
    }),
    "agent:a:cli",
  );
  assert.equal(
    resolveFrameSessionKey({
      event: "agent",
      payload: { runId: "r1", data: { sessionKey: "agent:a:cli" } },
    }),
    "agent:a:cli",
  );
});

test("frame scoping reads runId from top-level and nested data", () => {
  assert.equal(resolveFrameRunId({ event: "chat", payload: { runId: "r1" } }), "r1");
  assert.equal(resolveFrameRunId({ event: "agent", payload: { data: { runId: "r2" } } }), "r2");
});

test("frame scoping rejects other sessions and inactive runs", () => {
  const args = {
    sessionKey: "agent:aurelius:cli",
    activeRunIds: new Set(["run-current"]),
  };
  assert.equal(
    shouldDispatchFrameForActiveRun({
      event: "chat",
      payload: { sessionKey: "agent:other:cli", runId: "run-current" },
    }, args),
    false,
  );
  assert.equal(
    shouldDispatchFrameForActiveRun({
      event: "agent",
      payload: { sessionKey: "agent:aurelius:cli", runId: "run-bootstrap" },
    }, args),
    false,
  );
});

test("frame scoping allows the active run plus global liveness events", () => {
  const args = {
    sessionKey: "agent:aurelius:cli",
    activeRunIds: new Set(["run-current"]),
  };
  assert.equal(
    shouldDispatchFrameForActiveRun({
      event: "chat",
      payload: { sessionKey: "agent:aurelius:cli", runId: "run-current" },
    }, args),
    true,
  );
  assert.equal(shouldDispatchFrameForActiveRun({ event: "tick" }, args), true);
  assert.equal(shouldDispatchFrameForActiveRun({ event: "shutdown" }, args), true);
});
