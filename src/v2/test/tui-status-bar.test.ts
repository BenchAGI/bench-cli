// Dense status-bar segment builder (pure).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildStatusSegments, type StatusBarState } from "../tui/status-bar.js";

const base: StatusBarState = { agentId: "aurelius", health: "ok" };

function keys(s: StatusBarState): string[] {
  return buildStatusSegments(s).map((x) => x.key);
}
function seg(s: StatusBarState, key: string) {
  return buildStatusSegments(s).find((x) => x.key === key);
}

test("minimal state shows agent + health", () => {
  const segs = buildStatusSegments(base);
  assert.deepEqual(segs.map((s) => s.key), ["agent", "health"]);
  assert.match(segs[0]!.text, /🦅 Aurelius/);
  assert.match(segs[1]!.text, /live/);
});

test("model and tier render with colors", () => {
  const segs = buildStatusSegments({ ...base, model: "Opus 4.8", tier: { level: "Legendary", color: "Orange" } });
  assert.equal(seg({ ...base, model: "Opus 4.8" }, "model")?.text, "Opus 4.8");
  const tier = segs.find((s) => s.key === "tier");
  assert.equal(tier?.text, "Legendary");
  assert.equal(tier?.color, "#ff8c42"); // orange tier hex
});

test("pending approval surfaces a 🔔 segment", () => {
  assert.ok(!keys(base).includes("approval"));
  const segs = buildStatusSegments({ ...base, pendingApproval: true });
  const a = segs.find((s) => s.key === "approval");
  assert.match(a!.text, /needs you/);
});

test("health states map to distinct labels", () => {
  assert.match(seg({ ...base, health: "reconnecting" }, "health")!.text, /reconnecting/);
  assert.match(seg({ ...base, health: "stuck" }, "health")!.text, /stuck/);
  assert.match(seg({ ...base, health: "idle" }, "health")!.text, /idle/);
});

test("token slot stays dark unless a number is provided (never fabricated)", () => {
  assert.ok(!keys(base).includes("tokens"));
  assert.ok(!keys({ ...base, tokens: null }).includes("tokens"));
  const segs = buildStatusSegments({ ...base, tokens: 12345 });
  assert.equal(segs.find((s) => s.key === "tokens")?.text, "12k tok");
  assert.equal(buildStatusSegments({ ...base, tokens: 2_400_000 }).find((s) => s.key === "tokens")?.text, "2.4M tok");
});

test("thinking indicator only shows when off or collapsed", () => {
  assert.ok(!keys({ ...base, thinking: "on" }).includes("thinking"));
  assert.match(seg({ ...base, thinking: "off" }, "thinking")!.text, /off/);
  assert.match(seg({ ...base, thinking: "collapsed" }, "thinking")!.text, /⊟/);
});

test("session short id renders when present", () => {
  assert.equal(seg({ ...base, sessionShort: "a1b2c3" }, "sess")?.text, "sess a1b2c3");
});
