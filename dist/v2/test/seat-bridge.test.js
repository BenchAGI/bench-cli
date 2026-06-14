import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSeatCaptureFromEnv, buildSeatSystemEventText, defaultWakeForEvent, extractHookCaptureText, normalizeSeatEvent, } from "../commands/seat-bridge.js";
import { buildCodexLaunchArgs, codexProjectTrustConfig, } from "../launcher/seat.js";
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
    assert.equal(codexProjectTrustConfig(workspace), 'projects."/Users/example/.config/benchagi/codex-seat-workspace".trust_level="trusted"');
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
    assert.equal(buildSeatSystemEventText({
        agentId: "aurelius",
        seatKind: "claude-code",
        seatSessionId: "seat-1",
        event: "user_prompt",
        summary: "review the launcher bridge",
        text: "review the launcher bridge",
        ts: "2026-06-12T00:00:00.000Z",
    }), "Local Claude Code seat capture | agent=aurelius | event=user_prompt | summary=review the launcher bridge");
});
