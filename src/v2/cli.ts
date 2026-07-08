// `benchagi` main dispatch.

import { ensureCursorRestoredOnExit, eprintln, println } from "./render/ansi.js";
import { commandAgentsList, commandAgentsUse } from "./commands/agents.js";
import { commandAuthLogin, commandAuthLogout, commandAuthStatus } from "./commands/auth.js";
import { commandLink } from "./commands/link.js";
import { commandDoctor } from "./commands/doctor.js";
import { commandDesktop } from "./commands/desktop.js";
import { commandInstallApp } from "./commands/install-app.js";
import { commandSeatBridge } from "./commands/seat-bridge.js";
import { commandVersion, CLI_VERSION } from "./commands/version.js";
import { getProjectAgent, loadState } from "./state/state-file.js";
import { runCloudSeat } from "./launcher/cloud-seat.js";
import { runLaunch } from "./launcher/launch.js";
import type { Liveness } from "./probe/capability.js";

type Argv = {
  agent?: string;
  liveness?: Liveness;
  full: boolean;
  noThinking: boolean;
  classic: boolean;
  report: boolean;
  attachPath?: string;
  directGatewayUrl?: string;
  gatewayUrl?: string;
  traceFramesPath?: string;
  positional: string[];
  command?: string;
};

export async function run(argv: string[]): Promise<void> {
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
      await commandDoctor({ report: parsed.report, attachPath: parsed.attachPath });
      return;

    case "install-app":
      await commandInstallApp(parsed.positional, parsed.agent);
      return;

    case "desktop":
      await commandDesktop(parsed.agent, parsed.gatewayUrl);
      return;

    case "auth":
      await runAuth(parsed.positional);
      return;

    case "agents":
      await runAgents(parsed.positional, parsed.gatewayUrl);
      return;

    case "seat-bridge":
      await commandSeatBridge(parsed.positional, parsed.agent);
      return;

    case "launch":
      await runLaunch({
        liveness: parsed.liveness,
        full: parsed.full,
        noThinking: parsed.noThinking,
        classic: parsed.classic,
        directGatewayUrl: parsed.directGatewayUrl ?? process.env.BENCHAGI_DIRECT_GATEWAY_URL,
        gatewayUrl: parsed.gatewayUrl ?? process.env.BENCHAGI_GATEWAY_URL,
        traceFramesPath: parsed.traceFramesPath,
      });
      return;

    case "link":
    case "relink":
      process.exitCode = await commandLink(parsed.positional, {
        relink: parsed.command === "relink",
      });
      return;

    default: {
      // Bare TTY with no message → the BenchAGI launcher (boot + agent picker).
      const wantsLauncher =
        parsed.command == null &&
        parsed.positional.length === 0 &&
        Boolean(process.stdin.isTTY) &&
        Boolean(process.stdout.isTTY) &&
        !process.env.BENCHAGI_NO_LAUNCH;
      if (wantsLauncher) {
        await runLaunch({
          liveness: parsed.liveness,
          full: parsed.full,
          noThinking: parsed.noThinking,
          classic: parsed.classic,
          directGatewayUrl: parsed.directGatewayUrl ?? process.env.BENCHAGI_DIRECT_GATEWAY_URL,
          gatewayUrl: parsed.gatewayUrl ?? process.env.BENCHAGI_GATEWAY_URL,
          traceFramesPath: parsed.traceFramesPath,
        });
        return;
      }
      // Single-turn (`benchagi <message>`) or non-TTY → direct cloud seat / REPL.
      const agentId = await resolveAgent(parsed);
      await runCloudSeat(agentId, {
        liveness: parsed.liveness,
        full: parsed.full,
        noThinking: parsed.noThinking,
        classic: parsed.classic,
        gatewayUrl: parsed.gatewayUrl ?? process.env.BENCHAGI_GATEWAY_URL,
        traceFramesPath: parsed.traceFramesPath,
        message: parsed.positional.length > 0 ? parsed.positional.join(" ") : undefined,
      });
    }
  }
}

