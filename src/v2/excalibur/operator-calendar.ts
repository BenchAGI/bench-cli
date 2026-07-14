import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const OPERATOR_CALENDAR_SCHEMA_VERSION = "excalibur.operator-calendar.v1";
const MAX_CONFIG_BYTES = 16 * 1024;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,253}$/;
const CALENDAR_ID_RE = /^[^\u0000-\u0020\u007f]{1,512}$/;

export type OperatorCalendarConfig = {
  schemaVersion: typeof OPERATOR_CALENDAR_SCHEMA_VERSION;
  enabled: boolean;
  provider: "gog";
  account: string;
  calendarId: string;
  timezone: string;
  lookaheadDays: number;
};

export type OperatorCalendarReadResult = {
  path: string;
  state: "missing" | "configured";
  config: OperatorCalendarConfig | null;
  mode: number | null;
};

export class OperatorCalendarConfigError extends Error {
  readonly exitCode: number;

  constructor(message: string, options: ErrorOptions = {}, exitCode = 13) {
    super(message, options);
    this.name = "OperatorCalendarConfigError";
    this.exitCode = exitCode;
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new OperatorCalendarConfigError(`${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new OperatorCalendarConfigError(`${label} is malformed`);
  }
  return text;
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseOperatorCalendarConfig(value: unknown): OperatorCalendarConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorCalendarConfigError("operator calendar configuration must be an object");
  }
  const raw = value as Record<string, unknown>;
  const expected = [
    "schemaVersion", "enabled", "provider", "account", "calendarId", "timezone", "lookaheadDays",
  ].sort();
  const actual = Object.keys(raw).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OperatorCalendarConfigError("operator calendar configuration has unexpected fields");
  }
  if (raw.schemaVersion !== OPERATOR_CALENDAR_SCHEMA_VERSION || raw.provider !== "gog"
      || typeof raw.enabled !== "boolean") {
    throw new OperatorCalendarConfigError("operator calendar configuration has an unsupported schema or provider");
  }
  const account = boundedText(raw.account, "calendar account", 254);
  const calendarId = boundedText(raw.calendarId, "calendar id", 512);
  const timezone = boundedText(raw.timezone, "calendar timezone", 128);
  if (!ACCOUNT_RE.test(account)) throw new OperatorCalendarConfigError("calendar account is malformed");
  if (!CALENDAR_ID_RE.test(calendarId)) throw new OperatorCalendarConfigError("calendar id is malformed");
  if (!validTimezone(timezone)) throw new OperatorCalendarConfigError("calendar timezone must be a valid IANA timezone");
  if (!Number.isSafeInteger(raw.lookaheadDays) || Number(raw.lookaheadDays) < 1 || Number(raw.lookaheadDays) > 7) {
    throw new OperatorCalendarConfigError("calendar lookahead days must be between 1 and 7");
  }
  return {
    schemaVersion: OPERATOR_CALENDAR_SCHEMA_VERSION,
    enabled: raw.enabled,
    provider: "gog",
    account,
    calendarId,
    timezone,
    lookaheadDays: Number(raw.lookaheadDays),
  };
}

export function operatorCalendarConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EXCALIBUR_OPERATOR_CALENDAR_CONFIG?.trim();
  if (configured) return resolve(configured);
  return join(env.HOME || homedir(), ".config", "excalibur", "v1", "operator-calendar.json");
}

function stableIdentity(info: Stats): string {
  return [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

export async function readOperatorCalendarConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorCalendarReadResult> {
  const path = operatorCalendarConfigPath(env);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_CONFIG_BYTES
        || (uid !== null && before.uid !== uid) || (before.mode & 0o777) !== 0o600) {
      throw new OperatorCalendarConfigError("operator calendar configuration must be an owner-only 0600 regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (stableIdentity(before) !== stableIdentity(after) || bytes.length !== before.size) {
      throw new OperatorCalendarConfigError("operator calendar configuration changed while it was being read");
    }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (error) { throw new OperatorCalendarConfigError("operator calendar configuration is not valid UTF-8 JSON", { cause: error }); }
    return { path, state: "configured", config: parseOperatorCalendarConfig(raw), mode: before.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { path, state: "missing", config: null, mode: null };
    }
    if (error instanceof OperatorCalendarConfigError) throw error;
    throw new OperatorCalendarConfigError("operator calendar configuration could not be read safely", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid)) {
    throw new OperatorCalendarConfigError("operator calendar configuration directory is unsafe");
  }
  await chmod(path, 0o700);
}

export async function writeOperatorCalendarConfig(
  value: OperatorCalendarConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorCalendarReadResult> {
  const config = parseOperatorCalendarConfig(value);
  const path = operatorCalendarConfigPath(env);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = join(directory, `.operator-calendar.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return await readOperatorCalendarConfig(env);
}

function takeOption(args: string[], name: string): string | null {
  const index = args.findIndex((item) => item === name || item.startsWith(`${name}=`));
  if (index < 0) return null;
  const token = args[index]!;
  if (token === name) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new OperatorCalendarConfigError(`${name} requires a value`);
    args.splice(index, 2);
    return value;
  }
  args.splice(index, 1);
  return token.slice(name.length + 1);
}

export function parseOperatorCalendarConfigureArgs(input: string[]): OperatorCalendarConfig {
  const args = [...input];
  const consentIndex = args.indexOf("--consent-operator-summary");
  const consent = consentIndex >= 0;
  if (consent) args.splice(consentIndex, 1);
  const account = takeOption(args, "--account");
  const calendarId = takeOption(args, "--calendar-id");
  const timezone = takeOption(args, "--timezone");
  const lookaheadRaw = takeOption(args, "--lookahead-days") || "4";
  if (args.length) throw new OperatorCalendarConfigError(`unknown calendar option: ${args[0]}`);
  if (!account || !calendarId || !timezone || !consent) {
    throw new OperatorCalendarConfigError(
      "usage: excalibur calendar configure --account <gog-account> --calendar-id <id> --timezone <IANA> [--lookahead-days <1-7>] --consent-operator-summary",
      {},
      2,
    );
  }
  if (!/^[1-9]\d*$/.test(lookaheadRaw)) {
    throw new OperatorCalendarConfigError("calendar lookahead days must be an integer between 1 and 7");
  }
  return parseOperatorCalendarConfig({
    schemaVersion: OPERATOR_CALENDAR_SCHEMA_VERSION,
    enabled: true,
    provider: "gog",
    account,
    calendarId,
    timezone,
    lookaheadDays: Number(lookaheadRaw),
  });
}

export async function disableOperatorCalendar(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorCalendarReadResult> {
  const current = await readOperatorCalendarConfig(env);
  if (!current.config) return current;
  return await writeOperatorCalendarConfig({ ...current.config, enabled: false }, env);
}

export function renderOperatorCalendarStatus(result: OperatorCalendarReadResult): string[] {
  if (!result.config) {
    return [
      "Operator calendar · not configured",
      `  file: ${result.path}`,
      "  explicit consent is required before the sidecar may project event summaries into the operator thread",
    ];
  }
  return [
    `Operator calendar · ${result.config.enabled ? "enabled" : "disabled"}`,
    "  provider: gog · account: configured (hidden) · calendar: configured (hidden)",
    `  timezone: ${result.config.timezone} · lookahead: ${result.config.lookaheadDays} day(s)`,
    `  file: ${result.path} · mode: ${(result.mode ?? 0).toString(8).padStart(4, "0")}`,
    "  consent scope: event summaries may enter only the operator-thread schedules observation; the CLI never calls gog",
  ];
}
