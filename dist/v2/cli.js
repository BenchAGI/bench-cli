// `benchagi` main dispatch.
import { c, ensureCursorRestoredOnExit, eprintln, println } from "./render/ansi.js";
import { commandAgentsList, commandAgentsUse, listAgents, resolveShortName } from "./commands/agents.js";
import { commandAuthLogin, commandAuthLogout, commandAuthStatus } from "./commands/auth.js";
import { commandDoctor } from "./commands/doctor.js";
import { commandVersion, CLI_VERSION } from "./commands/version.js";
import { ChatRunner } from "./chat-runner.js";
import { Repl } from "./repl/prompt.js";
import { getProjectAgent, loadState, recordRecent } from "./state/state-file.js";
export async function run(argv) {
    ensureCursorRestoredOnExit();
    const parsed = parseArgs(argv);
    if (parsed.command === "version" || argv.includes("--version") || argv.includes("-v")) {
        await commandVersion();
        return;
    }
    if (parsed.command === "help" || argv.includes("--help") || argv.includes("-h")) {
        printHelp();
        return;
    }
    switch (parsed.command) {
        case "doctor":
            await commandDoctor();
            return;
        case "auth":
            await runAuth(parsed.positional);
            return;
        case "agents":
            await runAgents(parsed.positional);
            return;
        default: {
            // Bare command (REPL) or single-turn (`benchagi <message...>`).
            const agentId = await resolveAgent(parsed);
            const agent = await locateAgent(agentId);
            const runner = new ChatRunner({
                agentId: agent.id,
                modelPrimary: agent.model,
                liveness: parsed.liveness ?? "auto",
                showFullToolOutput: parsed.full,
                showThinking: !parsed.noThinking,
                traceFramesPath: parsed.traceFramesPath,
            });
            try {
                await runner.connect();
                await recordRecent(agent.id);
                if (parsed.positional.length > 0) {
                    // Single-turn ask
                    const message = parsed.positional.join(" ");
                    await singleTurn(runner, message);
                }
                else {
                    // Interactive REPL
                    await replLoop(runner, agent.id);
                }
            }
            finally {
                await runner.close();
            }
        }
    }
}
async function runAuth(args) {
    const sub = args[0];
    switch (sub) {
        case "login":
            await commandAuthLogin();
            return;
        case "logout":
            await commandAuthLogout();
            return;
        case "status":
            await commandAuthStatus();
            return;
        default:
            eprintln(`Usage: benchagi auth <login|logout|status>`);
            process.exit(1);
    }
}
async function runAgents(args) {
    const sub = args[0];
    if (sub === "list" || sub === undefined) {
        await commandAgentsList();
        return;
    }
    if (sub === "use") {
        const name = args[1];
        if (!name) {
            eprintln(`Usage: benchagi agents use <name>`);
            process.exit(1);
        }
        await commandAgentsUse(name);
        return;
    }
    eprintln(`Usage: benchagi agents <list|use <name>>`);
    process.exit(1);
}
async function resolveAgent(parsed) {
    if (parsed.agent)
        return parsed.agent;
    const projectAgent = await getProjectAgent();
    if (projectAgent)
        return projectAgent;
    const state = await loadState();
    if (state.recentAgents.length > 0)
        return state.recentAgents[0];
    if (state.defaultAgent)
        return state.defaultAgent;
    return null;
}
async function locateAgent(name) {
    const agents = await listAgents();
    if (agents.length === 0) {
        throw Object.assign(new Error("no agents configured; check openclaw.json agents.list"), { exitCode: 5 });
    }
    if (!name) {
        // Pick most recent or first.
        const state = await loadState();
        for (const id of state.recentAgents) {
            const a = agents.find((a) => a.id === id);
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
async function singleTurn(runner, message) {
    const runId = await runner.sendMessage(message);
    if (!runId)
        return;
    // Wait for the run to reach a terminal chat-event state, with a generous
    // timeout for batch backends (claude-cli/openai-codex sit silent until done).
    const reason = await runner.waitForFinal(120_000, runId);
    if (reason === "timeout") {
        println(c.dim("(timed out waiting for response — try the REPL: `benchagi`)"));
    }
    println();
}
async function replLoop(runner, agentId) {
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
                // V1.1 — Item 3: Ctrl-C during a pending approval default-
                // denies that approval rather than aborting the run.
                const reason = await runner.interruptCurrent();
                println(c.dim(reason === "denied" ? "(approval denied)" : "(aborted)"));
            },
            onExit: async () => {
                println(c.dim("bye"));
                resolve();
            },
            // V1.1 — Item 3: route raw keystrokes during a busy run to
            // the approval state machine. [A]/[D] resolve a pending
            // approval; everything else is ignored.
            onKey: async (key) => {
                return await runner.handleApprovalKey(key);
            },
            // V1.1 — Item 3 (Codex Anvil P1): sync predicate so the
            // REPL can clear its line buffer before the async resolve
            // yields to the event loop.
            canConsumeKey: (key) => runner.canHandleApprovalKey(key),
        });
        void repl.start();
    });
}
function parseArgs(argv) {
    const out = {
        full: false,
        noThinking: false,
        positional: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--agent") {
            out.agent = argv[++i];
            continue;
        }
        if (arg.startsWith("--agent=")) {
            out.agent = arg.slice("--agent=".length);
            continue;
        }
        if (arg === "--full") {
            out.full = true;
            continue;
        }
        if (arg === "--no-thinking") {
            out.noThinking = true;
            continue;
        }
        if (arg === "--trace-frames") {
            out.traceFramesPath = argv[++i];
            continue;
        }
        if (arg.startsWith("--trace-frames=")) {
            out.traceFramesPath = arg.slice("--trace-frames=".length);
            continue;
        }
        if (arg === "--liveness") {
            out.liveness = argv[++i] ?? "auto";
            continue;
        }
        if (arg.startsWith("--liveness=")) {
            out.liveness = arg.slice("--liveness=".length);
            continue;
        }
        if (out.command == null && !arg.startsWith("-")) {
            // First non-flag positional is the command.
            if (arg === "auth" ||
                arg === "agents" ||
                arg === "doctor" ||
                arg === "version" ||
                arg === "help") {
                out.command = arg;
                continue;
            }
        }
        out.positional.push(arg);
    }
    return out;
}
function printHelp() {
    println(`benchagi ${CLI_VERSION} — streaming-aware Bench/OpenClaw CLI

Usage:
  benchagi                         open chat REPL with last-used agent
  benchagi <message>               single-turn ask
  benchagi --agent <name> <msg>    address a specific agent

  benchagi auth login              Firebase Direct browser-handoff (optional in V1)
  benchagi auth logout             clear keychain
  benchagi auth status             show signed-in identity

  benchagi agents list             list configured agents
  benchagi agents use <name>       set default agent

  benchagi doctor                  diagnostics
  benchagi version                 print version

Flags:
  --agent <name>           override active agent
  --liveness <auto|stream|batch|always|off>   liveness indicator override
  --full                   expand all tool output by default
  --no-thinking            hide thinking deltas
  --trace-frames <path>    append raw gateway WS frames as JSONL
  --help, --version
`);
}
