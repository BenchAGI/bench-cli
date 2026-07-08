// Tests for the desktop-seat launch path: deep-link shape, the remembered
// workspace agent, and how `benchagi desktop` picks who to seat.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pickDesktopAgent } from "../commands/desktop.js";
import { desktopSeatDeepLink, readSeatSettingsAgentId } from "../launcher/seat.js";
import type { LauncherAgent } from "../launcher/roster.js";

const aurelius: LauncherAgent = {
  agentId: "aurelius",
  name: "Aurelius",
  role: "Chief Operating Officer",
  modelShort: "Sonnet 5",
  emoji: "🦅",
};
const zig: LauncherAgent = {
  agentId: "zig",
  name: "Zig",
  role: "Engineer",
  modelShort: "Sonnet 5",
  emoji: "⚡",
};

test("desktop deep link targets claude://code/new with an encoded folder", () => {
  assert.equal(
    desktopSeatDeepLink("/Users/example/.config/benchagi/seat-workspace"),
    "claude://code/new?folder=%2FUsers%2Fexample%2F.config%2Fbenchagi%2Fseat-workspace",
  );
  // Spaces and unicode must survive URL parsing.
  assert.equal(
    desktopSeatDeepLink("/tmp/seat space"),
    "claude://code/new?folder=%2Ftmp%2Fseat%20space",
  );
});

function workspaceWithSettings(content?: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "desktop-seat-test-"));
  if (content !== undefined) {
    const claudeDir = join(workspace, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), content, "utf8");
  }
  return workspace;
}

test("readSeatSettingsAgentId reads the baked agent and tolerates absence/corruption", () => {
  const baked = workspaceWithSettings(JSON.stringify({ env: { BENCHAGI_SEAT_AGENT_ID: "aurelius" } }));
  assert.equal(readSeatSettingsAgentId(baked), "aurelius");
  assert.equal(readSeatSettingsAgentId(workspaceWithSettings()), undefined);
  assert.equal(readSeatSettingsAgentId(workspaceWithSettings("{ not json")), undefined);
  assert.equal(readSeatSettingsAgentId(workspaceWithSettings(JSON.stringify({ env: {} }))), undefined);
});

test("pickDesktopAgent: explicit agent matches by id or name, or fails loudly", () => {
  const roster = [aurelius, zig];
  assert.equal(pickDesktopAgent(roster, { explicit: "zig" }).agent, zig);
  assert.equal(pickDesktopAgent(roster, { explicit: "AURELIUS" }).agent, aurelius);
  const miss = pickDesktopAgent(roster, { explicit: "nobody" });
  assert.equal(miss.agent, undefined);
  assert.match(miss.error ?? "", /not in your roster.*aurelius, zig/);
});

test("pickDesktopAgent: remembered agent wins, degrades softly, roster head is the default", () => {
  const roster = [aurelius, zig];
  assert.equal(pickDesktopAgent(roster, { remembered: "zig" }).agent, zig);
  // Entitlements changed since the workspace was last baked — fall back, don't fail.
  assert.equal(pickDesktopAgent(roster, { remembered: "gone" }).agent, aurelius);
  assert.equal(pickDesktopAgent(roster, {}).agent, aurelius);
  const empty = pickDesktopAgent([], {});
  assert.equal(empty.agent, undefined);
  assert.match(empty.error ?? "", /no agents available/);
});
