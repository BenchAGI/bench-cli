// `bench tasks` — list tracked background tasks.
import { parseArgs } from "../lib/args.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { table, c, relativeAge, truncate } from "../lib/format.mjs";

const HELP = `bench tasks [options]

List tracked background tasks (subagent / acp / cron / cli).

Options:
  --status <name>     queued|running|succeeded|failed|timed_out|cancelled|lost
  --runtime <name>    subagent|acp|cron|cli
  --limit <n>         Max rows to print (default: 20)
  --json              Output raw JSON
  -h, --help
`;

export async function cmdTasks(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "json"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = ["tasks", "list", "--json"];
  if (flags.status) args.push("--status", String(flags.status));
  if (flags.runtime) args.push("--runtime", String(flags.runtime));
  const data = await runOpenclawJson(args);
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  const tasks = Array.isArray(data) ? data : (data.tasks ?? []);
  const limit = Number(flags.limit ?? 20);
  const sorted = [...tasks].sort(
    (a, b) =>
      (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
  const visible = sorted.slice(0, limit);
  if (!visible.length) {
    process.stdout.write(c.dim("(no tasks)") + "\n");
    return 0;
  }
  const rows = visible.map((t) => [
    truncate(String(t.id ?? t.taskId ?? ""), 14),
    t.runtime ?? t.kind ?? "",
    statusColor(t.status),
    truncate(t.label ?? t.title ?? t.command ?? "", 40),
    relativeAge(t.updatedAt ?? t.createdAt),
  ]);
  process.stdout.write(
    table(["ID", "KIND", "STATUS", "LABEL", "UPDATED"], rows) + "\n",
  );
  return 0;
}

function statusColor(s) {
  if (!s) return "";
  switch (s) {
    case "running":
    case "queued":
      return c.cyan(s);
    case "succeeded":
      return c.green(s);
    case "failed":
    case "timed_out":
    case "lost":
      return c.red(s);
    case "cancelled":
      return c.yellow(s);
    default:
      return s;
  }
}
