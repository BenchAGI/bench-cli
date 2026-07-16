import assert from "node:assert/strict";
import { test } from "node:test";
import { __testing } from "../excalibur/cli.js";
test("Excalibur recognizes commands only in the leading positional slot", () => {
    assert.equal(__testing.parseArgs(["views"]).command, "views");
    const prompt = __testing.parseArgs(["tell", "me", "about", "views"]);
    assert.equal(prompt.command, null);
    assert.deepEqual(prompt.positional, ["tell", "me", "about", "views"]);
});
test("Excalibur parses private trace and classic surface flags", () => {
    const parsed = __testing.parseArgs(["--classic", "--trace-frames", "/tmp/trace.jsonl", "ask", "hello"]);
    assert.equal(parsed.classic, true);
    assert.equal(parsed.traceFramesPath, "/tmp/trace.jsonl");
    assert.equal(parsed.command, "ask");
    assert.deepEqual(parsed.positional, ["hello"]);
});
test("Excalibur does not recognize the legacy direct ACP command and parses only loopback sidecar overrides", () => {
    const diagnostic = __testing.parseArgs(["legacy-grok-acp", "ping"]);
    assert.equal(diagnostic.command, null);
    assert.deepEqual(diagnostic.positional, ["legacy-grok-acp", "ping"]);
    const sidecar = __testing.parseArgs(["--sidecar=http://127.0.0.1:4178", "ask", "hello"]);
    assert.equal(sidecar.sidecarUrl, "http://127.0.0.1:4178");
    assert.throws(() => __testing.parseArgs(["--gateway", "ws://127.0.0.1:18789"]), /unknown option/);
});
test("Excalibur preserves private calendar and memory configure arguments", () => {
    const memory = __testing.parseArgs([
        "memory", "configure", "--shelf", "/private/SESSION_LANDMARKS.md",
    ]);
    assert.equal(memory.command, "memory");
    assert.deepEqual(memory.positional, ["configure", "--shelf", "/private/SESSION_LANDMARKS.md"]);
    const calendar = __testing.parseArgs([
        "calendar", "configure", "--account", "operator@example.test",
        "--calendar-id=primary", "--timezone", "America/Denver", "--consent-operator-summary",
    ]);
    assert.equal(calendar.command, "calendar");
    assert.deepEqual(calendar.positional, [
        "configure", "--account", "operator@example.test", "--calendar-id=primary",
        "--timezone", "America/Denver", "--consent-operator-summary",
    ]);
});
test("Excalibur exposes MIGHT status and keeps the launcher gate explicit", () => {
    assert.equal(__testing.parseArgs(["might"]).command, "might");
    const doctor = __testing.parseArgs(["doctor", "--launch-check"]);
    assert.equal(doctor.command, "doctor");
    assert.equal(doctor.launchCheck, true);
});
