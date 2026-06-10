// `bench forge` — submit requests to Bench's Forge and read answers back.
//
// Customer agents/operators talk to Bench's build loop without GitHub access:
//   bench forge submit  → open a packet (dev request, question, design pass…)
//   bench forge list    → see your packets and their states
//   bench forge status  → one packet + the customer-visible message thread
//
// Server contract: /api/v1/forge/packets/agent (BenchAGI_Mono_Repo, WS5).
import { parseArgs } from "../lib/args.mjs";
import { table, c, relativeAge, truncate } from "../lib/format.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_API_BASE = "https://benchagi.com/api";
const KINDS = ["dev-request", "agent-behavior", "design-pass", "support", "question"];

const HELP = `bench forge <subcommand> [options]

Send requests to Bench's Forge and read the answers back — no GitHub needed.

Subcommands:
  submit                Open a new Forge packet
  list                  List your Forge packets
  status <packetId>     Packet details + Bench's replies

Submit options:
  --title <text>        Short title (required)
  --goal <text>         What you want done / answered (required)
  --kind <name>         ${KINDS.join("|")} (default: dev-request)
  --target-agent <id>   Bench agent the request is aimed at (e.g. aurelius)
  --success <text>      Success criteria, so Bench knows when it's done

List options:
  --state <name>        Filter by packet state (e.g. received)
  --since <ms>          Only packets updated since this UNIX ms timestamp
  --limit <n>           Max rows to print (default: 20)

Common options:
  --json                Output raw JSON
  -h, --help

Auth (resolved in this order):
  API key      $BENCH_API_KEY, else ~/.openclaw/bench-cloud.key
  Instance id  $BENCH_INSTANCE_ID, else ~/.openclaw/bench-cloud.json
  API base     $BENCH_API_BASE, else bench-cloud.json apiBase, else ${DEFAULT_API_BASE}

Examples:
  bench forge submit --title "Crop tool misaligns" --goal "Fix the crop handles drifting on rotated photos" --kind dev-request
  bench forge list --state received
  bench forge status fp_abc123
`;

export async function cmdForge(argv) {
  const { positionals, flags } = parseArgs(argv, {
    booleanFlags: ["help", "json"],
    aliases: { h: "help" },
  });
  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const [sub, ...rest] = positionals;
  switch (sub) {
    case "submit":
      return forgeSubmit(flags);
    case "list":
      return forgeList(flags);
    case "status":
      return forgeStatus(rest, flags);
    default:
      process.stderr.write(`bench forge: unknown subcommand "${sub}"\n\n${HELP}`);
      return 64;
  }
}

// --- auth resolution -------------------------------------------------------

/**
 * Resolve Forge auth: API key, instance id, API base.
 * Precedence: env → ~/.openclaw files → default base. Never logs the key.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {{ apiKey: string, instanceId: string, apiBase: string }}
 */
