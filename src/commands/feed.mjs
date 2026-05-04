// `bench feed` — single compact view that fuses status, sessions, and tasks.
import { parseArgs } from "../lib/args.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { c, relativeAge, truncate } from "../lib/format.mjs";
import { formatStatus } from "./status.mjs";

const HELP = `bench feed [options]

Compact fused snapshot: gateway/channel health, recent sessions, active tasks.

Options:
  --active <mins>     Sessions window (default: 240)
  --tasks <n>         Tasks to show (default: 5)
  --sessions <n>      Sessions to show (default: 6)
  --json              Output raw JSON of the underlying queries
  -h, --help
`;

export async function cmdFeed(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "json"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const activeMins = Number(flags.active ?? 240);
  const sessionLimit = Number(flags.sessions ?? 6);
  const taskLimit = Number(flags.tasks ?? 5);

  const [status, sessions, tasks] = await Promise.all([
    safeJson(["status", "--json"]),
    safeJson([
      "sessions",
      "--all-agents",
      "--active",
      String(activeMins),
      "--json",
    ]),
    safeJson(["tasks", "list", "--json"]),
  ]);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ status, sessions, tasks }, null, 2) + "\n",
    );
    return 0;
  }

  const out = [];
  if (status.ok) {
    out.push(formatStatus(status.value));
  } else {
    out.push(c.red("Gateway: error  ") + c.dim(status.error));
  }

  // Sessions
  out.push("");
  out.push(c.bold(`Recent sessions (last ${activeMins}m)`));
  if (!sessions.ok) {
    out.push("  " + c.red("error: ") + sessions.error);
  } else {
    const list = Array.isArray(sessions.value)
      ? sessions.value
      : (sessions.value.sessions ?? []);
    const sorted = [...list].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    if (!sorted.length) {
      out.push("  " + c.dim("(none)"));
    } else {
      for (const s of sorted.slice(0, sessionLimit)) {
        out.push(
          "  " +
            c.cyan(truncate(String(s.agentId ?? "?"), 18).padEnd(18)) +
            c.dim(relativeAge(s.updatedAt).padEnd(10)) +
            truncate(String(s.key ?? s.sessionId ?? ""), 80),
        );
      }
      if (sorted.length > sessionLimit) {
        out.push(
          "  " + c.dim(`… ${sorted.length - sessionLimit} more sessions`),
        );
      }
    }
  }

  // Tasks
  out.push("");
  out.push(c.bold("Background tasks"));
  if (!tasks.ok) {
    out.push("  " + c.red("error: ") + tasks.error);
  } else {
    const list = Array.isArray(tasks.value)
      ? tasks.value
      : (tasks.value.tasks ?? []);
    const sorted = [...list].sort(
      (a, b) =>
        (b.updatedAt ?? b.createdAt ?? 0) -
        (a.updatedAt ?? a.createdAt ?? 0),
    );
    if (!sorted.length) {
      out.push("  " + c.dim("(none)"));
    } else {
      for (const t of sorted.slice(0, taskLimit)) {
        out.push(
          "  " +
            statusColor(t.status).padEnd(10) +
            c.dim((t.runtime ?? t.kind ?? "?").padEnd(10)) +
            truncate(t.label ?? t.title ?? t.command ?? "", 60) +
            "  " +
            c.dim(relativeAge(t.updatedAt ?? t.createdAt)),
        );
      }
      if (sorted.length > taskLimit) {
        out.push("  " + c.dim(`… ${sorted.length - taskLimit} more tasks`));
      }
    }
  }

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

async function safeJson(args) {
  try {
    return { ok: true, value: await runOpenclawJson(args) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
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
