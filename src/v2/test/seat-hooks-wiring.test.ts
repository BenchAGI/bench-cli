import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeCodexHooks } from "../launcher/seat.js";

// dist/v2/test/<file>.js -> repo root is three levels up; read the SOURCE
// template that ensureClaudeSeatWorkspace() cpSyncs into every seat workspace.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const claudeSettingsPath = join(repoRoot, "src", "v2", "assets", ".claude", "settings.json");

type HookGroup = { hooks?: Array<{ command?: string }> };

function commandsFor(hooks: Record<string, HookGroup[]>, event: string): string[] {
  const groups = hooks[event] ?? [];
  return groups.flatMap((group) => (group.hooks ?? []).map((h) => h.command ?? ""));
}

function assertSeatHookWired(
  hooks: Record<string, HookGroup[]>,
  event: string,
  seatEvent: string,
  hookToken: string,
) {
  const commands = commandsFor(hooks, event);
  const match = commands.find((c) => c.includes(hookToken) && c.includes(seatEvent));
  assert.ok(match, `expected ${event} to wire a seat-bridge command for "${seatEvent}"\n${JSON.stringify(commands)}`);
}

test("Claude seat settings wire all four seat-bridge hooks", () => {
  const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
    hooks: Record<string, HookGroup[]>;
  };
  const { hooks } = settings;
  assertSeatHookWired(hooks, "SessionStart", "session_start", "$BENCHAGI_SEAT_HOOK");
  assertSeatHookWired(hooks, "UserPromptSubmit", "user_prompt", "$BENCHAGI_SEAT_HOOK");
  assertSeatHookWired(hooks, "PostToolUse", "tool_result", "$BENCHAGI_SEAT_HOOK");
  assertSeatHookWired(hooks, "Stop", "session_stop", "$BENCHAGI_SEAT_HOOK");
});

test("Claude seat settings wire the memory-guard hook into Stop + SessionStart", () => {
  // The self-maintaining memory index (bench-harness #101/#103) keeps MEMORY.md under the
  // cold-start load budget. It needs the no-churn guard wired on Stop (coalesces a turn's
  // memory writes) and SessionStart (catches out-of-band growth). Defensively wrapped, so a
  // seat without the deployed guard script is a silent no-op.
  const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
    hooks: Record<string, HookGroup[]>;
  };
  const { hooks } = settings;
  for (const event of ["Stop", "SessionStart"]) {
    const match = commandsFor(hooks, event).find((c) => c.includes("memory-guard-hook.mjs"));
    assert.ok(
      match,
      `expected ${event} to wire the memory-guard hook\n${JSON.stringify(commandsFor(hooks, event))}`,
    );
  }
});

test("Codex seat hooks wire all four seat-bridge events", () => {
  const workspace = mkdtempSync(join(tmpdir(), "codex-hooks-test-"));
  writeCodexHooks(workspace, {
    BENCHAGI_BIN: "benchagi",
    BENCHAGI_SEAT_AGENT_ID: "aurelius",
    BENCHAGI_SEAT_KIND: "codex-cli",
    BENCHAGI_SEAT_SESSION_ID: "s1",
  });
  const generated = JSON.parse(
    readFileSync(join(workspace, ".codex", "hooks.json"), "utf8"),
  ) as { hooks: Record<string, HookGroup[]> };
  const { hooks } = generated;
  // The seat hook is invoked as `node <…/seat-bridge-hook.mjs> <event>`.
  assertSeatHookWired(hooks, "SessionStart", "session_start", "seat-bridge-hook.mjs");
  assertSeatHookWired(hooks, "UserPromptSubmit", "user_prompt", "seat-bridge-hook.mjs");
  assertSeatHookWired(hooks, "PostToolUse", "tool_result", "seat-bridge-hook.mjs");
  assertSeatHookWired(hooks, "Stop", "session_stop", "seat-bridge-hook.mjs");
});
