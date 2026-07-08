// Internal BenchAGI local-seat bridge.
//
// Local Claude Code and Codex CLI hooks call:
//   benchagi seat-bridge capture --event user_prompt
//
// The command is intentionally best-effort and quiet. Hook failures must never
// break the user's local AI session.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { CLI_VERSION } from "./version.js";
import { resolveGatewayPassword, resolveGatewayToken } from "../auth/gateway-token.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { LocalGatewayWsTransport } from "../transport/local-gateway.js";
import {
  backfillSeatMemory,
  detectSeatMemoryWrite,
  drainSeatMemoryQueue,
  enqueueMemoryFile,
  resolveClaudeMemoryDir,
  resolveOpenclawBin,
  scanAndEnqueue,
  type SeatMemoryContext,
} from "./seat-memory-queue.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const MAX_STDIN_BYTES = 64_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_EVENT_TEXT_CHARS = 700;

export type SeatKind = "claude-code" | "codex-cli";
export type SeatEvent =
  | "session_start"
  | "user_prompt"
  | "assistant_response"
  | "tool_result"
  | "summary"
  | "session_stop";

export type SeatCapture = {
  agentId: string;
  seatKind: SeatKind;
  seatSessionId: string;
  event: SeatEvent;
  summary?: string;
  text?: string;
  cwd?: string;
  host?: string;
  platform?: string;
  launcherVersion?: string;
  providerVersion?: string;
  source?: string;
  ts: string;
  wake?: boolean;
};

type CaptureCliArgs = {
  event: SeatEvent;
  gatewayUrl?: string;
  wake?: boolean;
};

function debug(line: string): void {
  if (process.env.BENCHAGI_SEAT_BRIDGE_DEBUG === "1") {
    process.stderr.write(`[benchagi seat-bridge] ${line}\n`);
  }
}

function clip(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function normalizeSeatKind(value: unknown): SeatKind {
  return value === "codex-cli" ? "codex-cli" : "claude-code";
}

export function normalizeSeatEvent(value: unknown): SeatEvent {
  switch (value) {
    case "session_start":
    case "user_prompt":
    case "assistant_response":
    case "tool_result":
    case "summary":
    case "session_stop":
      return value;
    default:
      return "summary";
  }
}

export function defaultWakeForEvent(event: SeatEvent): boolean {
  return event === "session_start" || event === "user_prompt" || event === "summary" || event === "session_stop";
}

export function resolveSeatGatewayUrl(explicit?: string | null): string {
  return (
    explicit?.trim() ||
    process.env.BENCHAGI_SEAT_GATEWAY_URL?.trim() ||
    process.env.BENCHAGI_DIRECT_GATEWAY_URL?.trim() ||
    process.env.BENCHAGI_GATEWAY_URL?.trim() ||
    process.env.OPENCLAW_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function readHookValue(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const nested = record.data ?? record.payload;
  if (nested && typeof nested === "object" && nested !== payload) {
    return readHookValue(nested, keys);
  }
  return undefined;
}

function parseHookPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

// A desktop (non-spawn) launch has no launcher-minted BENCHAGI_SEAT_SESSION_ID,
// but Claude Code sends its own session_id in every hook payload — use it so a
// window's events land in one seat session instead of scattering one per hook.
// No cached fallback on purpose: a workspace-level cache can't tell concurrent
// windows apart, so per-invocation minting stays the honest last resort.
export function hookSessionId(rawHookPayload?: string): string | undefined {
  if (!rawHookPayload) return undefined;
  return readHookValue(parseHookPayload(rawHookPayload), ["session_id", "sessionId"]);
}

export function extractHookCaptureText(raw: string, event: SeatEvent): {
  summary?: string;
  text?: string;
} {
  const payload = parseHookPayload(raw);
  if (typeof payload === "string") {
    return { text: clip(payload, MAX_TEXT_CHARS), summary: clip(payload, MAX_SUMMARY_CHARS) };
  }
  const prompt = readHookValue(payload, [
    "prompt",
    "message",
    "input",
    "text",
    "user_prompt",
    "userPrompt",
  ]);
  if (prompt) {
    return {
      text: clip(prompt, MAX_TEXT_CHARS),
      summary: clip(prompt, MAX_SUMMARY_CHARS),
    };
  }
  const toolName = readHookValue(payload, ["tool_name", "toolName", "name"]);
  const status = readHookValue(payload, ["status", "result", "outcome"]);
  if (toolName || status) {
    return { summary: clip([event, toolName, status].filter(Boolean).join(" "), MAX_SUMMARY_CHARS) };
  }
  return { summary: event };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    chunks.push(buffer);
    if (total >= MAX_STDIN_BYTES) break;
  }
  return Buffer.concat(chunks, Math.min(total, MAX_STDIN_BYTES)).toString("utf8");
}

function parseCaptureArgs(args: string[]): CaptureCliArgs | null {
  if (args[0] !== "capture") return null;
  const parsed: CaptureCliArgs = { event: "summary" };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--event") {
      parsed.event = normalizeSeatEvent(args[++i]);
      continue;
    }
    if (arg.startsWith("--event=")) {
      parsed.event = normalizeSeatEvent(arg.slice("--event=".length));
      continue;
    }
    if (arg === "--gateway") {
      parsed.gatewayUrl = args[++i];
      continue;
    }
    if (arg.startsWith("--gateway=")) {
      parsed.gatewayUrl = arg.slice("--gateway=".length);
      continue;
    }
    if (arg === "--wake") {
      parsed.wake = true;
      continue;
    }
    if (arg === "--no-wake") {
      parsed.wake = false;
      continue;
    }
  }
  return parsed;
}

