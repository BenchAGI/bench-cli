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
