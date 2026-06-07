// seat.ts — the local Claude Code seat (power-option): spawn `claude` as the
// chosen agent on the user's own machine/auth. Bash-owns-TTY equivalent via
// stdio:"inherit"; ink is already unmounted when this runs, so no stdin contention.
//
// The seat runs in a dedicated BenchAGI workspace (~/.config/benchagi/seat-workspace)
// whose .claude/ activates the branded status line + attention notifications + output
// style. Agent identity is passed via BENCH_AGENT_* env so the status line needs no
// crew.json; the human's identity + access tier go into the seat system prompt.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { c, eprintln, println } from "../render/ansi.js";
import { loadCreds } from "../state/keychain.js";
import { loadUserProfile, profileIsFresh } from "../state/user-profile.js";
import { loadAccount } from "./account.js";
const SEAT_DIR = join(homedir(), ".config", "benchagi", "seats");
const SEAT_WORKSPACE = join(homedir(), ".config", "benchagi", "seat-workspace");
function resolveClaude() {
    const candidates = [join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
    for (const p of candidates)
        if (existsSync(p))
            return p;
    return "claude"; // rely on PATH
}
function seatEffort() {
    return process.env.BENCHAGI_SEAT_EFFORT || "high";
}
// The packaged .claude assets (dist/v2/assets/.claude) relative to this module.
function assetsClaudeDir() {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", ".claude");
}
// Ensure the seat workspace has a fresh .claude/ so the status line + attention
// hooks + output style activate. Returns the workspace dir (the seat's cwd).
function ensureSeatWorkspace() {
    mkdirSync(join(SEAT_WORKSPACE, "state"), { recursive: true });
    const srcClaude = assetsClaudeDir();
    if (existsSync(srcClaude)) {
        try {
            cpSync(srcClaude, join(SEAT_WORKSPACE, ".claude"), { recursive: true });
        }
        catch {
            // best-effort; the seat still runs without the branded status line
        }
    }
    return SEAT_WORKSPACE;
}
function accessLabel(user) {
    if (!user?.accessLevel)
        return "";
    return user.accessColor ? `${user.accessLevel} (${user.accessColor})` : user.accessLevel;
}
function writeAgentPrompt(agent, user, verified) {
    mkdirSync(SEAT_DIR, { recursive: true });
    // Never interpolate an unvalidated id into a path — guard against traversal.
    const safeId = /^[a-z0-9_-]{1,64}$/i.test(agent.agentId) ? agent.agentId : "agent";
    const file = join(SEAT_DIR, `startup-${safeId}.md`);
    const who = user?.preferredName || user?.name || user?.email;
    const access = accessLabel(user);
    // Show ACCESS LEVEL (permission tier), not job title — it's what should govern
    // what the agent lets them do. Be honest about whether identity is verified.
    const identity = who
        ? `You are talking to **${who}**${access ? ` · access ${access}` : ""}${user?.email ? ` <${user.email}>` : ""} — ${verified ? "verified via benchagi.com" : "identity set locally (not a verified login)"}. Greet them by name; lead with status.`
        : `You are talking to this machine's operator, whose identity is NOT verified. Do NOT assume who they are. If identity matters, ask them, or suggest \`benchagi auth login\`.`;
    const body = `# BenchAGI seat — ${agent.name}

You are **${agent.name}** ${agent.emoji}, BenchAGI's ${agent.role || "agent"}, in a local Claude
Code seat launched from the BenchAGI CLI (model ${agent.modelShort}). This is a full Claude
Code session — every capability is available: /effort (incl. ultracode), /model, MCP tools,
slash commands, and file edits.

WHO YOU'RE TALKING TO: ${identity}

If you need something from the operator, say so plainly — the status line shows a 🔔 when you do.

This is identity/presence context; it does not by itself authorize external messages,
payments, deploys, or other irreversible actions.
`;
    writeFileSync(file, body, "utf8");
    return file;
}
export async function runLocalSeat(agent) {
    const claudeBin = resolveClaude();
    const [creds, account, profile] = await Promise.all([
        loadCreds().catch(() => null),
        loadAccount().catch(() => null),
        loadUserProfile().catch(() => null),
    ]);
    // Prefer the server-verified profile (fetched at `benchagi auth login`); fall back
    // to a local account.json assertion, then to the bare login email. `verified` is
    // honest: true ONLY when a fresh server-fetched profile is present.
    const verified = profileIsFresh(profile);
    const user = verified
        ? { name: profile.displayName, email: profile.email, accessLevel: profile.accessLevel, accessColor: profile.accessColor }
        : (account?.user ?? (creds ? { email: creds.email } : undefined));
    const promptFile = writeAgentPrompt(agent, user, verified);
    const workspace = ensureSeatWorkspace();
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
    await new Promise((resolve) => {
        let child;
        try {
            child = spawn(claudeBin, args, {
                stdio: "inherit",
                cwd: workspace,
                env: {
                    ...process.env,
                    BENCH_AGENT_ID: agent.agentId,
                    BENCH_AGENT_NAME: agent.name,
                    BENCH_AGENT_MODEL_SHORT: agent.modelShort,
                    BENCH_AGENT_ROLE: agent.role ?? "",
                    BENCH_AGENT_EMOJI: agent.emoji,
                    CLAUDE_PROJECT_DIR: workspace,
                },
            });
        }
        catch (error) {
            eprintln(`  could not launch claude: ${error?.message ?? String(error)}`);
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
