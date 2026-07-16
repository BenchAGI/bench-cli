// Per-principal/per-instance entitlement resolution. Authenticated failures are
// fail-closed: live response -> matching fresh cache -> explicit error. Only an
// unauthenticated developer session may fall back to gateway agents.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { resolveStateScope, scopeDirectory, type StateScope } from "../state/scope.js";
import { hasAccountToken, loadAccount, resolveApiBase, type Account } from "./account.js";

export interface EntitledAgent {
  agentId: string;
  name: string;
  role: string;
  model?: string;
  emoji: string;
  active: boolean;
}

type EntitlementCache = {
  schema: "excalibur-entitlements-v1";
  principalHash: string;
  instanceId: string;
  fetchedAt: string;
  expiresAt: string;
  agents: EntitledAgent[];
};

export type ResolveEntitlementOptions = {
  timeoutMs?: number;
  cacheTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  account?: Account | null;
  firebaseToken?: string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  scope?: StateScope;
};

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

export class EntitlementResolutionError extends Error {
  readonly code = "ENTITLEMENTS_UNAVAILABLE";
  readonly exitCode = 13;

  constructor(message = "authenticated entitlements are unavailable and no matching fresh cache exists") {
    super(message);
    this.name = "EntitlementResolutionError";
  }
}

function normalize(arr: unknown): EntitledAgent[] {
  if (!Array.isArray(arr)) return [];
  const out: EntitledAgent[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.agentId !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(a.agentId)) continue;
    const clean = (value: unknown, fallback: string, max: number): string => {
      if (typeof value !== "string") return fallback;
      const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
      return text || fallback;
    };
    out.push({
      agentId: a.agentId,
      name: clean(a.name, a.agentId, 128),
      role: clean(a.role, "", 256),
      model: typeof a.model === "string" ? clean(a.model, "", 128) || undefined : undefined,
      emoji: clean(a.emoji, "•", 16),
      active: a.active !== false && a.status !== "inactive",
    });
  }
  return out;
}

export function entitlementCachePath(scope: StateScope, env: NodeJS.ProcessEnv = process.env): string {
  return join(scopeDirectory(scope, env), "entitlements.json");
}

async function atomicWriteCache(path: string, payload: EntitlementCache): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function readFreshCache(
  path: string,
  scope: StateScope,
  now: number,
): Promise<EntitledAgent[] | null> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as Partial<EntitlementCache>;
    if (cached.schema !== "excalibur-entitlements-v1") return null;
    if (cached.principalHash !== scope.principalHash) return null;
    if (cached.instanceId !== scope.instanceId) return null;
    const expiresAt = Date.parse(String(cached.expiresAt || ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    if (!Array.isArray(cached.agents)) return null;
    return normalize(cached.agents);
  } catch {
    return null;
  }
}

/**
 * Returns null only when there is no authenticated identity. Authenticated
 * callers receive their exact entitlement set (including an empty set) or an
 * EntitlementResolutionError; they never fall through to a broader roster.
 */
export async function resolveEntitledAgents(
  opts: ResolveEntitlementOptions = {},
): Promise<EntitledAgent[] | null> {
  const env = opts.env ?? process.env;
  const account = opts.account === undefined ? await loadAccount(env) : opts.account;
  const firebaseToken = opts.firebaseToken === undefined
    ? await loadFreshFirebaseIdToken().catch(() => null)
    : opts.firebaseToken;
  const haveAuth = Boolean(firebaseToken || hasAccountToken(account));
  if (!haveAuth) return null;

  const scope = opts.scope ?? await resolveStateScope({ env, account });
  if (scope.instanceId === "unbound") {
    throw new EntitlementResolutionError("authenticated account is not bound to an instance");
  }
  const cachePath = entitlementCachePath(scope, env);
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  let failure = "request failed";

  try {
    const headers: Record<string, string> = {};
    if (firebaseToken) headers.Authorization = `Bearer ${firebaseToken}`;
    else if (account?.token?.startsWith("bench_")) headers["X-API-Key"] = account.token;
    else if (hasAccountToken(account)) headers.Authorization = `Bearer ${account!.token}`;

    const res = await (opts.fetchFn ?? fetch)(`${resolveApiBase(account, env)}/v1/cli/entitlements`, {
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) {
      failure = `server returned HTTP ${res.status}`;
    } else {
      const data = await res.json().catch(() => null) as { agents?: unknown; instanceId?: unknown } | null;
      if (!data || !Array.isArray(data.agents)) {
        failure = "server returned an invalid entitlement document";
      } else {
        const responseInstance = typeof data.instanceId === "string" ? data.instanceId.trim() : "";
        if (!responseInstance) {
          failure = "server did not explicitly bind entitlements to an instance";
        } else if (responseInstance !== scope.instanceId) {
          throw new EntitlementResolutionError("entitlement response instance does not match the authenticated account");
        } else {
          const agents = normalize(data.agents);
          const ttl = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
          await atomicWriteCache(cachePath, {
            schema: "excalibur-entitlements-v1",
            principalHash: scope.principalHash,
            instanceId: responseInstance,
            fetchedAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + ttl).toISOString(),
            agents,
          });
          return agents;
        }
      }
    }
  } catch (error) {
    if (error instanceof EntitlementResolutionError) throw error;
    failure = (error as { name?: string })?.name === "AbortError" ? "request timed out" : "request failed";
  } finally {
    clearTimeout(timer);
  }

  const cached = await readFreshCache(cachePath, scope, nowMs);
  if (cached) return cached;
  throw new EntitlementResolutionError(`${failure}; refusing broader roster fallback`);
}
