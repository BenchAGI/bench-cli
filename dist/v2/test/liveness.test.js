// Liveness two-clock model (SPEC §7 / ANVIL-2 P1 fix).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatStatus } from "../render/liveness.js";
test("formatStatus shows both clocks", () => {
    const out = formatStatus({
        agentId: "aurelius",
        pid: 42,
        runQuietMs: 7_000,
        gatewayTickMs: 1_500,
        stuck: false,
        unhealthyTick: false,
        spinnerFrame: "⠋",
    });
    assert.match(out, /run quiet 7s/);
    assert.match(out, /gateway tick 2s/);
    assert.match(out, /pid 42/);
    assert.match(out, /Ctrl-C abort/);
});
test("formatStatus marks stuck when run quiet long but tick fresh", () => {
    const out = formatStatus({
        agentId: "ember",
        pid: 1,
        runQuietMs: 130_000,
        gatewayTickMs: 1_000,
        stuck: true,
        unhealthyTick: false,
        spinnerFrame: "⠋",
    });
    assert.match(out, /may be stuck/);
});
test("formatStatus marks unhealthy when tick stale", () => {
    const out = formatStatus({
        agentId: "ember",
        pid: 1,
        runQuietMs: 5_000,
        gatewayTickMs: 200_000,
        stuck: false,
        unhealthyTick: true,
        spinnerFrame: "⠋",
    });
    assert.match(out, /connection unhealthy/);
});
// V1.1 — Item 2: SPEC §13 "Liveness: (reconnecting attempt N) label correct"
test("formatStatus shows truthful reconnect label when reconnectAttempt is set", () => {
    const out = formatStatus({
        agentId: "ember",
        pid: 1,
        runQuietMs: 5_000,
        gatewayTickMs: 1_000,
        stuck: false,
        unhealthyTick: false,
        spinnerFrame: "⠋",
        reconnectAttempt: 3,
        reconnectDelayMs: 5_000,
    });
    assert.match(out, /reconnecting attempt 3 in 5s/);
    // The unhealthy/stuck heuristics did NOT fire — only the truthful label.
    assert.doesNotMatch(out, /connection unhealthy/);
    assert.doesNotMatch(out, /may be stuck/);
});
test("formatStatus reconnect label takes precedence over unhealthyTick", () => {
    const out = formatStatus({
        agentId: "ember",
        pid: 1,
        runQuietMs: 5_000,
        gatewayTickMs: 200_000,
        stuck: false,
        unhealthyTick: true,
        spinnerFrame: "⠋",
        reconnectAttempt: 2,
        reconnectDelayMs: 2_000,
    });
    // Reconnect is the load-bearing truth; the heuristic-based label is suppressed.
    assert.match(out, /reconnecting attempt 2 in 2s/);
    assert.doesNotMatch(out, /connection unhealthy/);
});
test("formatStatus reconnect label without delayMs renders without 'in Ns'", () => {
    const out = formatStatus({
        agentId: "ember",
        pid: 1,
        runQuietMs: 0,
        gatewayTickMs: 0,
        stuck: false,
        unhealthyTick: false,
        spinnerFrame: "⠋",
        reconnectAttempt: 1,
        // delay omitted
    });
    assert.match(out, /reconnecting attempt 1\)/);
    assert.doesNotMatch(out, /reconnecting attempt 1 in/);
});
