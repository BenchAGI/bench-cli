// account.ts — resolve the CLI account/identity (bench login or instance API token).
// Order: env → ~/.config/benchagi/account.json → ~/.benchagi/account.json (back-compat).
// Never logs the token.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const DEFAULT_API_BASE = "https://app.benchagi.com/api";
export async function loadAccount(env = process.env) {
    if (env.BENCHAGI_API_BASE) {
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
            if (acct?.apiBase || acct?.token)
                return acct;
        }
        catch {
            // missing/invalid → try next
        }
    }
    return null;
}
export function resolveApiBase(account, env = process.env) {
    return String(env.BENCHAGI_API_BASE || account?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}
