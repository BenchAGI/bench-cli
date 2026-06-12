// cloud-seat.ts — run an agent turn/REPL over the cloud (the existing ChatRunner
// path: the Firebase token is attached per send so the gateway relays to Bench
// cloud against the company allotment). Hosts the agent-locate + REPL helpers
// lifted from cli.ts so both the bare CLI and the launcher reuse them.
import { c, println } from "../render/ansi.js";
import { ChatRunner } from "../chat-runner.js";
import { Repl } from "../repl/prompt.js";
import { listAgents, resolveShortName } from "../commands/agents.js";
import { loadState, recordRecent } from "../state/state-file.js";
import { CLI_VERSION } from "../commands/version.js";
import { loadAccount } from "./account.js";
import { loadUserProfile, profileIsFresh } from "../state/user-profile.js";
import { runTui } from "../tui/app.js";
// Branded ANSI for the cloud REPL status line (matches the local seat status line).
const IR = "\x1b[38;2;255;45;85m";
const COPPER = "\x1b[38;2;196;122;58m";
const AMBER = "\x1b[38;2;255;184;74m";
const SDIM = "\x1b[38;2;124;124;135m";
const SRESET = "\x1b[0m";
const MODEL_SHORT = {
    "claude-fable-5": "Fable 5",
    "claude-opus-4-8": "Opus 4.8",
    "claude-opus-4-6": "Opus 4.6",
    "claude-sonnet-4-6": "Sonnet 4.6",
    "claude-haiku-4-5": "Haiku 4.5",
};
const shortModel = (m) => (m ? (MODEL_SHORT[m] ?? m) : "");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export async function locateAgent(name, gatewayUrl) {
    const agents = await listAgents(gatewayUrl);
    if (agents.length === 0) {
        throw Object.assign(new Error("no agents configured; check openclaw.json agents.list"), { exitCode: 5 });
    }
    if (!name) {
        const state = await loadState();
        for (const id of state.recentAgents) {
            const a = agents.find((x) => x.id === id);
            if (a)
                return { id: a.id, model: a.model };
        }
        return { id: agents[0].id, model: agents[0].model };
    }
    const resolved = resolveShortName(name, agents);
    if (!resolved) {
        throw Object.assign(new Error(`unknown agent: ${name} (try \`benchagi agents list\`)`), { exitCode: 5 });
    }
    return { id: resolved.id, model: resolved.model };
}
export async function singleTurn(runner, message) {
    const runId = await runner.sendMessage(message);
    if (!runId)
        return;
    const reason = await runner.waitForFinal(120_000, runId);
    if (reason === "timeout") {
        println(c.dim("(timed out waiting for response — try the REPL: `benchagi`)"));
    }
    println();
}
export async function resolveSeatIdentity() {
    const [account, profile] = await Promise.all([loadAccount().catch(() => null), loadUserProfile().catch(() => null)]);
    if (profileIsFresh(profile) && profile) {
        return { who: profile.displayName || profile.email, tierLevel: profile.accessLevel, tierColor: profile.accessColor };
    }
    if (account?.user) {
        const a = account.user;
        return { who: a.preferredName || a.name || a.email, tierLevel: a.accessLevel, tierColor: a.accessColor };
    }
    return {};
}
export async function replLoop(runner, agentId, model) {
    // Status line above the prompt each turn: the agent you're talking to, the
    // logged-in human + access tier, and a 🔔 when the agent is waiting on you.
    const ident = await resolveSeatIdentity();
    const who = ident.who;
    const access = ident.tierLevel ? (ident.tierColor ? `${ident.tierLevel} (${ident.tierColor})` : ident.tierLevel) : "";
    const ms = shortModel(model);
    const statusLine = () => {
        const parts = [`🦅 ${IR}${cap(agentId)}${SRESET}`];
        if (ms)
            parts.push(`${COPPER}${ms}${SRESET}`);
        if (who)
            parts.push(`${SDIM}you: ${who}${access ? ` · ${access}` : ""}${SRESET}`);
        parts.push(`${SDIM}cloud · benchagi${SRESET}`);
        const line = parts.join(`${SDIM} · ${SRESET}`);
        return runner.hasPendingApproval() ? `${AMBER}\x1b[1m🔔 needs you${SRESET}${SDIM}  ·  ${SRESET}${line}` : line;
    };
    println(c.dim(`benchagi ${CLI_VERSION} · type /exit or Ctrl-D to quit`));
    await new Promise((resolve) => {
        const repl = new Repl({ prompt: c.cyan("you> "), statusLine }, {
            onMessage: async (msg) => {
                const runId = await runner.sendMessage(msg);
                if (!runId)
                    return;
                const reason = await runner.waitForFinal(30 * 60_000, runId);
                if (reason === "timeout") {
                    println(c.dim("(still waiting after 30m — prompt restored; output may continue if the gateway finishes)"));
                }
            },
            onInterrupt: async () => {
                const reason = await runner.interruptCurrent();
                println(c.dim(reason === "denied" ? "(approval denied)" : "(aborted)"));
            },
            onExit: async () => {
                println(c.dim("bye"));
                resolve();
            },
            onKey: async (key) => {
                return await runner.handleApprovalKey(key);
            },
            canConsumeKey: (key) => runner.canHandleApprovalKey(key),
        });
        void repl.start();
    });
}
// The premium ink TUI is the default for an interactive TTY. The readline REPL is the fallback for
// --classic, BENCHAGI_CLASSIC_REPL, and any non-interactive context (pipes, no TTY) — which a
// full-screen TUI can't serve anyway.
function shouldUseTui(opts) {
    if (opts.message && opts.message.length > 0)
        return false;
    if (opts.classic || process.env.BENCHAGI_CLASSIC_REPL)
        return false;
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
async function runTuiSeat(runner, agent) {
    const ident = await resolveSeatIdentity();
    await runTui(runner, {
        agentId: agent.id,
        model: shortModel(agent.model),
        tier: ident.tierLevel ? { level: ident.tierLevel, color: ident.tierColor } : undefined,
        who: ident.who,
    });
}
export async function runCloudSeat(agentId, opts = {}) {
    const agent = await locateAgent(agentId, opts.gatewayUrl);
    const selectedAgent = { ...agent, model: opts.model?.trim() || agent.model };
    const thinkingMode = opts.noThinking ? "off" : opts.thinking;
    const useTui = shouldUseTui(opts);
    const runner = new ChatRunner({
        agentId: selectedAgent.id,
        modelPrimary: selectedAgent.model,
        thinkingLevel: opts.effort,
        liveness: opts.liveness ?? "auto",
        showFullToolOutput: Boolean(opts.full),
        showThinking: thinkingMode !== "off",
        traceFramesPath: opts.traceFramesPath,
        tui: useTui,
        assistantLabel: cap(selectedAgent.id), // "Aurelius>" instead of "agent>"
        gatewayUrl: opts.gatewayUrl,
    });
    if (thinkingMode)
        runner.setThinking(thinkingMode);
    try {
        await runner.connect();
        await recordRecent(selectedAgent.id);
        if (opts.message && opts.message.length > 0) {
            await singleTurn(runner, opts.message);
        }
        else if (useTui) {
            await runTuiSeat(runner, selectedAgent);
        }
        else {
            await replLoop(runner, selectedAgent.id, selectedAgent.model);
        }
    }
    finally {
        await runner.close();
    }
}