export function buildSeatCaptureFromEnv(args: {
  event: SeatEvent;
  rawHookPayload?: string;
  wake?: boolean;
}): SeatCapture {
  const extracted = extractHookCaptureText(args.rawHookPayload ?? "", args.event);
  const agentId =
    process.env.BENCHAGI_SEAT_AGENT_ID?.trim() ||
    process.env.BENCH_AGENT_ID?.trim() ||
    "main";
  const seatSessionId =
    process.env.BENCHAGI_SEAT_SESSION_ID?.trim() ||
    hookSessionId(args.rawHookPayload) ||
    randomUUID();
  return {
    agentId,
    seatKind: normalizeSeatKind(process.env.BENCHAGI_SEAT_KIND),
    seatSessionId,
    event: args.event,
    summary: extracted.summary,
    text: extracted.text,
    cwd: process.env.BENCHAGI_SEAT_CWD || process.cwd(),
    host: hostname(),
    platform: `${process.platform}-${process.arch}`,
    launcherVersion: CLI_VERSION,
    providerVersion: process.env.BENCHAGI_SEAT_PROVIDER_VERSION,
    source: "benchagi-seat-bridge",
    ts: new Date().toISOString(),
    wake: args.wake ?? defaultWakeForEvent(args.event),
  };
}

function localEventsDir(): string {
  return (
    process.env.BENCHAGI_SEAT_EVENTS_DIR?.trim() ||
    join(homedir(), ".config", "benchagi", "seat-events")
  );
}

