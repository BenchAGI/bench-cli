// entitlements.ts — per-tenant/per-user agent provisioning. Fetches the agents
// this user/instance is entitled to from benchagi.com, caches them, and degrades
// gracefully: live → cache → null (caller falls back to gateway `agents list`).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { hasAccountToken, loadAccount, resolveApiBase } from "./account.js";

export interface EntitledAgent {
  agentId: string;
  name: string;
  role: string;
  model?: string;
  emoji: string;
  active: boolean;
}

const DEFAULT_TIMEOUT = 3000;
const CACHE_PATH = join(homedir(), ".config", "benchagi", "roster-cache.json");

function normalize(arr: unknown): EntitledAgent[] {
  if (!Array.isArray(arr)) return [];
  const out: EntitledAgent[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    // Strict id charset — agentId is later used in a filesystem path (seat prompt);
    // reject anything that could traverse. Also cleans a poisoned roster cache.
    if (typeof a.agentId !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(a.agentId)) continue;
    out.push({
      agentId: a.agentId,
      name: typeof a.name === "string" ? a.name : a.agentId,
      role: typeof a.role === "string" ? a.role : "",
      model: typeof a.model === "string" ? a.model : undefined,
      emoji: typeof a.emoji === "string" ? a.emoji : "•",
      active: a.active !== false && a.status !== "inactive",
    });
  }
  return out;
}

async function writeCache(payload: unknown): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // cache is best-effort
  }
}

/** Returns entitled agents, or null → caller uses the gateway `agents list`. */
export async function resolveEntitledAgents(opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<EntitledAgent[] | null> {
  const env = opts.env ?? process.env;
  const account = await loadAccount(env);
  const apiBase = resolveApiBase(account, env);
  const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);

  const haveAuth = Boolean(firebaseToken || hasAccountToken(account));
  if (haveAuth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const headers: Record<string, string> = {};
      if (firebaseToken) headers["Authorization"] = `Bearer ${firebaseToken}`;
      else if (account?.token?.startsWith("bench_")) headers["X-API-Key"] = account.token;
      else if (hasAccountToken(account)) headers["Authorization"] = `Bearer ${account!.token}`;

      const res = await fetch(`${apiBase}/v1/cli/entitlements`, { headers, signal: controller.signal, redirect: "error" });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { agents?: unknown; instanceId?: string } | null;
        const agents = normalize(data?.agents);
        if (agents.length) {
          await writeCache({ agents, instanceId: data?.instanceId ?? null, fetchedAt: new Date().toISOString() });
          return agents;
        }
      }
    } catch {
      // network/abort → fall through to cache
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const cached = JSON.parse(await readFile(CACHE_PATH, "utf8")) as { agents?: unknown };
    const agents = normalize(cached?.agents);
    if (agents.length) return agents;
  } catch {
    // no cache
  }
  return null;
}
