// `bench status` — terse health snapshot from `openclaw status --json`.
import { parseArgs } from "../lib/args.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { c, relativeAge } from "../lib/format.mjs";

const HELP = `bench status [options]

Show a compact health snapshot of the local OpenClaw gateway.

Options:
  --json     Output raw JSON
  -h, --help
`;

export async function cmdStatus(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "json"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const data = await runOpenclawJson(["status", "--json"]);
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatStatus(data) + "\n");
  return 0;
}

export function formatStatus(data) {
  const lines = [];
  const gw = data?.gateway ?? {};
  const gwSvc = data?.gatewayService?.runtime ?? {};
  const gwUp =
    gw.reachable === true ||
    gw.connected === true ||
    gw.up === true ||
    gw.status === "ok" ||
    gw.ok === true ||
    gwSvc.status === "running" ||
    gwSvc.state === "active";
  const latency =
    typeof gw.connectLatencyMs === "number"
      ? `  ${gw.connectLatencyMs}ms`
      : "";
  lines.push(
    c.bold("Gateway: ") +
      (gwUp ? c.green("up") : c.red("down")) +
      (gw.url ? c.dim(`  ${gw.url}`) : "") +
      c.dim(latency),
  );

  const channels =
    data?.channelSummary ??
    data?.channels ??
    data?.channelHealth ??
    data?.health?.channels ??
    [];
  if (Array.isArray(channels) && channels.length) {
    const summary = channels
      .map((ch) => {
        const ok =
          ch.ok ?? ch.healthy ?? ch.connected ?? ch.status === "ok";
        const dot = ok ? c.green("●") : c.red("●");
        return `${dot} ${ch.id ?? ch.channel ?? ch.name ?? "?"}`;
      })
      .join("  ");
    lines.push(c.bold("Channels: ") + summary);
  } else if (Array.isArray(channels)) {
    lines.push(c.bold("Channels: ") + c.dim("(none configured)"));
  }

  // OpenClaw status returns { agents: { agents: [...], totalSessions, defaultId } }.
  const agentsBlock = data?.agents ?? {};
  const agents = Array.isArray(agentsBlock)
    ? agentsBlock
    : (agentsBlock.agents ?? agentsBlock.list ?? []);
  const defaultId = agentsBlock.defaultId ?? null;
  if (Array.isArray(agents) && agents.length) {
    const totalSessions =
      agentsBlock.totalSessions ??
      agents.reduce((n, a) => n + (a.sessionsCount ?? 0), 0);
    lines.push(
      c.bold("Agents: ") +
        `${agents.length}  ` +
        c.dim(`${totalSessions} sessions total`),
    );
    const tops = [...agents]
      .sort(
        (a, b) =>
          (a.lastActiveAgeMs ?? Infinity) - (b.lastActiveAgeMs ?? Infinity),
      )
      .slice(0, 4);
    for (const a of tops) {
      const lastTs = a.lastUpdatedAt ?? null;
      const marker = a.id === defaultId ? c.green("●") : " ";
      lines.push(
        "  " +
          marker +
          " " +
          c.cyan(a.id) +
          c.dim(
            `  sessions=${a.sessionsCount ?? 0}  last=${lastTs ? relativeAge(lastTs) : "?"}`,
          ),
      );
    }
  }

  // Background task summary (top-level `tasks` block in `openclaw status --json`).
  const tasks = data?.tasks;
  if (tasks && typeof tasks === "object" && !Array.isArray(tasks)) {
    const total = tasks.total ?? 0;
    const active = tasks.active ?? 0;
    const failures = tasks.failures ?? 0;
    const failColor = failures > 0 ? c.red(`failures=${failures}`) : c.dim(`failures=${failures}`);
    lines.push(
      c.bold("Tasks: ") +
        c.dim(`total=${total}  `) +
        c.cyan(`active=${active}  `) +
        failColor,
    );
  }
  return lines.join("\n");
}