async function runAuth(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "login":
      await commandAuthLogin({ paste: args.includes("--paste") });
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

async function runAgents(args: string[], gatewayUrl?: string): Promise<void> {
  const sub = args[0];
  if (sub === "list" || sub === undefined) {
    await commandAgentsList(gatewayUrl);
    return;
  }
  if (sub === "use") {
    const name = args[1];
    if (!name) {
      eprintln(`Usage: benchagi agents use <name>`);
      process.exit(1);
    }
    await commandAgentsUse(name, gatewayUrl);
    return;
  }
  eprintln(`Usage: benchagi agents <list|use <name>>`);
  process.exit(1);
}

async function resolveAgent(parsed: Argv): Promise<string | null> {
  if (parsed.agent) return parsed.agent;
  const projectAgent = await getProjectAgent();
  if (projectAgent) return projectAgent;
  const state = await loadState();
  if (state.recentAgents.length > 0) return state.recentAgents[0]!;
  if (state.defaultAgent) return state.defaultAgent;
  return null;
}

// locateAgent / singleTurn / replLoop / runCloudSeat now live in
// ./launcher/cloud-seat.ts (shared by the bare CLI and the launcher).

function parseArgs(argv: string[]): Argv {
  const out: Argv = {
    full: false,
    noThinking: false,
    classic: false,
    report: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
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
    if (arg === "--classic") {
      out.classic = true;
      continue;
    }
    if (arg === "--report") {
      out.report = true;
      continue;
    }
    if (arg === "--attach") {
      out.attachPath = argv[++i];
      continue;
    }
    if (arg.startsWith("--attach=")) {
      out.attachPath = arg.slice("--attach=".length);
      continue;
    }
    if (arg === "--gateway") {
      out.gatewayUrl = argv[++i];
      continue;
    }
    if (arg.startsWith("--gateway=")) {
      out.gatewayUrl = arg.slice("--gateway=".length);
      continue;
    }
    if (arg === "--direct-gateway") {
      out.directGatewayUrl = argv[++i];
      continue;
    }
    if (arg.startsWith("--direct-gateway=")) {
      out.directGatewayUrl = arg.slice("--direct-gateway=".length);
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
      out.liveness = (argv[++i] as Liveness) ?? "auto";
      continue;
    }
    if (arg.startsWith("--liveness=")) {
      out.liveness = arg.slice("--liveness=".length) as Liveness;
      continue;
    }
    if (out.command == null && !arg.startsWith("-")) {
      // First non-flag positional is the command.
      if (
        arg === "launch" ||
        arg === "auth" ||
        arg === "link" ||
        arg === "relink" ||
        arg === "agents" ||
        arg === "doctor" ||
        arg === "desktop" ||
        arg === "install-app" ||
        arg === "seat-bridge" ||
        arg === "version" ||
        arg === "help"
      ) {
        out.command = arg;
        continue;
      }
    }
    out.positional.push(arg);
  }
  return out;
}

function printHelp(): void {
  println(`benchagi ${CLI_VERSION} — streaming-aware Bench/OpenClaw CLI

Usage:
  benchagi                         BenchAGI launcher: boot + agent picker (TTY)
  benchagi launch                  force the launcher (boot + picker)
  benchagi --no-launch             open chat REPL with last-used agent (skip launcher)
  benchagi <message>               single-turn ask
  benchagi --agent <name> <msg>    address a specific agent

  benchagi auth login              Firebase Direct browser-handoff (optional in V1)
  benchagi auth login --paste      paste a sign-in bundle (browser not on this machine)
  benchagi auth logout             clear keychain
  benchagi auth status             show signed-in identity

  benchagi link                    pair this Mac to your Aurelius (zero-touch)
  benchagi link <8-digit-code>     pair using a code (fresh Mac / not signed in)
  benchagi relink                  re-pair after the bridge drops

  benchagi agents list             list configured agents
  benchagi agents use <name>       set default agent

  benchagi doctor                  diagnostics (+ gateway log locations)
  benchagi doctor --report         file the diagnostics on the BenchAGI Forge
  benchagi desktop                 open the Claude Code desktop app as your seat
  benchagi desktop --agent <name>  desktop seat for a specific agent
  benchagi install-app             install/refresh the macOS Dock launcher app
  benchagi install-app desktop     install the dock app that opens the desktop seat
  benchagi version                 print version

Flags:
  --agent <name>           override active agent
  --liveness <auto|stream|batch|always|off>   liveness indicator override
  --full                   expand all tool output by default
  --no-thinking            hide thinking deltas
  --classic                use the classic readline REPL (skip the full-screen TUI)
  --report                 (doctor) file the checks as a Forge diagnostics ticket
  --attach <path>          (doctor --report) include a runbook file in the report
  --gateway <ws-url>       default tunnel/harness gateway for chat/Enter mode
  --direct-gateway <ws-url> gateway used by launcher Direct mode
  --trace-frames <path>    append raw gateway WS frames as JSONL
  --help, --version
`);
}
