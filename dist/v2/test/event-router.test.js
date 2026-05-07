// Tests for the top-level event router (SPEC §6 / ANVIL-2 P1 fix).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventRouter } from "../render/event-router.js";
function makeRouter() {
    const log = [];
    const liveness = {
        eventCount: 0,
        tickCount: 0,
        recordEvent(_now, isTick) {
            this.eventCount++;
            if (isTick)
                this.tickCount++;
        },
    };
    const router = new EventRouter({
        onChatDelta: (payload) => log.push({ kind: "chatDelta", payload }),
        onChatFinal: (payload) => log.push({ kind: "chatFinal", payload }),
        onChatSideResult: (payload) => log.push({ kind: "chatSideResult", payload }),
        onAgent: (ap) => log.push({ kind: "agent", payload: ap }),
        onSessionsChanged: () => log.push({ kind: "sessionsChanged" }),
        onShutdown: (reason) => log.push({ kind: "shutdown", payload: reason }),
        onApprovalResolved: (kind) => log.push({ kind: `approval.${kind}.resolved` }),
        onUnknown: (event) => log.push({ kind: "unknown", payload: event }),
        onSeqGap: (runId, prevSeq, nextSeq) => log.push({ kind: "seqGap", payload: { runId, prevSeq, nextSeq } }),
    }, liveness);
    return { router, log, liveness };
}
function frame(event, payload) {
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
    const agentPayload = {
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
    const agentPayload = {
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
    const ap = {
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
// V1.1 — Item 1: SPEC §13 "Renderer: seq gap warning"
test("emits onSeqGap when an agent seq jumps by more than 1", () => {
    const { router, log } = makeRouter();
    const runId = "r1";
    router.dispatch(frame("agent", {
        runId, seq: 1, stream: "tool", ts: 0, data: { toolCallId: "tc1" },
    }));
    // seq=2 missed entirely; the gateway sends us seq=4 next.
    router.dispatch(frame("agent", {
        runId, seq: 4, stream: "tool", ts: 0, data: { toolCallId: "tc4" },
    }));
    const gaps = log.filter((e) => e.kind === "seqGap");
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0]?.payload, { runId, prevSeq: 1, nextSeq: 4 });
    // The agent event itself is still rendered.
    const agents = log.filter((e) => e.kind === "agent");
    assert.equal(agents.length, 2);
});
test("does NOT emit onSeqGap when seq advances by exactly 1", () => {
    const { router, log } = makeRouter();
    const runId = "r1";
    for (let seq = 1; seq <= 5; seq++) {
        router.dispatch(frame("agent", {
            runId, seq, stream: "tool", ts: 0, data: { toolCallId: `tc${seq}` },
        }));
    }
    assert.equal(log.filter((e) => e.kind === "seqGap").length, 0);
    assert.equal(log.filter((e) => e.kind === "agent").length, 5);
});
test("does NOT emit onSeqGap when out-of-order agent events arrive (already deduped)", () => {
    // The dedupe layer collapses repeat keys before gap-detection runs,
    // so a chat.history replay that re-sends previously-seen events
    // produces no spurious gap warnings even though the seq numbers
    // appear out of order.
    const { router, log } = makeRouter();
    const runId = "r1";
    router.dispatch(frame("agent", {
        runId, seq: 5, stream: "tool", ts: 0, data: { toolCallId: "tc5" },
    }));
    router.dispatch(frame("agent", {
        runId, seq: 5, stream: "tool", ts: 0, data: { toolCallId: "tc5" },
    }));
    assert.equal(log.filter((e) => e.kind === "seqGap").length, 0);
    assert.equal(log.filter((e) => e.kind === "agent").length, 1);
});
// V1.1 — Item 1: SPEC §13 "Reconnect: in-flight run recovery via chat.history"
// The router-level guarantee is: a chat.history replay that re-sends
// already-seen events deduplicates against the live event set, so no
// duplicate output is rendered.
test("chat.history replay does not double-render events the router has already seen", () => {
    const { router, log } = makeRouter();
    const runId = "r1";
    const live = [
        { runId, seq: 1, stream: "tool", ts: 0, data: { toolCallId: "tc1" } },
        { runId, seq: 2, stream: "tool", ts: 0, data: { toolCallId: "tc2" } },
        { runId, seq: 3, stream: "tool", ts: 0, data: { toolCallId: "tc3" } },
    ];
    for (const ap of live)
        router.dispatch(frame("agent", ap));
    assert.equal(log.filter((e) => e.kind === "agent").length, 3);
    // Simulate a reconnect: chat.history returns the events we already
    // received PLUS one event we missed (seq=4). Replay through the
    // same router.
    const replay = [
        ...live,
        { runId, seq: 4, stream: "tool", ts: 0, data: { toolCallId: "tc4" } },
    ];
    for (const ap of replay)
        router.dispatch(frame("agent", ap));
    // Total unique agent events = 4. Seq-gap warning must not fire
    // (we have an unbroken 1..4 sequence).
    assert.equal(log.filter((e) => e.kind === "agent").length, 4);
    assert.equal(log.filter((e) => e.kind === "seqGap").length, 0);
});
