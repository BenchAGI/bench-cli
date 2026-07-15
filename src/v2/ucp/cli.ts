import { readFile, stat } from "node:fs/promises";

import { EFFECT_DEFINITIONS, effectDefinition } from "./definitions.js";
import { MacTouchIdVerifier } from "./gatekeeper.js";
import { GrantStore } from "./grants.js";
import { ReceiptStore } from "./receipts.js";
import { renderSessionHealthCard } from "./health.js";
import { EffectRegistry, type EffectExecution } from "./registry.js";
import { UcpDeniedError, type CapabilityMode, type EffectRequest, type GrantRecord, type SessionHealthCard } from "./types.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const PROTECTED_MODES = new Set<GrantRecord["mode"]>([
  "secret-use", "mutate-tenant", "publish-draft", "outbound-draft",
]);

type Flags = {
  values: Map<string, string[]>;
  booleans: Set<string>;
  positional: string[];
};

function parseFlags(args: string[], booleanNames: string[]): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  const booleanSet = new Set(booleanNames);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals >= 0 ? equals : undefined);
    if (booleanSet.has(name)) {
      if (equals >= 0) throw new UcpDeniedError("UCP_USAGE", `--${name} does not accept a value`);
      booleans.add(name);
      continue;
    }
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
    if (!value || value.startsWith("--")) throw new UcpDeniedError("UCP_USAGE", `--${name} requires a value`);
    values.set(name, [...(values.get(name) || []), value]);
  }
  return { values, booleans, positional };
}

function one(flags: Flags, name: string, required = false): string | undefined {
  const values = flags.values.get(name) || [];
  if (values.length > 1) throw new UcpDeniedError("UCP_USAGE", `--${name} may be supplied once`);
  if (required && values.length === 0) throw new UcpDeniedError("UCP_USAGE", `--${name} is required`);
  return values[0];
}

async function readJsonRequest(path: string): Promise<Record<string, unknown>> {
  let raw = "";
  if (path === "-") {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new UcpDeniedError("UCP_REQUEST_TOO_LARGE", "Effect request exceeds 256 KiB");
    }
  } else {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_REQUEST_BYTES) throw new UcpDeniedError("UCP_REQUEST_FILE_INVALID", "Effect request must be a bounded regular JSON file");
    raw = await readFile(path, "utf8");
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new UcpDeniedError("UCP_REQUEST_INVALID", "Effect request file is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UcpDeniedError("UCP_REQUEST_INVALID", "Effect request must be a JSON object");
  return value as Record<string, unknown>;
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printExecution(execution: EffectExecution): void {
  process.stdout.write(`${execution.receipt.status}: ${execution.receipt.summary}\n`);
  for (const [key, value] of Object.entries(execution.receipt.details)) process.stdout.write(`  ${key}: ${String(value)}\n`);
  if (execution.result.output !== undefined) process.stdout.write(`${JSON.stringify(execution.result.output, null, 2)}\n`);
  process.stdout.write(`  receipt: ${execution.receipt.receiptId}\n`);
  if (execution.receiptPath) process.stdout.write(`  path: ${execution.receiptPath}\n`);
}

function isFailure(execution: EffectExecution): boolean {
  return ["denied", "missing_config", "failed"].includes(execution.receipt.status);
}

async function runEffect(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const flags = parseFlags(args, ["dry-run", "execute", "json"]);
  const effectId = flags.positional[0];
  if (!effectId || flags.positional.length !== 1) throw new UcpDeniedError("UCP_USAGE", "usage: excalibur effect <id> --request <file|-> [--dry-run|--execute] [--grant <id>]");
  if (!effectDefinition(effectId)) throw new UcpDeniedError("UCP_EFFECT_UNKNOWN", "Unknown UCP effect ID");
  const input = await readJsonRequest(one(flags, "request", true)!);
  const request: EffectRequest = {
    effectId,
    input,
    dryRun: flags.booleans.has("dry-run"),
    execute: flags.booleans.has("execute"),
    grantIds: flags.values.get("grant") || [],
  };
  const execution = await new EffectRegistry({ env }).execute(request);
  if (flags.booleans.has("json")) json({ result: execution.result, receipt: execution.receipt, receiptPath: execution.receiptPath });
  else printExecution(execution);
  if (isFailure(execution)) process.exitCode = 1;
}

async function runHealth(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const flags = parseFlags(args, ["json"]);
  if (flags.positional.length || flags.values.size) throw new UcpDeniedError("UCP_USAGE", "usage: excalibur health [--json]");
  const execution = await new EffectRegistry({ env }).execute({ effectId: "session.health_card", input: {} });
  const card = execution.result.output as SessionHealthCard | undefined;
  if (flags.booleans.has("json")) json({ card, receipt: execution.receipt });
  else {
    if (card) for (const line of renderSessionHealthCard(card)) process.stdout.write(`${line}\n`);
    process.stdout.write(`  receipt: ${execution.receipt.receiptId}\n`);
  }
  if (isFailure(execution)) process.exitCode = 1;
}

async function runEffects(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["json"]);
  if (flags.positional.length || flags.values.size) throw new UcpDeniedError("UCP_USAGE", "usage: excalibur effects [--json]");
  if (flags.booleans.has("json")) return json(EFFECT_DEFINITIONS);
  process.stdout.write("UCP effect registry\n");
  for (const effect of EFFECT_DEFINITIONS) {
    process.stdout.write(`  ${effect.id.padEnd(30)} ${effect.availability.padEnd(13)} ${effect.requiredModes.join(",")}\n`);
  }
}

