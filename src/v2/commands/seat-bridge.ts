// Internal BenchAGI local-seat bridge.
//
// Local Claude Code and Codex CLI hooks call:
//   benchagi seat-bridge capture --event user_prompt
//
// The command is intentionally best-effort and quiet. Hook failures must never
// break the user's local AI session.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "./version.js";
import { resolveGatewayPassword, resolveGatewayToken } from "../auth/gateway-token.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { LocalGatewayWsTransport } from "../transport/local-gateway.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const MAX_STDIN_BYTES = 64_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;

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
  ts: number;
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
  return event === "user_prompt" || event === "summary";
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
  const seatSessionId = process.env.BENCHAGI_SEAT_SESSION_ID?.trim() || randomUUID();
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
    ts: Date.now(),
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
    if (!methods.includes("local-seat.capture")) return false;
    await transport.request("local-seat.capture", capture);
    return true;
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

export async function commandSeatBridge(args: string[]): Promise<void> {
  const parsed = parseCaptureArgs(args);
  if (!parsed) {
    debug("usage: benchagi seat-bridge capture --event <event>");
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
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
  }
}
