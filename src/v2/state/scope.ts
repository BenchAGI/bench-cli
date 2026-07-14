import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { loadCreds } from "./keychain.js";
import { loadAccount, type Account } from "../launcher/account.js";

export type StateScope = {
  principalId: string;
  principalHash: string;
  instanceId: string;
  authenticated: boolean;
};

export type ResolveScopeOptions = {
  env?: NodeJS.ProcessEnv;
  account?: Account | null;
  firebaseIdentity?: { uid?: string; email?: string } | null;
};

export function stableScopeHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

export function safeScopeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // Keep paths readable without allowing two distinct instance identifiers
  // (for example `customer/a` and `customer-a`) to collapse into one scope.
  const prefix = (cleaned || "unbound").slice(0, 72);
  return `${prefix}-${stableScopeHash(value).slice(0, 12)}`;
}

export function excaliburStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXCALIBUR_STATE_DIR || join(homedir(), ".config", "excalibur", "v1");
}

export function scopeDirectory(scope: StateScope, env: NodeJS.ProcessEnv = process.env): string {
  return join(
    excaliburStateRoot(env),
    "accounts",
    scope.principalHash,
    "instances",
    safeScopeSegment(scope.instanceId),
  );
}

export async function resolveStateScope(opts: ResolveScopeOptions = {}): Promise<StateScope> {
  const env = opts.env ?? process.env;
  const account = opts.account === undefined ? await loadAccount(env).catch(() => null) : opts.account;
  const firebase = opts.firebaseIdentity === undefined
    ? await loadCreds().then((creds) => creds ? ({ uid: creds.uid, email: creds.email }) : null).catch(() => null)
    : opts.firebaseIdentity;

  const token = account?.token?.trim() || "";
  const principalId =
    account?.user?.uid?.trim() ||
    firebase?.uid?.trim() ||
    account?.user?.email?.trim().toLowerCase() ||
    firebase?.email?.trim().toLowerCase() ||
    (token ? `token:${stableScopeHash(token)}` : `local:${userInfo().username}`);
  const authenticated = Boolean(token || firebase?.uid || firebase?.email);
  const instanceId =
    env.EXCALIBUR_INSTANCE_ID?.trim() ||
    env.BENCHAGI_INSTANCE_ID?.trim() ||
    account?.instanceId?.trim() ||
    (authenticated ? "unbound" : "operator-local");

  return {
    principalId,
    principalHash: stableScopeHash(principalId),
    instanceId,
    authenticated,
  };
}
