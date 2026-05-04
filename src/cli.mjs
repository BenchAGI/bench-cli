// Top-level command dispatcher for `bench`.
import { cmdAsk } from "./commands/ask.mjs";
import { cmdChat } from "./commands/chat.mjs";
import { cmdAgents } from "./commands/agents.mjs";
import { cmdSessions } from "./commands/sessions.mjs";
import { cmdTasks } from "./commands/tasks.mjs";
import { cmdStatus } from "./commands/status.mjs";
import { cmdFeed } from "./commands/feed.mjs";
import { cmdTail } from "./commands/tail.mjs";
import { cmdCommitments } from "./commands/commitments.mjs";
import { cmdSetup } from "./commands/setup.mjs";
import { cleanStderr } from "./lib/openclaw.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PKG = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
);
const VERSION = PKG.version;

const TOP_HELP = `bench v${VERSION} — BenchAGI CLI

Usage: bench <command> [args]

Agent commands:
  ask <agent> "..."     Single-turn message to an agent
  chat <agent>          Per-agent interactive REPL
  commitments           Inferred follow-ups from agent conversations

Inspect commands:
  feed                  Compact fused snapshot (status + sessions + tasks)
  agents                List configured agents
  sessions [agent]      List recent sessions for an agent
  tasks                 List tracked background tasks
  status                Gateway / channel / agent health
  tail                  Live-tail the gateway log stream

Lifecycle:
  setup                 Run readiness checks (great for first-time installs)
  version               Print version
  help                  Show this help

Run \`bench <command> --help\` for command-specific options.

Environment:
  BENCH_OPENCLAW_BIN    Path to the openclaw binary (default: openclaw)
  NO_COLOR              Disable colors

Docs & issues: https://github.com/BenchAGI/bench-cli
`;

const COMMANDS = {
  ask: cmdAsk,
  chat: cmdChat,
  feed: cmdFeed,
  agents: cmdAgents,
  sessions: cmdSessions,
  tasks: cmdTasks,
  status: cmdStatus,
  tail: cmdTail,
  commitments: cmdCommitments,
  setup: cmdSetup,
};

export async function run(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(TOP_HELP);
    return 0;
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const [name, ...rest] = argv;
  const handler = COMMANDS[name];
  if (!handler) {
    process.stderr.write(`bench: unknown command "${name}"\n\n${TOP_HELP}`);
    process.exit(64);
  }
  try {
    const code = await handler(rest);
    process.exit(code ?? 0);
  } catch (err) {
    const msg = err?.message ?? String(err);
    process.stderr.write(`bench ${name}: ${cleanStderr(msg)}\n`);
    if (err?.stderr) process.stderr.write(cleanStderr(err.stderr) + "\n");
    process.exit(err?.exitCode ?? 1);
  }
}