export async function appendLocalSeatCapture(capture: SeatCapture): Promise<string> {
  const dir = join(localEventsDir(), safeSegment(capture.agentId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${safeSegment(capture.seatSessionId)}.jsonl`);
  await appendFile(file, `${JSON.stringify({ schemaVersion: 1, ...capture })}\n`, {
    mode: 0o600,
  });
  return file;
}

function labelForSeatKind(kind: SeatKind): string {
  return kind === "codex-cli" ? "Codex CLI" : "Claude Code";
}

export function buildSeatSystemEventText(capture: SeatCapture): string {
  const subject = clip(capture.summary ?? capture.text ?? "", MAX_EVENT_TEXT_CHARS);
  return [
    `Local ${labelForSeatKind(capture.seatKind)} seat capture`,
    `agent=${capture.agentId}`,
    `event=${capture.event}`,
    subject ? `summary=${subject}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function postSeatCaptureToGateway(
  capture: SeatCapture,
  gatewayUrl: string,
): Promise<boolean> {
  const transport = new LocalGatewayWsTransport({ url: gatewayUrl });
  if (!(await transport.isReachable())) return false;
  await transport.connect({
    url: gatewayUrl,
    token: await resolveGatewayToken(),
    password: await resolveGatewayPassword(),
    protocolVersion: PROTOCOL_VERSION,
  });
  try {
    const methods = transport.features()?.methods ?? [];
    if (methods.includes("local-seat.capture")) {
      await transport.request("local-seat.capture", capture);
      return true;
    }
    if (capture.wake !== false && methods.includes("system-event")) {
      await transport.request("system-event", {
        text: buildSeatSystemEventText(capture),
        host: capture.host,
        platform: capture.platform,
        mode: capture.seatKind,
        version: capture.launcherVersion,
        tags: ["benchagi", "local-seat", capture.seatKind, capture.event],
      });
      return true;
    }
    return false;
  } finally {
    await transport.close();
  }
}

export async function persistAndPostSeatCapture(
  capture: SeatCapture,
  opts: { gatewayUrl?: string } = {},
): Promise<{ localPath: string; posted: boolean }> {
  const localPath = await appendLocalSeatCapture(capture);
  let posted = false;
  try {
    posted = await postSeatCaptureToGateway(capture, resolveSeatGatewayUrl(opts.gatewayUrl));
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
  }
  return { localPath, posted };
}

function seatMemoryContextFromEnv(rawHookPayload?: string): SeatMemoryContext {
  const agentId =
    process.env.BENCHAGI_SEAT_AGENT_ID?.trim() || process.env.BENCH_AGENT_ID?.trim() || "main";
  return {
    agentId,
    seatKind: process.env.BENCHAGI_SEAT_KIND?.trim() || undefined,
    seatSessionId: process.env.BENCHAGI_SEAT_SESSION_ID?.trim() || hookSessionId(rawHookPayload),
  };
}

function parseAgentFlag(args: string[]): { agent?: string } {
  const out: { agent?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--agent") {
      out.agent = args[++i];
      continue;
    }
    if (arg.startsWith("--agent=")) {
      out.agent = arg.slice("--agent=".length);
    }
  }
  return out;
}

function parseStringFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === name) return args[++i];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

// Best-effort memory promotion tied to the seat lifecycle. Never throws: a hook
// failure must never break the user's local AI session. Durability lives in the
// queue + retry, not in any single hook's timeout budget.
function handleSeatMemoryForEvent(event: SeatEvent, rawHookPayload: string): void {
  try {
    const ctx = seatMemoryContextFromEnv(rawHookPayload);
    if (event === "tool_result") {
      const hit = detectSeatMemoryWrite(rawHookPayload);
      if (hit) {
        enqueueMemoryFile(ctx, hit.filePath);
      }
      return;
    }
    if (event === "session_stop" || event === "session_start") {
      const memoryDir = resolveClaudeMemoryDir({
        rawHookPayload,
        cwd: process.env.BENCHAGI_SEAT_CWD,
      });
      if (memoryDir) {
        scanAndEnqueue(ctx, memoryDir);
      }
      drainSeatMemoryQueue({ agentId: ctx.agentId, seatKind: ctx.seatKind, force: false });
    }
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
  }
}

async function runSeatBridgePromote(args: string[], agentOverride?: string): Promise<void> {
  try {
    const ctx = seatMemoryContextFromEnv();
    const agentId = parseAgentFlag(args).agent?.trim() || agentOverride?.trim() || ctx.agentId;
    const result = drainSeatMemoryQueue({
      agentId,
      seatKind: ctx.seatKind,
      force: false,
      timeoutMs: 60_000,
    });
    process.stdout.write(`${JSON.stringify({ command: "seat-bridge promote", agent: agentId, ...result })}\n`);
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
  }
}

async function runSeatBridgeBackfill(args: string[], agentOverride?: string): Promise<void> {
  const ctx = seatMemoryContextFromEnv();
  const agentId = parseAgentFlag(args).agent?.trim() || agentOverride?.trim() || ctx.agentId;
  const result = backfillSeatMemory({
    agentId,
    seatKind: ctx.seatKind,
    cwd: process.env.BENCHAGI_SEAT_CWD,
    memoryDir: parseStringFlag(args, "--from-dir"),
  });
  const statuses: Record<string, number> = {};
  for (const entry of result.results) {
    const key = entry.status ?? "unknown";
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        command: "seat-bridge backfill",
        agent: agentId,
        ok: result.ok,
        memoryDir: result.memoryDir,
        error: result.error,
        statuses,
      },
      null,
      2,
    )}\n`,
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function seatPromoterPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "ai.openclaw.seat-memory-promoter.plist");
}

function buildSeatPromoterPlist(params: {
  agentId: string;
  nodeBin: string;
  benchagiBin: string;
  openclawBin?: string;
  seatCwd?: string;
  logPath: string;
}): string {
  const envPairs: Array<[string, string]> = [
    ["PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
    ["BENCHAGI_SEAT_AGENT_ID", params.agentId],
  ];
  if (params.openclawBin) envPairs.push(["BENCHAGI_OPENCLAW_BIN", params.openclawBin]);
  if (params.seatCwd) envPairs.push(["BENCHAGI_SEAT_CWD", params.seatCwd]);
  const envXml = envPairs
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");
  const argsXml = [params.nodeBin, params.benchagiBin, "seat-bridge", "promote", "--agent", params.agentId]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.seat-memory-promoter</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(params.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(params.logPath)}</string>
</dict>
</plist>
`;
}

