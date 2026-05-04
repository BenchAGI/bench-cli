// `bench sessions [agent]` — list recent sessions for an agent (or all).
import { parseArgs } from "../lib/args.mjs";
import { resolveAgentId } from "../lib/agents.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { table, c, relativeAge, truncate } from "../lib/format.mjs";

const HELP = `bench sessions [agent] [options]

List stored conversation sessions for an agent.

Arguments:
  [agent]            Agent name; defaults to the configured default agent.

Options:
  --all-agents       Aggregate sessions across all agents
  --active <mins>    Only sessions updated within the past N minutes
  --limit <n>        Max sessions to display (default: 20)
  --json             Output raw JSON
  -h, --help
`;

export async function cmdSessions(argv) {
  const { positionals, flags } = parseArgs(argv, {
    booleanFlags: ["help", "all-agents", "json"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = ["sessions", "--json"];
  if (flags["all-agents"]) {
    args.push("--all-agents");
  } else if (positionals[0]) {
    const agentId = await resolveAgentId(positionals[0]);
    args.push("--agent", agentId);
  }
  if (flags.active) args.push("--active", String(flags.active));

  const data = await runOpenclawJson(args);
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  const sessions = Array.isArray(data) ? data : (data.sessions ?? []);
  const limit = Number(flags.limit ?? 20);
  const sorted = [...sessions].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const visible = sorted.slice(0, limit);
  if (!visible.length) {
    process.stdout.write(c.dim("(no sessions)") + "\n");
    return 0;
  }
  const rows = visible.map((s) => [
    truncate(String(s.key ?? s.sessionId ?? ""), 60),
    s.agentId ?? "",
    s.kind ?? "",
    s.model ?? "",
    `${fmtTokens(s.totalTokens)}/${fmtTokens(s.contextTokens)}`,
    relativeAge(s.updatedAt),
  ]);
  process.stdout.write(
    table(
      ["KEY", "AGENT", "KIND", "MODEL", "TOK/CTX", "UPDATED"],
      rows,
    ) + "\n",
  );
  if (sorted.length > visible.length) {
    process.stdout.write(
      c.dim(`… ${sorted.length - visible.length} more (use --limit)`) + "\n",
    );
  }
  return 0;
}

function fmtTokens(n) {
  if (n === null || n === undefined) return "-";
  const v = Number(n);
  if (!Number.isFinite(v)) return "-";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(v);
}