async function runGrant(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const subcommand = args[0];
  const store = new GrantStore(env);
  if (subcommand === "issue") {
    const flags = parseFlags(args.slice(1), ["mission-secret-bundle", "json"]);
    if (flags.positional.length) throw new UcpDeniedError("UCP_USAGE", "Unexpected positional grant arguments");
    const mode = one(flags, "mode", true) as GrantRecord["mode"];
    if (!PROTECTED_MODES.has(mode)) throw new UcpDeniedError("UCP_GRANT_MODE_INVALID", "Invalid protected grant mode");
    const effectIds = flags.values.get("effect") || [];
    for (const effectId of effectIds) {
      const effect = effectDefinition(effectId);
      if (!effect || !effect.requiredModes.includes(mode as CapabilityMode)) {
        throw new UcpDeniedError("UCP_GRANT_EFFECT_INVALID", `${effectId} does not declare the ${mode} capability`);
      }
    }
    const ttlSeconds = Number(one(flags, "ttl", true));
    const purpose = one(flags, "purpose", true)!;
    const requestDigest = one(flags, "request-digest", true)!;
    const sourceReceiptId = one(flags, "receipt", true)!;
    if (flags.booleans.has("mission-secret-bundle")) {
      throw new UcpDeniedError(
        "UCP_MISSION_BUNDLE_UNAVAILABLE",
        "Durable mission bundles are disabled until a tamper-resistant broker is available; each secret use requires fresh Touch ID",
      );
    }
    const sourceReceipt = (await new ReceiptStore(env).list(500)).find((receipt) => receipt.receiptId === sourceReceiptId);
    const sourceAge = sourceReceipt ? Date.now() - Date.parse(sourceReceipt.completedAt) : Number.POSITIVE_INFINITY;
    if (!sourceReceipt || sourceReceipt.status !== "dry_run"
        || sourceReceipt.dryRun !== true
        || sourceReceipt.requestDigest !== requestDigest
        || !effectIds.includes(sourceReceipt.effectId)
        || !Number.isFinite(sourceAge) || sourceAge < 0 || sourceAge > 15 * 60 * 1_000) {
      throw new UcpDeniedError(
        "UCP_GRANT_RECEIPT_INVALID",
        "Grant requires a matching successful dry-run receipt from the last fifteen minutes",
      );
    }
    await new MacTouchIdVerifier().verify(`Issue ${mode} grant for ${effectIds.join(", ")}`);
    const grant = await store.issue({
      mode,
      effectIds,
      requestDigest,
      sourceReceiptId,
      ttlSeconds,
      missionSecretBundle: false,
      purpose,
    });
    if (flags.booleans.has("json")) json(grant);
    else process.stdout.write(`issued ${grant.grantId} · ${grant.mode} · expires ${grant.expiresAt}\n`);
    return;
  }
  if (subcommand === "revoke") {
    const id = args[1];
    if (!id || args.length !== 2) throw new UcpDeniedError("UCP_USAGE", "usage: excalibur grant revoke <id>");
    await store.revoke(id);
    process.stdout.write(`revoked ${id}\n`);
    return;
  }
  throw new UcpDeniedError("UCP_USAGE", "usage: excalibur grant <issue|revoke>");
}

async function runGrants(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const flags = parseFlags(args, ["json"]);
  if (flags.positional.length || flags.values.size) throw new UcpDeniedError("UCP_USAGE", "usage: excalibur grants [--json]");
  const grants = await new GrantStore(env).getOpen();
  if (flags.booleans.has("json")) return json(grants);
  process.stdout.write("Open UCP grants\n");
  if (!grants.length) process.stdout.write("  none\n");
  for (const grant of grants) process.stdout.write(`  ${grant.grantId}  ${grant.mode}  expires ${grant.expiresAt}  ${grant.effectIds.join(",")}\n`);
}

export async function runUcpCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    switch (command) {
      case "health": return await runHealth(args, env);
      case "effects": return await runEffects(args);
      case "effect": return await runEffect(args, env);
      case "grant": return await runGrant(args, env);
      case "grants": return await runGrants(args, env);
      default: throw new UcpDeniedError("UCP_USAGE", "Unknown UCP command");
    }
  } catch (error) {
    const safe = error instanceof UcpDeniedError ? `${error.code}: ${error.message}` : "UCP_COMMAND_FAILED: command failed without exposing raw error";
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  }
}
