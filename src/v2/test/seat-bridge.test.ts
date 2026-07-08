import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildSeatCaptureFromEnv,
  buildSeatSystemEventText,
  defaultWakeForEvent,
  extractHookCaptureText,
  hookSessionId,
  normalizeSeatEvent,
} from "../commands/seat-bridge.js";
import {
  buildCodexLaunchArgs,
  codexProjectTrustConfig,
} from "../launcher/seat.js";

test("seat bridge extracts prompt text from JSON hook payloads", () => {
  const extracted = extractHookCaptureText(JSON.stringify({ prompt: "review the launch" }), "user_prompt");
  assert.equal(extracted.summary, "review the launch");
  assert.equal(extracted.text, "review the launch");
});

test("seat bridge falls back to summary event for unknown events", () => {
  assert.equal(normalizeSeatEvent("not-a-real-event"), "summary");
});

test("seat bridge only wakes harness for prompt-like events by default", () => {
  assert.equal(defaultWakeForEvent("session_start"), true);
  assert.equal(defaultWakeForEvent("user_prompt"), true);
  assert.equal(defaultWakeForEvent("summary"), true);
  assert.equal(defaultWakeForEvent("session_stop"), true);
  assert.equal(defaultWakeForEvent("tool_result"), false);
});

test("seat bridge emits OpenClaw-compatible ISO timestamps", () => {
  const capture = buildSeatCaptureFromEnv({
    event: "user_prompt",
    rawHookPayload: JSON.stringify({ prompt: "review the launch" }),
  });
  assert.equal(typeof capture.ts, "string");
  assert.ok(Number.isFinite(Date.parse(capture.ts)), capture.ts);
});

test("Codex seats force hooks on for the generated trusted workspace", () => {
  const workspace = "/Users/example/.config/benchagi/codex-seat-workspace";
  assert.equal(
    codexProjectTrustConfig(workspace),
    'projects."/Users/example/.config/benchagi/codex-seat-workspace".trust_level="trusted"',
  );
  assert.deepEqual(buildCodexLaunchArgs(workspace, {
    model: "gpt-5.5",
    effort: "xhigh",
    thinking: "collapsed",
  }), [
    "--cd",
    workspace,
    "--dangerously-bypass-hook-trust",
    "-c",
    "features.hooks=true",
    "-c",
    'projects."/Users/example/.config/benchagi/codex-seat-workspace".trust_level="trusted"',
    "--model",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="xhigh"',
    "-c",
    'model_reasoning_summary="auto"',
  ]);
});

test("seat bridge formats fallback system events without raw transcript flood", () => {
  assert.equal(
    buildSeatSystemEventText({
      agentId: "aurelius",
      seatKind: "claude-code",
      seatSessionId: "seat-1",
      event: "user_prompt",
      summary: "review the launcher bridge",
      text: "review the launcher bridge",
      ts: "2026-06-12T00:00:00.000Z",
    }),
    "Local Claude Code seat capture | agent=aurelius | event=user_prompt | summary=review the launcher bridge",
  );
});

// The test process may itself run inside a seat, so pin the env per test.
function withSeatSessionEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.BENCHAGI_SEAT_SESSION_ID;
  if (value === undefined) delete process.env.BENCHAGI_SEAT_SESSION_ID;
  else process.env.BENCHAGI_SEAT_SESSION_ID = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.BENCHAGI_SEAT_SESSION_ID;
    else process.env.BENCHAGI_SEAT_SESSION_ID = prior;
  }
}

test("capture keeps the launcher session id authoritative over the hook payload's", () => {
  const capture = withSeatSessionEnv("launcher-id", () =>
    buildSeatCaptureFromEnv({
      event: "user_prompt",
      rawHookPayload: JSON.stringify({ session_id: "claude-id", prompt: "hi" }),
    }),
  );
  assert.equal(capture.seatSessionId, "launcher-id");
});

test("capture falls back to Claude's session_id from the hook payload", () => {
  const capture = withSeatSessionEnv(undefined, () =>
    buildSeatCaptureFromEnv({
      event: "user_prompt",
      rawHookPayload: JSON.stringify({ session_id: "claude-window-1", prompt: "hi" }),
    }),
  );
  assert.equal(capture.seatSessionId, "claude-window-1");
});

test("capture mints per-invocation ids only when no launcher env and no payload id", () => {
  const [first, second] = withSeatSessionEnv(undefined, () => [
    buildSeatCaptureFromEnv({ event: "tool_result", rawHookPayload: "{}" }),
    buildSeatCaptureFromEnv({ event: "tool_result", rawHookPayload: "{}" }),
  ]);
  assert.match(first.seatSessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.seatSessionId, second.seatSessionId);
});

test("hookSessionId reads nested payload shapes and ignores non-JSON", () => {
  assert.equal(hookSessionId(JSON.stringify({ data: { session_id: "nested-1" } })), "nested-1");
  assert.equal(hookSessionId("plain text, not json"), undefined);
  assert.equal(hookSessionId(undefined), undefined);
});
