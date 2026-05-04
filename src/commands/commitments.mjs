// `bench commitments` — list inferred follow-up commitments.
import { parseArgs } from "../lib/args.mjs";
import { resolveAgentId } from "../lib/agents.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { table, c, relativeAge, truncate } from "../lib/format.mjs";

const HELP = `bench commitments [options]

List inferred follow-up commitments tracked by OpenClaw.

Options:
  --agent <id>       Filter to one agent (short name or canonical id)
  --status <s>       pending|sent|dismissed|snoozed|expired
  --all              Include all statuses
  --limit <n>        Max rows (default: 30)
  --json             Output raw JSON
  -h, --help
`;

export async function cmdCommitments(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "json", "all"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = ["commitments", "list", "--json"];
  if (flags.all) args.push("--all");
  if (flags.agent) {
    const id = await resolveAgentId(String(flags.agent));
    args.push("--agent", id);
  }
  if (flags.status) args.push("--status", String(flags.status));
  const data = await runOpenclawJson(args);
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  const items = Array.isArray(data) ? data : (data.commitments ?? []);
  const limit = Number(flags.limit ?? 30);
  if (!items.length) {
    process.stdout.write(c.dim("(no commitments)") + "\n");
    return 0;
  }
  const rows = items
    .slice(0, limit)
    .map((it) => [
      truncate(String(it.id ?? ""), 14),
      it.agentId ?? it.agent ?? "",
      statusColor(it.status),
      truncate(it.title ?? it.summary ?? it.text ?? "", 50),
      relativeAge(it.dueAt ?? it.updatedAt ?? it.createdAt),
    ]);
  process.stdout.write(
    table(["ID", "AGENT", "STATUS", "TITLE", "WHEN"], rows) + "\n",
  );
  if (items.length > limit) {
    process.stdout.write(
      c.dim(`… ${items.length - limit} more (use --limit)`) + "\n",
    );
  }
  return 0;
}

function statusColor(s) {
  if (!s) return "";
  switch (s) {
    case "pending":
      return c.cyan(s);
    case "sent":
      return c.green(s);
    case "dismissed":
    case "expired":
      return c.dim(s);
    case "snoozed":
      return c.yellow(s);
    default:
      return s;
  }
}
