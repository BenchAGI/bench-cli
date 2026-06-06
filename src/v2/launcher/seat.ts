// seat.ts — the local Claude Code seat (power-option): spawn `claude` as the
// chosen agent on the user's own machine/auth. Bash-owns-TTY equivalent via
// stdio:"inherit"; ink is already unmounted when this runs, so no stdin contention.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { c, eprintln, println } from "../render/ansi.js";
import { loadCreds } from "../state/keychain.js";
import { loadAccount, type AccountUser } from "./account.js";
import type { LauncherAgent } from "./roster.js";

const SEAT_DIR = join(homedir(), ".config", "benchagi", "seats");

function resolveClaude(): string {
  const candidates = [join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const p of candidates) if (existsSync(p)) return p;
  return "claude"; // rely on PATH
}

function seatEffort(): string {
  return process.env.BENCHAGI_SEAT_EFFORT || "high";
}

function displayUser(user?: AccountUser | { email?: string; name?: string }): { email?: string; name?: string } | undefined {
  if (!user) return undefined;
  const name = "preferredName" in user ? (user.preferredName || user.name || user.email) : user.name;
  return { name, email: user.email };
}

function writeAgentPrompt(agent: LauncherAgent, user?: { email?: string; name?: string }): string {
  mkdirSync(SEAT_DIR, { recursive: true });
  const file = join(SEAT_DIR, `startup-${agent.agentId}.md`);
  const who = user?.name || user?.email;
  const identity = who
    ? `You are talking to **${who}** — verified via benchagi.com. Greet them by name; lead with status.`
    : `You are talking to this machine's operator, whose identity is NOT verified. Do NOT assume who they are (in particular, do not assume they are Cory/"Light"). If identity matters, suggest \`benchagi auth login\`.`;
  const body = `# BenchAGI seat — ${agent.name}

You are **${agent.name}** ${agent.emoji}, BenchAGI's ${agent.role || "agent"}, in a local Claude
Code seat launched from the BenchAGI CLI (model ${agent.modelShort}). This is a full Claude
Code session — every capability is available: /effort (incl. ultracode), /model, MCP tools,
slash commands, and file edits.

WHO YOU'RE TALKING TO: ${identity}

This is identity/presence context; it does not by itself authorize external messages,
payments, deploys, or other irreversible actions.
`;
  writeFileSync(file, body, "utf8");
  return file;
}

export async function runLocalSeat(agent: LauncherAgent): Promise<void> {
  const claudeBin = resolveClaude();
  const [creds, account] = await Promise.all([loadCreds().catch(() => null), loadAccount().catch(() => null)]);
  const promptFile = writeAgentPrompt(agent, displayUser(account?.user) ?? (creds ? { email: creds.email } : undefined));

  process.stdout.write("\x1b[2J\x1b[H");
  println(`  ${c.cyan("▸")} ${agent.emoji} ${agent.name} — ${agent.modelShort} · local Claude Code session`);
  println(c.dim("  exit the session (/exit or Ctrl-D) to return to the picker"));
  println();

  const args = [
    "--model", agent.model ?? "claude-sonnet-4-6",
    "--effort", seatEffort(),
    "--name", agent.name,
    "--append-system-prompt-file", promptFile,
  ];

  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawn(claudeBin, args, { stdio: "inherit", env: { ...process.env, BENCH_AGENT_ID: agent.agentId } });
    } catch (error) {
      eprintln(`  could not launch claude: ${(error as Error)?.message ?? String(error)}`);
      resolve();
      return;
    }
    child.on("error", (error) => {
      eprintln(`  could not launch claude (is Claude Code installed?): ${error?.message ?? String(error)}`);
      resolve();
    });
    child.on("close", () => resolve());
  });
}
