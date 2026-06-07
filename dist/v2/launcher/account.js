// account.ts — resolve the CLI account/identity (bench login or instance API token).
// Order: env → ~/.config/benchagi/account.json → ~/.benchagi/account.json (back-compat).
// Never logs the token.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const DEFAULT_API_BASE = "https://app.benchagi.com/api";
export async function loadAccount(env = process.env) {
    if (env.BENCHAGI_API_BASE || env.BENCHAGI_TOKEN || env.BENCHAGI_INSTANCE_ID) {
        return {
            apiBase: env.BENCHAGI_API_BASE,
            token: env.BENCHAGI_TOKEN ?? "",
            instanceId: env.BENCHAGI_INSTANCE_ID ?? "",
        };
    }
    const candidates = [
        join(homedir(), ".config", "benchagi", "account.json"),
        join(homedir(), ".benchagi", "account.json"), // back-compat with the kestrel operator build
    ];
    for (const p of candidates) {
        try {
            const acct = JSON.parse(await readFile(p, "utf8"));
            // Accept a cloud account (apiBase/token) OR an identity-only account (a "user"
            // block — a local "who am I" assertion before/without login).
            if (acct?.apiBase || acct?.token || acct?.user)
                return acct;
        }
        catch {
            // missing/invalid → try next
        }
    }
    return null;
}
export function resolveApiBase(account, env = process.env) {
    const raw = String(env.BENCHAGI_API_BASE || account?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    // Refuse a cleartext base — the manifest/entitlements responses drive the
    // launcher, so an http base would let an on-path attacker substitute them.
    // Non-https (except localhost dev) falls back to the canonical https default.
    try {
        const u = new URL(raw);
        if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
            return DEFAULT_API_BASE;
        }
        return raw;
    }
    catch {
        return DEFAULT_API_BASE;
    }
}
export function hasAccountToken(account) {
    return typeof account?.token === "string" && account.token.trim().length > 0;
}
