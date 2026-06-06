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
export async function locateAgent(name) {
    const agents = await listAgents();
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
export async function replLoop(runner, agentId) {
    println(c.dim(`benchagi ${CLI_VERSION} · agent ${c.cyan(agentId)} · type /exit or Ctrl-D to quit`));
    await new Promise((resolve) => {
        const repl = new Repl({ prompt: c.cyan("you> ") }, {
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
export async function runCloudSeat(agentId, opts = {}) {
    const agent = await locateAgent(agentId);
    const runner = new ChatRunner({
        agentId: agent.id,
        modelPrimary: agent.model,
        liveness: opts.liveness ?? "auto",
        showFullToolOutput: Boolean(opts.full),
        showThinking: !opts.noThinking,
        traceFramesPath: opts.traceFramesPath,
    });
    try {
        await runner.connect();
        await recordRecent(agent.id);
        if (opts.message && opts.message.length > 0) {
            await singleTurn(runner, opts.message);
        }
        else {
            await replLoop(runner, agent.id);
        }
    }
    finally {
        await runner.close();
    }
}
