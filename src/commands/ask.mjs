// `bench ask <agent> "..."` — single-turn message to an agent.
import { parseArgs } from "../lib/args.mjs";
import { resolveAgentId } from "../lib/agents.mjs";
import { runOpenclaw, extractJson, cleanStderr } from "../lib/openclaw.mjs";
import { c } from "../lib/format.mjs";

const HELP = `bench ask <agent> [message] [options]

Send a single message to an agent and print the reply.

Arguments:
  <agent>            Agent name. Short names like "aurelius" map to canonical
                     ids ("kestrel-aurelius"). Use \`bench agents\` to list.
  [message]          Message body. If omitted, stdin is read.

Options:
  --high             Shortcut for --thinking high
  --xhigh            Shortcut for --thinking xhigh
  --thinking <lvl>   off|minimal|low|medium|high|xhigh|adaptive|max
  --model <id>       Override model for this turn (provider/model)
  --timeout <secs>   Agent timeout in seconds (default: 3600)
  --session-id <id>  Use an explicit session id
  --json             Print raw JSON from openclaw instead of the reply text
  --raw              Stream openclaw output through unchanged
  -h, --help         Show this help

Examples:
  bench ask aurelius --high "Daily briefing please"
  echo "summarize the inbox" | bench ask cole
  bench ask aurelius --model anthropic/claude-opus-4-7 "..."
`;

export async function cmdAsk(argv) {
  const { positionals, flags } = parseArgs(argv, {
    booleanFlags: ["help", "high", "xhigh", "json", "raw"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [agentName, ...messageParts] = positionals;
  if (!agentName) {
    process.stderr.write("bench ask: missing <agent>\n\n" + HELP);
    return 64;
  }
  const agentId = await resolveAgentId(agentName);

  let message = messageParts.join(" ").trim();
  if (!message) {
    if (process.stdin.isTTY) {
      process.stderr.write(
        "bench ask: no message provided (pass on the command line or via stdin)\n",
      );
      return 64;
    }
    message = await readStdin();
  }
  if (!message) {
    process.stderr.write("bench ask: empty message\n");
    return 64;
  }

  const thinking =
    flags.thinking || (flags.xhigh ? "xhigh" : flags.high ? "high" : undefined);
  const timeout = String(flags.timeout ?? 3600);

  const args = [
    "agent",
    "--agent",
    agentId,
    "--timeout",
    timeout,
    "--message",
    message,
    "--json",
  ];
  if (thinking) args.push("--thinking", String(thinking));
  if (flags.model) args.push("--model", String(flags.model));
  if (flags["session-id"]) args.push("--session-id", String(flags["session-id"]));

  if (flags.raw) {
    // Drop --json to let openclaw render its own pretty output.
    const idx = args.indexOf("--json");
    if (idx >= 0) args.splice(idx, 1);
  }

  const { code, stdout, stderr } = await runOpenclaw(args);
  if (flags.raw) {
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(cleanStderr(stderr) + "\n");
    return code;
  }
  if (code !== 0) {
    process.stderr.write(c.red("openclaw failed:\n") + cleanStderr(stderr) + "\n");
    return code || 1;
  }
  if (flags.json) {
    process.stdout.write(stdout);
    return 0;
  }
  const parsed = extractJson(stdout);
  if (!parsed) {
    // Fallback: just dump whatever the CLI gave us.
    process.stdout.write(stdout);
    return 0;
  }
  const text = pickReplyText(parsed);
  if (text) {
    process.stdout.write(text.trimEnd() + "\n");
  } else {
    process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
  }
  return 0;
}

function pickReplyText(payload) {
  if (!payload || typeof payload !== "object") return null;
  // Try common shapes from `openclaw agent --json`.
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

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}
