// LivenessIndicator.snapshot() — structured health for the TUI status bar (managed mode).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LivenessIndicator } from "../render/liveness.js";

function make(now: () => number) {
  return new LivenessIndicator({
    agentId: "aurelius",
    pid: 1,
    livenessThresholdMs: 5_000,
    unhealthyTickThresholdMs: 15_000,
    stuckRunThresholdMs: 120_000,
    managed: true,
    now,
  });
}

test("idle (not in flight) reports ok", () => {
  let clock = 1_000_000;
  const li = make(() => clock);
  const snap = li.snapshot();
  assert.equal(snap.state, "ok");
  assert.equal(snap.inFlight, false);
});

test("in flight with a long quiet run but fresh tick → stuck", () => {
  let clock = 1_000_000;
  const li = make(() => clock);
  li.recordLifecycleStart(); // lastEvent = clock, inFlight = true
  clock += 130_000; // run quiet 130s > 120s threshold
  li.recordEvent(clock, true); // fresh gateway tick
  const snap = li.snapshot();
  assert.equal(snap.state, "stuck");
  assert.equal(snap.inFlight, true);
});

test("stale gateway tick → unhealthy", () => {
  let clock = 1_000_000;
  const li = make(() => clock);
  li.recordLifecycleStart();
  li.recordEvent(clock, true); // anchor lastTick to the fake clock
  li.recordEvent(clock, false); // recent run event → runQuiet small
  clock += 20_000; // gateway tick now 20s > 15s threshold
  assert.equal(li.snapshot().state, "unhealthy");
});

test("active reconnect takes precedence", () => {
  let clock = 1_000_000;
  const li = make(() => clock);
  li.recordLifecycleStart();
  clock += 200_000; // would otherwise be stuck
  li.setReconnecting(2, 1_000);
  const snap = li.snapshot();
  assert.equal(snap.state, "reconnecting");
  assert.equal(snap.reconnectAttempt, 2);
  li.clearReconnecting();
  assert.equal(li.snapshot().reconnectAttempt, null);
});

test("managed mode never throws on start (no painting timer)", () => {
  const li = make(() => 1);
  assert.doesNotThrow(() => {
    li.start();
    li.setReconnecting(1, 500);
    li.clearReconnecting();
    li.stop();
  });
});
