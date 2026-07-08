// Tests for the config-carried seat env: the launch-independent subset that the
// spawn path (bridgeEnv) and the workspace settings.local.json writer share, so
// a desktop (non-spawn) launch boots the same seat as the CLI.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bridgeEnv, staticSeatEnv, writeSeatSettingsEnv } from "../launcher/seat.js";
import type { LauncherAgent } from "../launcher/roster.js";

const agent: LauncherAgent = {
  agentId: "aurelius",
  name: "Aurelius",
  role: "Chief Operating Officer",
  modelShort: "Sonnet 5",
  emoji: "🦅",
};

function makeStaticEnv(): Record<string, string> {
  return staticSeatEnv({
    agent,
    seatKind: "claude-code",
    gatewayUrl: "http://127.0.0.1:18789",
    workspace: "/tmp/seat-ws",
  });
}

test("staticSeatEnv carries the launch-independent seat vars, and only those", () => {
  const env = makeStaticEnv();
  assert.equal(env.BENCHAGI_SEAT_AGENT_ID, "aurelius");
  assert.equal(env.BENCHAGI_SEAT_AGENT_NAME, "Aurelius");
  assert.equal(env.BENCHAGI_SEAT_CWD, "/tmp/seat-ws");
  assert.equal(env.BENCHAGI_SEAT_GATEWAY_URL, "http://127.0.0.1:18789");
  assert.equal(env.BENCHAGI_SEAT_KIND, "claude-code");
  assert.ok(env.BENCHAGI_SEAT_HOOK?.endsWith("seat-bridge-hook.mjs"));
  assert.ok(env.BENCHAGI_BIN);
  // Status-line identity rides along so a desktop launch renders the agent.
  assert.equal(env.BENCH_AGENT_ID, "aurelius");
  assert.equal(env.BENCH_AGENT_NAME, "Aurelius");
  assert.equal(env.BENCH_AGENT_EMOJI, "🦅");
  // Per-session vars must never be baked into the workspace settings.
  for (const key of [
    "BENCHAGI_SEAT_SESSION_ID",
    "BENCHAGI_SEAT_PROVIDER_VERSION",
    "BENCHAGI_SEAT_EFFORT",
    "BENCHAGI_SEAT_THINKING",
    "BENCH_AGENT_MODEL_SHORT",
    "CLAUDE_CODE_EFFORT_LEVEL",
  ]) {
    assert.ok(!(key in env), `${key} must stay per-launch, not config-carried`);
  }
  for (const [key, value] of Object.entries(env)) {
    assert.ok(typeof value === "string" && value.length > 0, `${key} must be a non-empty string`);
  }
});

test("bridgeEnv layers per-session vars over the static env without altering it", () => {
  const staticEnv = makeStaticEnv();
  const env = bridgeEnv({
    staticEnv,
    agent,
    seatSessionId: "session-1",
    providerVersion: "claude-sonnet-5",
    effort: "high",
  });
  for (const [key, value] of Object.entries(staticEnv)) {
    assert.equal(env[key], value, `bridgeEnv must carry static ${key} unchanged`);
  }
  assert.equal(env.BENCHAGI_SEAT_SESSION_ID, "session-1");
  assert.equal(env.BENCHAGI_SEAT_PROVIDER_VERSION, "claude-sonnet-5");
  assert.equal(env.BENCHAGI_SEAT_EFFORT, "high");
});

test("writeSeatSettingsEnv creates settings.local.json with the env block", () => {
  const workspace = mkdtempSync(join(tmpdir(), "seat-settings-test-"));
  const staticEnv = makeStaticEnv();
  writeSeatSettingsEnv(workspace, staticEnv);
  const written = JSON.parse(
    readFileSync(join(workspace, ".claude", "settings.local.json"), "utf8"),
  ) as { env: Record<string, string> };
  assert.deepEqual(written.env, staticEnv);
});

test("writeSeatSettingsEnv merges: foreign settings and env keys survive, ours update", () => {
  const workspace = mkdtempSync(join(tmpdir(), "seat-settings-test-"));
  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.local.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      env: { MY_CUSTOM: "keep-me", BENCHAGI_SEAT_GATEWAY_URL: "http://old:1" },
    }),
    "utf8",
  );
  writeSeatSettingsEnv(workspace, makeStaticEnv());
  const written = JSON.parse(
    readFileSync(join(claudeDir, "settings.local.json"), "utf8"),
  ) as { permissions: { allow: string[] }; env: Record<string, string> };
  assert.deepEqual(written.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(written.env.MY_CUSTOM, "keep-me");
  assert.equal(written.env.BENCHAGI_SEAT_GATEWAY_URL, "http://127.0.0.1:18789");
});

test("writeSeatSettingsEnv leaves an unparseable settings.local.json untouched", () => {
  const workspace = mkdtempSync(join(tmpdir(), "seat-settings-test-"));
  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const file = join(claudeDir, "settings.local.json");
  writeFileSync(file, "{ not json", "utf8");
  writeSeatSettingsEnv(workspace, makeStaticEnv());
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});
