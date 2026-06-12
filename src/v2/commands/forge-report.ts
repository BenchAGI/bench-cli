// `benchagi doctor --report` — file the doctor diagnostics on the BenchAGI Forge.
//
// Tenant harnesses have no GitHub account; the cowork JWT in
// ~/.claude/config/bench-cowork.json authenticates against the control plane
// (POST /api/v1/cowork/forge/ticket), which syncs the ticket to a GitHub issue
// on Bench's side. On a stale token we POST /api/v1/cowork/auth/refresh once,
// persist the renewed token atomically, and retry.

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { c, eprintln, println } from "../render/ansi.js";
import { CLI_VERSION } from "./version.js";
import type { DoctorCheck } from "./doctor.js";

const CONFIG_PATH = join(homedir(), ".claude", "config", "bench-cowork.json");
const TICKET_PATH = "/cowork/forge/ticket";
const REFRESH_PATH = "/cowork/auth/refresh";
const ATTACH_MAX_BYTES = 96 * 1024; // route caps body at 120KB; leave headroom for the table
const SYNC_POLL_ATTEMPTS = 4; // ~6s total
const SYNC_POLL_INTERVAL_MS = 1_500;

type CoworkConfig = {
  raw: Record<string, unknown>;
  apiBase: string;
  token: string;
};

type TicketResponse = {
  ticketId: string;
  status: string;
  issueUrl?: string;
};

type RefreshResponse = {
  token: string;
  email?: string;
  expiresInSeconds?: number;
};

