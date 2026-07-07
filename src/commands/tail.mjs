// `bench tail` — friendly live tail over `openclaw logs --follow --json`.
import { spawn } from "node:child_process";
import { parseArgs } from "../lib/args.mjs";
import { OPENCLAW_BIN } from "../lib/openclaw.mjs";
import { c, relativeAge, truncate } from "../lib/format.mjs";

const HELP = `bench tail [options]

Live-tail the gateway log stream with friendly formatting.

Options:
  --filter <text>    Only show lines containing this text (case-insensitive)
  --agent <id>       Filter to a single agent id
  --level <name>     Minimum level (debug|info|warn|error|fatal)
  --raw              Print the underlying JSON line as-is
  --limit <n>        Initial backlog (default: 100)
  -h, --help
`;

const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export async function cmdTail(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "raw"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const minLevel = LEVEL_ORDER[String(flags.level ?? "info").toLowerCase()] ?? 2;
  const filterRe = flags.filter
    ? safeRegex(String(flags.filter))
    : null;
  const agentFilter = flags.agent ? String(flags.agent) : null;
  const limit = String(flags.limit ?? 100);

  const args = ["logs", "--follow", "--json", "--limit", limit];
  const child = spawn(OPENCLAW_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Bubble fatal errors from openclaw promptly.
  let stderrBuf = "";
  child.stderr.on("data", (b) => {
    stderrBuf += b.toString("utf8");
  });

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line, { flags, minLevel, filterRe, agentFilter });
    }
  });

  return await new Promise((resolve) => {
    child.on("close", (code) => {
      if (code !== 0 && stderrBuf) {
        process.stderr.write(c.red("openclaw logs failed:\n") + stderrBuf);
      }
      resolve(code ?? 0);
    });
    process.on("SIGINT", () => {
      try { child.kill("SIGINT"); } catch {}
    });
  });
}

function handleLine(line, ctx) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (ctx.flags.raw) {
    process.stdout.write(trimmed + "\n");
    return;
  }
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    // Non-JSON line — print verbatim if it passes filters.
    if (ctx.filterRe && !ctx.filterRe.test(trimmed)) return;
    process.stdout.write(trimmed + "\n");
    return;
  }
  const level = String(entry.level ?? "info").toLowerCase();
  const levelN = LEVEL_ORDER[level] ?? 2;
  if (levelN < ctx.minLevel) return;
  const agent = entry.agent ?? entry.agentId ?? entry.fields?.agent ?? "";
  if (ctx.agentFilter && agent !== ctx.agentFilter) return;
  const msg =
    entry.msg ?? entry.message ?? entry.text ?? JSON.stringify(entry);
  if (ctx.filterRe && !ctx.filterRe.test(msg) && !ctx.filterRe.test(agent)) {
    return;
  }
  const ts = entry.time ?? entry.ts ?? entry.timestamp ?? Date.now();
  const tsStr = formatShortTime(ts);
  process.stdout.write(
    `${c.dim(tsStr)}  ${colorLevel(level)}  ${c.cyan(truncate(agent, 18).padEnd(18))}  ${msg}\n`,
  );
}

function colorLevel(level) {
  switch (level) {
    case "fatal":
    case "error":
      return c.red(level.toUpperCase().padEnd(5));
    case "warn":
      return c.yellow("WARN ");
    case "info":
      return c.green("INFO ");
    case "debug":
      return c.dim("DEBUG");
    default:
      return level.toUpperCase().padEnd(5);
  }
}

function formatShortTime(ts) {
  const ms = typeof ts === "string" ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(ms)) return "          ";
  const d = new Date(ms);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0") +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

// Literal (escaped) match only — feeding the raw arg to RegExp lets a
// crafted pattern wedge the tail loop (CodeQL js/regex-injection).
function safeRegex(s) {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