export function resolveForgeAuth({ env = process.env, home = homedir() } = {}) {
  const dir = path.join(home, ".openclaw");
  let fileCfg = null;
  try {
    fileCfg = JSON.parse(readFileSync(path.join(dir, "bench-cloud.json"), "utf8"));
  } catch {
    // missing/invalid → env or defaults only
  }
  let apiKey = String(env.BENCH_API_KEY ?? "").trim();
  if (!apiKey) {
    try {
      apiKey = readFileSync(path.join(dir, "bench-cloud.key"), "utf8").trim();
    } catch {
      apiKey = "";
    }
  }
  const instanceId = String(env.BENCH_INSTANCE_ID ?? fileCfg?.instanceId ?? "").trim();
  const apiBase = String(env.BENCH_API_BASE ?? fileCfg?.apiBase ?? DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
  return { apiKey, instanceId, apiBase };
}

function requireForgeAuth() {
  const auth = resolveForgeAuth();
  const missing = [];
  if (!auth.apiKey) missing.push("API key ($BENCH_API_KEY or ~/.openclaw/bench-cloud.key)");
  if (!auth.instanceId)
    missing.push('instance id ($BENCH_INSTANCE_ID or {"instanceId": …} in ~/.openclaw/bench-cloud.json)');
  if (missing.length) {
    throw new Error(
      `not connected to Bench Cloud — missing ${missing.join(" and ")}.\n` +
        `Follow the install recipe, or ask Bench to mint your instance key with forge scopes.`,
    );
  }
  return auth;
}

// --- HTTP ------------------------------------------------------------------

async function forgeFetch(auth, method, pathname, { query, body } = {}) {
  const url = new URL(auth.apiBase + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${auth.apiKey}`,
        "x-expected-instance-id": auth.instanceId,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`could not reach ${url.origin} (${err?.cause?.code ?? err?.message ?? err})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON error body → fall through to the status handling below
  }
  if (!res.ok) {
    const detail = data?.error ?? data?.message ?? truncate(text.trim(), 200);
    let hint = "";
    if (res.status === 401 || res.status === 403) {
      hint = " — check your instance API key has forge scopes";
    } else if (res.status === 404) {
      hint = " — the Forge API may not be deployed to this server yet";
    }
    throw new Error(`server responded ${res.status}${detail ? `: ${detail}` : ""}${hint}`);
  }
  return data ?? {};
}

// --- subcommands -----------------------------------------------------------

async function forgeSubmit(flags) {
  const title = strFlag(flags.title);
  const goal = strFlag(flags.goal);
  if (!title || !goal) {
    throw new Error('submit requires --title "..." and --goal "..." (see `bench forge --help`)');
  }
  const kind = strFlag(flags.kind);
  if (kind && !KINDS.includes(kind)) {
    throw new Error(`invalid --kind "${kind}" (expected one of: ${KINDS.join(", ")})`);
  }
  const body = { title, goal };
  if (kind) body.kind = kind;
  if (strFlag(flags["target-agent"])) body.targetAgent = strFlag(flags["target-agent"]);
  if (strFlag(flags.success)) body.successCriteria = strFlag(flags.success);

  const auth = requireForgeAuth();
  const data = await forgeFetch(auth, "POST", "/v1/forge/packets/agent", { body });
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  const p = data.packet ?? {};
  process.stdout.write(
    `${c.green("✓")} Forge packet submitted\n` +
      `  packetId  ${c.bold(String(p.packetId ?? "?"))}\n` +
      `  state     ${stateColor(p.state)}\n` +
      `  kind      ${p.kind ?? ""}\n` +
      (p.targetAgent ? `  target    ${p.targetAgent}\n` : "") +
      c.dim(`  bench forge status ${p.packetId ?? "<packetId>"}  # to read Bench's answer\n`),
  );
  return 0;
}

async function forgeList(flags) {
  const auth = requireForgeAuth();
  const query = {};
  if (strFlag(flags.state)) query.state = strFlag(flags.state);
  if (strFlag(flags.since)) query.since = strFlag(flags.since);
  const data = await forgeFetch(auth, "GET", "/v1/forge/packets/agent", { query });
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  const packets = Array.isArray(data.packets) ? data.packets : [];
  const limit = Number(flags.limit ?? 20);
  const sorted = [...packets].sort(
    (a, b) => (b.updatedAtMs ?? b.createdAtMs ?? 0) - (a.updatedAtMs ?? a.createdAtMs ?? 0),
  );
  const visible = sorted.slice(0, limit);
  if (!visible.length) {
    process.stdout.write(c.dim("(no forge packets)") + "\n");
    return 0;
  }
  const rows = visible.map((p) => [
    truncate(String(p.packetId ?? ""), 14),
    p.kind ?? "",
    stateColor(p.state),
    relativeAge(p.updatedAtMs ?? p.createdAtMs),
    truncate(p.title ?? "", 60),
  ]);
  process.stdout.write(table(["PACKET", "KIND", "STATE", "UPDATED", "TITLE"], rows) + "\n");
  if (sorted.length > visible.length) {
    process.stdout.write(c.dim(`… ${sorted.length - visible.length} more (use --limit)`) + "\n");
  }
  return 0;
}

async function forgeStatus(positionals, flags) {
  const packetId = positionals[0];
  if (!packetId) {
    throw new Error("status requires a packetId (see `bench forge list`)");
  }
  const auth = requireForgeAuth();
  const [packetData, messageData] = await Promise.all([
    forgeFetch(auth, "GET", "/v1/forge/packets/agent", { query: { packetId } }),
    forgeFetch(auth, "GET", `/v1/forge/packets/agent/${encodeURIComponent(packetId)}/messages`),
  ]);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...packetData, ...messageData }, null, 2) + "\n");
    return 0;
  }
  const packet = (Array.isArray(packetData.packets) ? packetData.packets : [])[0];
  if (!packet) {
    throw new Error(`packet "${packetId}" not found for this instance`);
  }
  const lines = [
    `${c.bold(String(packet.packetId ?? packetId))}  ${stateColor(packet.state)}`,
    `  kind      ${packet.kind ?? ""}`,
    `  title     ${packet.title ?? ""}`,
    `  goal      ${packet.goal ?? ""}`,
  ];
  if (packet.targetAgent) lines.push(`  target    ${packet.targetAgent}`);
  if (packet.successCriteria) lines.push(`  success   ${packet.successCriteria}`);
  lines.push(`  created   ${relativeAge(packet.createdAtMs)}`);
  lines.push(`  updated   ${relativeAge(packet.updatedAtMs)}`);
  process.stdout.write(lines.join("\n") + "\n");

  const messages = Array.isArray(messageData.messages) ? messageData.messages : [];
  if (!messages.length) {
    process.stdout.write("\n" + c.dim("(no messages from Bench yet — check back soon)") + "\n");
    return 0;
  }
  process.stdout.write("\n" + c.bold("Thread:") + "\n");
  for (const m of messages) {
    const who = m.authorType === "customer" ? c.cyan("you") : c.magenta(m.authorType ?? "bench");
    const meta = [m.kind, relativeAge(m.createdAtMs)].filter(Boolean).join(" · ");
    process.stdout.write(`  ${who} ${c.dim(meta)}\n`);
    for (const line of String(m.body ?? "").split("\n")) {
      process.stdout.write(`    ${line}\n`);
    }
  }
  return 0;
}

// --- helpers ---------------------------------------------------------------

function strFlag(v) {
  return typeof v === "string" ? v.trim() : "";
}

function stateColor(s) {
  if (!s) return "";
  switch (s) {
    case "received":
    case "queued":
    case "triaged":
    case "in-progress":
      return c.cyan(s);
    case "answered":
    case "shipped":
    case "done":
    case "closed":
      return c.green(s);
    case "rejected":
    case "failed":
      return c.red(s);
    case "needs-info":
    case "blocked":
      return c.yellow(s);
    default:
      return s;
  }
}