export async function commandForgeReport(checks: DoctorCheck[], attachPath?: string): Promise<void> {
  const config = await loadCoworkConfig();
  if (!config) {
    printLoginInstructions();
    process.exit(1);
  }

  let attach: { name: string; content: string } | null = null;
  if (attachPath) {
    try {
      attach = { name: basename(attachPath), content: await readFile(attachPath, "utf8") };
    } catch (err) {
      eprintln(c.red(`cannot read --attach file ${attachPath}: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

  const body = composeReport(checks, attach);
  // The composed report goes to stdout first — if filing fails, nothing is lost.
  println();
  println(c.bold("Forge report"));
  println(body);

  const payload = {
    severity: severityFor(checks),
    subject: subjectFor(checks),
    body,
    reporterContext: {
      machine: hostname(),
      platform: `${process.platform}-${process.arch}`,
      cliVersion: CLI_VERSION,
      node: process.version,
      checks,
    },
  };

  let token = config.token;
  let res = await postTicket(config.apiBase, token, payload);
  if (res.status === 401) {
    const refreshed = await refreshToken(config.apiBase, token);
    if (!refreshed) {
      printReauthInstructions();
      process.exit(1);
    }
    token = refreshed.token;
    try {
      await persistToken(config.raw, refreshed);
    } catch (err) {
      // Non-fatal: the retry still uses the in-memory token.
      eprintln(c.yellow(`⚠ could not persist refreshed token: ${err instanceof Error ? err.message : String(err)}`));
    }
    res = await postTicket(config.apiBase, token, payload);
  }

  if (res.status !== 201 && res.status !== 200) {
    eprintln(c.red(`✗ Forge ticket failed: HTTP ${res.status}${res.detail ? ` — ${res.detail}` : ""}`));
    process.exit(1);
  }

  const ticket = res.ticket!;
  println(c.green(`Filed: ${ticket.ticketId}`) + (res.status === 200 ? c.dim(" (duplicate of an existing ticket)") : ""));

  // GitHub sync is async — poll the status endpoint briefly for the issue URL.
  let issueUrl = ticket.issueUrl;
  let failureReason: string | undefined;
  for (let i = 0; !issueUrl && i < SYNC_POLL_ATTEMPTS; i++) {
    await sleep(SYNC_POLL_INTERVAL_MS);
    const status = await getTicketStatus(config.apiBase, token, ticket.ticketId);
    if (!status) continue;
    if (status.issueUrl) issueUrl = status.issueUrl;
    if (status.syncStatus === "failed") {
      failureReason = status.failureReason ?? "sync failed";
      break;
    }
  }
  if (issueUrl) {
    println(`GitHub: ${issueUrl}`);
  } else if (failureReason) {
    println(c.yellow(`GitHub: ${failureReason}`));
  } else {
    println(c.dim("GitHub: sync pending"));
  }
}

// --- report composition ---

function composeReport(checks: DoctorCheck[], attach: { name: string; content: string } | null): string {
  const lines: string[] = [];
  lines.push("## benchagi doctor");
  lines.push("");
  lines.push("| check | status | detail |");
  lines.push("| --- | --- | --- |");
  for (const check of checks) {
    lines.push(`| ${check.name} | ${check.status} | ${markdownTableCell(check.detail)} |`);
  }
  lines.push("");
  lines.push("## Versions");
  lines.push("");
  lines.push(`- cli: benchagi ${CLI_VERSION}`);
  lines.push(`- host: ${hostname()}`);
  lines.push(`- platform: ${process.platform}-${process.arch}`);
  lines.push(`- node: ${process.version}`);
  if (attach) {
    let content = attach.content.trimEnd();
    if (content.length > ATTACH_MAX_BYTES) {
      content = content.slice(0, ATTACH_MAX_BYTES) + `\n\n[truncated at ${ATTACH_MAX_BYTES} bytes]`;
    }
    lines.push("");
    lines.push(`## Runbook (${attach.name})`);
    lines.push("");
    lines.push(content);
  }
  return lines.join("\n") + "\n";
}

export function markdownTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function severityFor(checks: DoctorCheck[]): "sev-2" | "sev-3" | "question" {
  if (checks.some((check) => check.status === "bad")) return "sev-2";
  if (checks.some((check) => check.status === "warn")) return "sev-3";
  return "question"; // all green — an attached runbook is an ask, not an incident
}

function subjectFor(checks: DoctorCheck[]): string {
  const bad = checks.filter((check) => check.status === "bad").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const summary =
    bad > 0 ? `${bad} failing check${bad === 1 ? "" : "s"}`
    : warn > 0 ? `${warn} warning${warn === 1 ? "" : "s"}`
    : "all checks passing";
  return `[doctor] ${hostname()}: ${summary}`;
}

// --- cowork config + token refresh ---

async function loadCoworkConfig(): Promise<CoworkConfig | null> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const apiBase = raw.bench_api_base;
  const token = raw.bench_cowork_token;
  if (typeof apiBase !== "string" || apiBase === "" || typeof token !== "string" || token === "") return null;
  return { raw, apiBase, token };
}

// bench_api_base may or may not already carry the /api/v1 prefix
// (the bench-cowork plugin writes e.g. https://benchagi.com/api/v1).
export function coworkUrl(apiBase: string, path: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base + path : `${base}/api/v1${path}`;
}

async function persistToken(raw: Record<string, unknown>, refreshed: RefreshResponse): Promise<void> {
  const next: Record<string, unknown> = { ...raw, bench_cowork_token: refreshed.token };
  if (typeof refreshed.email === "string") next.bench_user_email = refreshed.email;
  if (typeof refreshed.expiresInSeconds === "number") {
    next.bench_cowork_expires_at = new Date(Date.now() + refreshed.expiresInSeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }
  // Atomic + private: write a 0600 tmp file, then rename over the original.
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, CONFIG_PATH);
}

async function refreshToken(apiBase: string, staleToken: string): Promise<RefreshResponse | null> {
  try {
    const res = await fetch(coworkUrl(apiBase, REFRESH_PATH), {
      method: "POST",
      headers: { Authorization: `Bearer ${staleToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RefreshResponse;
    if (typeof data?.token !== "string" || data.token === "") return null;
    return data;
  } catch {
    return null;
  }
}

// --- forge ticket API ---

async function postTicket(
  apiBase: string,
  token: string,
  payload: unknown,
): Promise<{ status: number; ticket?: TicketResponse; detail?: string }> {
  try {
    const res = await fetch(coworkUrl(apiBase, TICKET_PATH), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 201 || res.status === 200) {
      const ticket = (await res.json()) as TicketResponse;
      return { status: res.status, ticket };
    }
    return { status: res.status, detail: await res.text().then((t) => t.slice(0, 200)).catch(() => undefined) };
  } catch (err) {
    return { status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function getTicketStatus(
  apiBase: string,
  token: string,
  ticketId: string,
): Promise<{ syncStatus?: string; issueUrl?: string; failureReason?: string } | null> {
  try {
    const res = await fetch(`${coworkUrl(apiBase, TICKET_PATH)}?id=${encodeURIComponent(ticketId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { syncStatus?: string; issueUrl?: string; failureReason?: string };
  } catch {
    return null;
  }
}

// --- operator guidance ---

function printLoginInstructions(): void {
  eprintln(c.red(`✗ no cowork credentials at ${CONFIG_PATH}`));
  eprintln("");
  eprintln("To file Forge reports, link this machine to your Bench account:");
  eprintln("  1. In your Bench agent, run /bench-login (bench-cowork plugin)");
  eprintln("     — or visit https://benchagi.com/auth/cowork and follow the prompts.");
  eprintln(`  2. The minted token lands in ${CONFIG_PATH}`);
  eprintln("  3. Re-run: benchagi doctor --report");
}

function printReauthInstructions(): void {
  eprintln(c.red("✗ cowork token expired and refresh was rejected — re-authenticate in the browser"));
  eprintln("");
  eprintln("  1. Visit https://benchagi.com/auth/cowork and sign in");
  eprintln("     (or run /bench-login in your Bench agent).");
  eprintln(`  2. The renewed token lands in ${CONFIG_PATH}`);
  eprintln("  3. Re-run: benchagi doctor --report");
  eprintln("");
  eprintln(c.dim("The composed report above is on stdout — nothing was lost."));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
