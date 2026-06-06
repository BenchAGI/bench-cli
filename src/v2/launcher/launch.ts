// launch.ts — the BenchAGI launcher orchestrator: boot → update gate → auth gate
// → entitled-agent picker → per-agent handoff (cloud default, local power-option).

import { c, eprintln, println } from "../render/ansi.js";
import { CLI_VERSION } from "../commands/version.js";
import { commandAuthLogin } from "../commands/auth.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import type { Liveness } from "../probe/capability.js";

import { playBoot } from "./boot-bridge.js";
import { checkForUpdate, updateBanner } from "./updates.js";
import { loadAccount, resolveApiBase } from "./account.js";
import { resolveRoster } from "./roster.js";
import { runCloudSeat } from "./cloud-seat.js";
import { runLocalSeat } from "./seat.js";
import { runPicker } from "./picker.js";

export interface LaunchOpts {
  liveness?: Liveness;
  full?: boolean;
  noThinking?: boolean;
  traceFramesPath?: string;
}

export async function runLaunch(opts: LaunchOpts = {}): Promise<void> {
  await playBoot({});
  await maybePromptUpdate();
  await ensureAuthed();

  const agents = await resolveRoster();
  if (!agents.length) {
    eprintln(c.yellow("No agents available. Try `benchagi auth login`, or check `benchagi agents list`."));
    return;
  }

  for (;;) {
    const choice = await runPicker(agents);
    if (!choice || choice.mode === "quit" || !choice.agent) {
      println(c.dim("  Until next flight."));
      break;
    }
    if (choice.mode === "local") {
      await runLocalSeat(choice.agent);
      continue;
    }
    await runCloudSeat(choice.agent.agentId, opts); // cloud = default (company allotment)
  }
}

async function ensureAuthed(): Promise<void> {
  if (process.env.BENCHAGI_NO_LOGIN) return;
  const token = await loadFreshFirebaseIdToken().catch(() => null);
  if (token) return;
  println(c.dim("Sign in to use your company agents…"));
  await commandAuthLogin();
}

async function maybePromptUpdate(): Promise<void> {
  try {
    const account = await loadAccount();
    const apiBase = resolveApiBase(account);
    const manifestUrl = process.env.BENCHAGI_MANIFEST_URL || `${apiBase}/v1/cli/manifest.json`;
    const res = await checkForUpdate({ currentVersion: CLI_VERSION, manifestUrl });
    const banner = updateBanner(res);
    if (!banner) return;
    eprintln(c.yellow(`⬆ ${banner}`));
    if (res.upgrade && (await confirm("  Update now? [y/N] "))) {
      const { spawnSync } = await import("node:child_process");
      spawnSync(res.upgrade, { shell: true, stdio: "inherit" });
      process.exit(0);
    }
  } catch {
    // never block launch on an update check
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
