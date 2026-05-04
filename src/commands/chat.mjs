// `bench chat <agent>` — per-agent REPL.
//
// `openclaw chat` (alias for `openclaw tui`) only targets the *configured
// default* agent and does not accept --agent. To give customers a real
// per-agent interactive surface, we run our own REPL: each input line is
// sent via `openclaw agent --agent <id> --session-id <session> --message ...`
// and the JSON reply is rendered locally.
import readline from "node:readline";
import { parseArgs } from "../lib/args.mjs";
import { resolveAgentId } from "../lib/agents.mjs";
import {
  runOpenclaw,
  extractJson,
  cleanStderr,
  streamOpenclaw,
} from "../lib/openclaw.mjs";
import { c, relativeAge } from "../lib/format.mjs";

const HELP = `bench chat <agent> [options]

Open an interactive chat with a specific agent. Each line you type is sent
as one turn; the agent's reply is printed inline.

Arguments:
  <agent>             Agent name (short or canonical id).

Options:
  --session <key>     Session key (default: bench-chat). Conversations resume
                      across runs when you pass the same --session.
  --thinking <lvl>    off|minimal|low|medium|high|xhigh|adaptive|max
  --high              Shortcut for --thinking high
  --xhigh             Shortcut for --thinking xhigh
  --model <id>        Override model for the whole session
  --timeout <secs>    Per-turn timeout (default: 3600)
  --tui               Fallback to \`openclaw chat\` (default-agent TUI). Useful
                      when you want the rich TUI and don't care which agent.
  -h, --help

Slash commands inside chat:
  /exit, /quit        Leave the chat
  /clear              Clear the screen
  /session            Print the current session key
  /help               Show this help
`;

export async function cmdChat(argv) {
  const { positionals, flags } = parseArgs(argv, {
    booleanFlags: ["help", "high", "xhigh", "tui"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (flags.tui) {
    // Pure TUI fallback — uses the OpenClaw default agent.
    const args = ["chat"];
    if (flags.session) args.push("--session", String(flags.session));
    if (flags.thinking) args.push("--thinking", String(flags.thinking));
    process.stderr.write(c.dim("opening openclaw default-agent TUI…\n"));
    const { code } = await streamOpenclaw(args);
    return code;
  }

  const [agentName] = positionals;
  if (!agentName) {
    process.stderr.write("bench chat: missing <agent>\n\n" + HELP);
    return 64;
  }
  const agentId = await resolveAgentId(agentName);
  const session = String(flags.session ?? "bench-chat");
  const sessionKey = `agent:${agentId}:${session}`;
  const thinking =
    flags.thinking ?? (flags.xhigh ? "xhigh" : flags.high ? "high" : null);
  const timeout = String(flags.timeout ?? 3600);

  process.stdout.write(
    c.bold(`bench chat → ${c.cyan(agentId)}`) +
      c.dim(`  session=${session}` + (thinking ? `  thinking=${thinking}` : "")) +
      "\n" +
      c.dim("Type /help for commands, /exit to leave.\n\n"),
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.magenta("you › "),
    historySize: 200,
  });

  let busy = false;
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/exit" || text === "/quit") break;
    if (text === "/clear") {
      process.stdout.write("\x1b[2J\x1b[H");
      rl.prompt();
      continue;
    }
    if (text === "/session") {
      process.stdout.write(c.dim(sessionKey + "\n"));
      rl.prompt();
      continue;
    }
    if (text === "/help") {
      process.stdout.write(HELP);
      rl.prompt();
      continue;
    }
    if (busy) {
      process.stdout.write(c.yellow("(still waiting on previous turn)\n"));
      rl.prompt();
      continue;
    }
    busy = true;
    const args = [
      "agent",
      "--agent",
      agentId,
      "--session-id",
      sessionKey,
      "--timeout",
      timeout,
      "--message",
      text,
      "--json",
    ];
    if (thinking) args.push("--thinking", String(thinking));
    if (flags.model) args.push("--model", String(flags.model));

    const spinner = startSpinner(`thinking…`);
    const { code, stdout, stderr } = await runOpenclaw(args);
    spinner.stop();
    busy = false;

    if (code !== 0) {
      process.stdout.write(c.red("error: ") + cleanStderr(stderr) + "\n");
      rl.prompt();
      continue;
    }
    const parsed = extractJson(stdout);
    const reply = pickReplyText(parsed) ?? stdout.trim();
    process.stdout.write(c.cyan(`${agentId} › `) + reply + "\n\n");
    rl.prompt();
  }
  rl.close();
  process.stdout.write(c.dim(`bye — session=${sessionKey} (last activity ${relativeAge(Date.now())})\n`));
  return 0;
}

function pickReplyText(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.reply ??
    payload.message ??
    payload.text ??
    payload.result?.text ??
    payload.result?.message ??
    payload.response?.text ??
    null
  );
}

function startSpinner(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(label + "\n");
    return { stop: () => {} };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stdout.write(c.dim(`${frames[0]} ${label}`));
  const handle = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${c.dim(`${frames[i]} ${label}`)}`);
  }, 80);
  return {
    stop: () => {
      clearInterval(handle);
      process.stdout.write("\r\x1b[2K"); // clear line
    },
  };
}
