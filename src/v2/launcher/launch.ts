// launch.ts — the BenchAGI launcher orchestrator: boot → update gate → auth gate
// → entitled-agent picker → per-agent handoff (tunnel, direct harness, or local).

import { c, eprintln, println } from "../render/ansi.js";
import { CLI_VERSION } from "../commands/version.js";
import { commandAuthLogin } from "../commands/auth.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import type { Liveness } from "../probe/capability.js";

import { playBoot } from "./boot-bridge.js";
import { checkForUpdate, updateBanner } from "./updates.js";
import { hasAccountToken, loadAccount, resolveApiBase } from "./account.js";
import { resolveRoster } from "./roster.js";
import { runCloudSeat } from "./cloud-seat.js";
import { runLocalClaudeSeat, runLocalCodexSeat } from "./seat.js";
import { runPicker } from "./picker.js";

export interface LaunchOpts {
  liveness?: Liveness;
  full?: boolean;
  noThinking?: boolean;
  classic?: boolean;
  directGatewayUrl?: string;
  gatewayUrl?: string;
  traceFramesPath?: string;
}

const DEFAULT_DIRECT_GATEWAY_URL = "ws://127.0.0.1:18789";

export async function runLaunch(opts: LaunchOpts = {}): Promise<void> {
  await playBoot({});
  await maybePromptUpdate();

  let agents = await resolveRoster({ gatewayUrl: opts.gatewayUrl ?? opts.directGatewayUrl });
  if (!agents.length && !(await hasUsableAuth()) && !process.env.BENCHAGI_NO_LOGIN) {
    println(c.dim("Sign in to use your company agents…"));
    await commandAuthLogin();
    agents = await resolveRoster({ gatewayUrl: opts.gatewayUrl ?? opts.directGatewayUrl });
  }
  if (!agents.length) {
    eprintln(c.yellow("No agents are provisioned for your account yet."));
    eprintln(c.dim("  • Make sure you're signed in:  benchagi auth login"));
    eprintln(c.dim("  • Then ask your Bench admin to grant you agent access."));
    eprintln(c.dim("  • Running your own gateway? Check:  benchagi agents list"));
    return;
  }

  for (;;) {
    const choice = await runPicker(agents);
    if (!choice || choice.mode === "quit" || !choice.agent) {
      println(c.dim("  Until next flight."));
      break;
    }
    if (choice.mode === "local-claude") {
      await runLocalClaudeSeat(choice.agent, { gatewayUrl: opts.directGatewayUrl ?? opts.gatewayUrl });
      continue;
    }
    if (choice.mode === "local-codex") {
      await runLocalCodexSeat(choice.agent, { gatewayUrl: opts.directGatewayUrl ?? opts.gatewayUrl });
      continue;
    }
    if (choice.mode === "direct") {
      const gatewayUrl = await resolveDirectGatewayUrl(opts.directGatewayUrl);
      await runCloudSeat(choice.agent.agentId, { ...opts, gatewayUrl });
      continue;
    }
    await runCloudSeat(choice.agent.agentId, opts); // tunnel = default Bench/company harness path
  }
}

async function resolveDirectGatewayUrl(configured?: string): Promise<string> {
  const direct = (configured || process.env.BENCHAGI_DIRECT_GATEWAY_URL || "").trim();
  if (direct) return direct;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`  direct gateway URL [${DEFAULT_DIRECT_GATEWAY_URL}] `)).trim();
    return answer || DEFAULT_DIRECT_GATEWAY_URL;
  } catch {
    return DEFAULT_DIRECT_GATEWAY_URL;
  } finally {
    rl.close();
  }
}

async function hasUsableAuth(): Promise<boolean> {
  const account = await loadAccount();
  if (hasAccountToken(account)) return true;
  const token = await loadFreshFirebaseIdToken().catch(() => null);
  return Boolean(token);
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
    // Run a HARDCODED upgrade command (argv form, never a shell). The manifest
    // is treated as data describing THAT an update exists — never *how* to
    // install it. We deliberately do NOT execute the server-supplied
    // `res.upgrade` string (that would be remote command execution).
    eprintln(c.dim("  upgrade: brew upgrade benchagi/tap/benchagi"));
    if (await confirm("  Update now? [y/N] ")) {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("brew", ["upgrade", "benchagi/tap/benchagi"], { stdio: "inherit" });
      if (r.status === 0) process.exit(0);
      eprintln(c.dim("  update did not complete; continuing with the current version"));
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
