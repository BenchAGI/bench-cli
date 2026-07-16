import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveStateScope, scopeDirectory, type StateScope } from "../state/scope.js";

export type ExcaliburSessionRecord = {
  sessionId: string;
  provider: "excalibur-sidecar" | "grok-acp" | "cloud-read-only";
  nativeSessionId: string;
  model: string;
  contextId: string;
  startedAt: string;
  updatedAt: string;
  status: "open" | "closed" | "error";
};

export type ExcaliburReceipt = {
  receiptId: string;
  kind: "preflight" | "session-open" | "session-close" | "fallback";
  status: "ready" | "blocked" | "degraded" | "closed";
  at: string;
  sessionId?: string;
  provider?: string;
  detail?: string;
};

export type ExcaliburState = {
  version: 1;
  scope: {
    principalHash: string;
    instanceId: string;
  };
  selectedContext: string;
  sessions: ExcaliburSessionRecord[];
  receipts: ExcaliburReceipt[];
  legacyPreferences?: unknown;
  migration?: {
    source: string;
    migratedAt: string;
  };
};

export type ScopedStateOptions = {
  scope?: StateScope;
  env?: NodeJS.ProcessEnv;
  legacyStatePath?: string;
};

const updateQueues = new Map<string, Promise<void>>();

export function scopedStatePath(scope: StateScope, env: NodeJS.ProcessEnv = process.env): string {
  return join(scopeDirectory(scope, env), "state.json");
}

function initialState(scope: StateScope): ExcaliburState {
  return {
    version: 1,
    scope: { principalHash: scope.principalHash, instanceId: scope.instanceId },
    selectedContext: "operator-local",
    sessions: [],
    receipts: [],
  };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  return text;
}

function normalizeSessions(value: unknown): ExcaliburSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const sessions: ExcaliburSessionRecord[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const provider = raw.provider === "excalibur-sidecar" || raw.provider === "grok-acp" || raw.provider === "cloud-read-only"
      ? raw.provider
      : null;
    const sessionId = boundedText(raw.sessionId, 128);
    const nativeSessionId = boundedText(raw.nativeSessionId, 256);
    const model = boundedText(raw.model, 128);
    const contextId = boundedText(raw.contextId, 128);
    const startedAt = boundedText(raw.startedAt, 64);
    const updatedAt = boundedText(raw.updatedAt, 64);
    const status = raw.status === "open" || raw.status === "closed" || raw.status === "error" ? raw.status : null;
    if (!provider || !sessionId || !nativeSessionId || !model || !contextId || !startedAt || !updatedAt || !status) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) continue;
    if ((provider === "grok-acp" || provider === "excalibur-sidecar")
        && !/^[a-zA-Z0-9_-]+$/.test(nativeSessionId)) continue;
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(updatedAt))) continue;
    sessions.push({ sessionId, provider, nativeSessionId, model, contextId, startedAt, updatedAt, status });
  }
  return sessions;
}

function normalizeReceipts(value: unknown): ExcaliburReceipt[] {
  if (!Array.isArray(value)) return [];
  const receipts: ExcaliburReceipt[] = [];
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const receiptId = boundedText(raw.receiptId, 128);
    const kind = raw.kind === "preflight" || raw.kind === "session-open" || raw.kind === "session-close" || raw.kind === "fallback"
      ? raw.kind
      : null;
    const status = raw.status === "ready" || raw.status === "blocked" || raw.status === "degraded" || raw.status === "closed"
      ? raw.status
      : null;
    const at = boundedText(raw.at, 64);
    if (!receiptId || !kind || !status || !at || !Number.isFinite(Date.parse(at))) continue;
    receipts.push({
      receiptId,
      kind,
      status,
      at,
      sessionId: boundedText(raw.sessionId, 128) || undefined,
      provider: boundedText(raw.provider, 64) || undefined,
      detail: boundedText(raw.detail, 1_000) || undefined,
    });
  }
  return receipts;
}