// Install a launchd backstop that drains the seat-memory queue on an interval,
// so promotion still happens if a seat crashes before any session_start drain.
// PATH-controlled (set in the plist) so `openclaw` resolves outside a TTY shell.
async function runSeatBridgeInstallPromoter(args: string[], agentOverride?: string): Promise<void> {
  if (process.platform !== "darwin") {
    process.stdout.write("seat-memory-promoter: launchd install is macOS-only; skipped.\n");
    return;
  }
  const ctx = seatMemoryContextFromEnv();
  const agentId = parseAgentFlag(args).agent?.trim() || agentOverride?.trim() || ctx.agentId;
  const benchagiBin = process.env.BENCHAGI_BIN || process.argv[1] || "benchagi";
  const logPath = join(homedir(), ".config", "benchagi", "seat-memory-promoter.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const plistFile = seatPromoterPlistPath();
  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(
    plistFile,
    buildSeatPromoterPlist({
      agentId,
      nodeBin: process.execPath,
      benchagiBin,
      openclawBin: resolveOpenclawBin() ?? undefined,
      seatCwd: process.env.BENCHAGI_SEAT_CWD,
      logPath,
    }),
    { mode: 0o644 },
  );
  spawnSync("launchctl", ["unload", plistFile], { stdio: "ignore" });
  const load = spawnSync("launchctl", ["load", plistFile], { encoding: "utf8" });
  process.stdout.write(
    `${JSON.stringify({
      command: "seat-bridge install-promoter",
      agent: agentId,
      plist: plistFile,
      loaded: load.status === 0,
      openclawResolved: Boolean(resolveOpenclawBin()),
    })}\n`,
  );
}

export async function commandSeatBridge(args: string[], agentOverride?: string): Promise<void> {
  const sub = args[0];
  if (sub === "promote") {
    await runSeatBridgePromote(args.slice(1), agentOverride);
    return;
  }
  if (sub === "backfill") {
    await runSeatBridgeBackfill(args.slice(1), agentOverride);
    return;
  }
  if (sub === "install-promoter") {
    await runSeatBridgeInstallPromoter(args.slice(1), agentOverride);
    return;
  }
  const parsed = parseCaptureArgs(args);
  if (!parsed) {
    debug(
      "usage: benchagi seat-bridge <capture --event <event> | promote | backfill [--from-dir <dir>] | install-promoter>",
    );
    return;
  }
  try {
    const rawHookPayload = await readStdin();
    const capture = buildSeatCaptureFromEnv({
      event: parsed.event,
      rawHookPayload,
      wake: parsed.wake,
    });
    await persistAndPostSeatCapture(capture, { gatewayUrl: parsed.gatewayUrl });
    handleSeatMemoryForEvent(parsed.event, rawHookPayload);
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
  }
}
