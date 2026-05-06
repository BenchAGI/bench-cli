// Tests for the top-level event router (SPEC §6 / ANVIL-2 P1 fix).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventRouter } from "../render/event-router.js";
import type { EventFrame, AgentEventPayload } from "../protocol/types.js";

type LogEntry = { kind: string; payload?: unknown };

function makeRouter() {
  const log: LogEntry[] = [];
  const liveness = {
    eventCount: 0,
    tickCount: 0,
    recordEvent(_now: number, isTick: boolean) {
      this.eventCount++;
      if (isTick) this.tickCount++;
    },
  };
  const router = new EventRouter(
    {
      onChatDelta: (payload) => log.push({ kind: "chatDelta", payload }),
      onChatFinal: (payload) => log.push({ kind: "chatFinal", payload }),
      onChatSideResult: (payload) => log.push({ kind: "chatSideResult", payload }),
      onAgent: (ap) => log.push({ kind: "agent", payload: ap }),
      onSessionsChanged: () => log.push({ kind: "sessionsChanged" }),
      onShutdown: (reason) => log.push({ kind: "shutdown", payload: reason }),
      onApprovalResolved: (kind) => log.push({ kind: `approval.${kind}.resolved` }),
      onUnknown: (event) => log.push({ kind: "unknown", payload: event }),
    },
    liveness,
  );
  return { router, log, liveness };
}

function frame(event: string, payload?: unknown): EventFrame {
  return { type: "event", event, payload };
}

test("routes chat delta", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("chat", { state: "delta", delta: "Hello" }));
  assert.equal(log.length, 1);
  assert.equal(log[0]?.kind, "chatDelta");
});

test("routes chat final on state=final", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("chat", { state: "final", text: "done" }));
  assert.equal(log[0]?.kind, "chatFinal");
});

test("routes chat.side_result", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("chat.side_result", { title: "side" }));
  assert.equal(log[0]?.kind, "chatSideResult");
});

test("unwraps agent envelope into taxonomy renderer", () => {
  const { router, log } = makeRouter();
  const agentPayload: AgentEventPayload = {
    runId: "r1",
    seq: 0,
    stream: "lifecycle",
    ts: 0,
    data: { phase: "started", runId: "r1" },
  };
  router.dispatch(frame("agent", agentPayload));
  assert.equal(log[0]?.kind, "agent");
});

test("dedupes session.tool against agent for same key", () => {
  const { router, log } = makeRouter();
  const agentPayload: AgentEventPayload = {
    runId: "r1",
    seq: 5,
    stream: "tool",
    ts: 0,
    data: { phase: "start", name: "Read", toolCallId: "tc1" },
  };
  router.dispatch(frame("agent", agentPayload));
  router.dispatch(frame("session.tool", agentPayload));
  // Both events would normally hit onAgent; dedupe makes only the first land.
  const agentHits = log.filter((e) => e.kind === "agent");
  assert.equal(agentHits.length, 1);
});

test("session.tool late-join arrives if not seen", () => {
  const { router, log } = makeRouter();
  const ap: AgentEventPayload = {
    runId: "r1",
    seq: 7,
    stream: "tool",
    ts: 0,
    data: { phase: "end", name: "Read", toolCallId: "tc1" },
  };
  router.dispatch(frame("session.tool", ap));
  assert.equal(log.length, 1);
  assert.equal(log[0]?.kind, "agent");
});

test("tick events update liveness only, no render", () => {
  const { router, log, liveness } = makeRouter();
  router.dispatch(frame("tick", { ts: 0 }));
  assert.equal(log.length, 0);
  assert.equal(liveness.tickCount, 1);
});

test("shutdown is rendered with reason", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("shutdown", { reason: "rotate", restartExpectedMs: 5000 }));
  assert.equal(log[0]?.kind, "shutdown");
  assert.equal(log[0]?.payload, "rotate");
});

test("exec.approval.resolved routes to handler", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("exec.approval.resolved", { approvalId: "a1", status: "approved" }));
  assert.equal(log[0]?.kind, "approval.exec.resolved");
});

test("plugin.approval.resolved routes to handler", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("plugin.approval.resolved", { approvalId: "a2", status: "denied" }));
  assert.equal(log[0]?.kind, "approval.plugin.resolved");
});

test("unknown events go to onUnknown without crashing", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("ufo.event"));
  assert.equal(log[0]?.kind, "unknown");
  assert.equal(log[0]?.payload, "ufo.event");
});

test("sessions.changed routes to handler", () => {
  const { router, log } = makeRouter();
  router.dispatch(frame("sessions.changed", {}));
  assert.equal(log[0]?.kind, "sessionsChanged");
});