function normalizeState(value: unknown, scope: StateScope): ExcaliburState {
  const raw = value && typeof value === "object" ? value as Partial<ExcaliburState> : {};
  return {
    version: 1,
    scope: { principalHash: scope.principalHash, instanceId: scope.instanceId },
    selectedContext: typeof raw.selectedContext === "string" && raw.selectedContext.trim()
      ? raw.selectedContext
      : "operator-local",
    sessions: normalizeSessions(raw.sessions),
    receipts: normalizeReceipts(raw.receipts),
    legacyPreferences: raw.legacyPreferences,
    migration: raw.migration,
  };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveInputs(opts: ScopedStateOptions): Promise<{
  scope: StateScope;
  env: NodeJS.ProcessEnv;
  path: string;
  legacyStatePath: string;
}> {
  const env = opts.env ?? process.env;
  const scope = opts.scope ?? await resolveStateScope({ env });
  return {
    scope,
    env,
    path: scopedStatePath(scope, env),
    legacyStatePath: opts.legacyStatePath || join(
      env.HOME || process.env.HOME || "",
      ".config",
      "benchagi",
      "state.json",
    ),
  };
}

export async function loadExcaliburState(opts: ScopedStateOptions = {}): Promise<ExcaliburState> {
  const input = await resolveInputs(opts);
  const current = await readJson(input.path);
  if (current) return normalizeState(current, input.scope);

  const next = initialState(input.scope);
  const legacy = await readJson(input.legacyStatePath);
  if (legacy) {
    next.legacyPreferences = legacy;
    next.migration = { source: input.legacyStatePath, migratedAt: new Date().toISOString() };
  }
  await atomicWriteState(input.path, next);
  return next;
}

export async function atomicWriteState(path: string, state: ExcaliburState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function updateExcaliburState(
  mutator: (state: ExcaliburState) => void | ExcaliburState,
  opts: ScopedStateOptions = {},
): Promise<ExcaliburState> {
  const input = await resolveInputs(opts);
  let result!: ExcaliburState;
  const prior = updateQueues.get(input.path) ?? Promise.resolve();
  const current = prior.then(async () => {
    const state = await loadExcaliburState({ ...opts, scope: input.scope, env: input.env });
    const draft = structuredClone(state);
    const changed = mutator(draft);
    result = normalizeState(changed || draft, input.scope);
    await atomicWriteState(input.path, result);
  });
  const queued = current.catch(() => {});
  updateQueues.set(input.path, queued);
  await current;
  if (updateQueues.get(input.path) === queued) updateQueues.delete(input.path);
  return result;
}

export async function recordReceipt(
  receipt: Omit<ExcaliburReceipt, "receiptId" | "at"> & Partial<Pick<ExcaliburReceipt, "receiptId" | "at">>,
  opts: ScopedStateOptions = {},
): Promise<ExcaliburReceipt> {
  const value: ExcaliburReceipt = {
    receiptId: receipt.receiptId || randomUUID(),
    at: receipt.at || new Date().toISOString(),
    ...receipt,
  };
  await updateExcaliburState((state) => {
    state.receipts = [value, ...state.receipts.filter((item) => item.receiptId !== value.receiptId)].slice(0, 500);
  }, opts);
  return value;
}

export async function upsertSession(
  record: ExcaliburSessionRecord,
  opts: ScopedStateOptions = {},
): Promise<void> {
  await updateExcaliburState((state) => {
    state.sessions = [record, ...state.sessions.filter((item) => item.sessionId !== record.sessionId)].slice(0, 200);
  }, opts);
}

export async function setSelectedContext(contextId: string, opts: ScopedStateOptions = {}): Promise<void> {
  await updateExcaliburState((state) => {
    state.selectedContext = contextId;
  }, opts);
}

export async function stateFileMode(opts: ScopedStateOptions = {}): Promise<number | null> {
  const input = await resolveInputs(opts);
  try {
    return (await stat(input.path)).mode & 0o777;
  } catch {
    return null;
  }
}
