import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultWakeForEvent, extractHookCaptureText, normalizeSeatEvent, } from "../commands/seat-bridge.js";
test("seat bridge extracts prompt text from JSON hook payloads", () => {
    const extracted = extractHookCaptureText(JSON.stringify({ prompt: "review the launch" }), "user_prompt");
    assert.equal(extracted.summary, "review the launch");
    assert.equal(extracted.text, "review the launch");
});
test("seat bridge falls back to summary event for unknown events", () => {
    assert.equal(normalizeSeatEvent("not-a-real-event"), "summary");
});
test("seat bridge only wakes harness for prompt-like events by default", () => {
    assert.equal(defaultWakeForEvent("user_prompt"), true);
    assert.equal(defaultWakeForEvent("summary"), true);
    assert.equal(defaultWakeForEvent("session_start"), false);
    assert.equal(defaultWakeForEvent("session_stop"), false);
});
