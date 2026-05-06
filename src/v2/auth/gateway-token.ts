// Resolve the local OpenClaw Gateway token. Precedence:
//   1. Explicit constructor arg
//   2. OPENCLAW_GATEWAY_TOKEN env var
//   3. openclaw.json's gateway.auth.token
//   4. (V1) device identity-only — works for read paths but fails on
//      operator-write methods unless the gateway grants scopes.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export async function resolveGatewayToken(
  explicit?: string | null,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return envToken;
  return await readGatewayTokenFromConfig();
}

export async function resolveGatewayPassword(
  explicit?: string | null,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const envPwd = process.env.OPENCLAW_GATEWAY_PASSWORD;
  if (envPwd) return envPwd;
  return undefined;
}

async function readGatewayTokenFromConfig(): Promise<string | undefined> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { auth?: { mode?: string; token?: string } };
    };
    const auth = parsed?.gateway?.auth;
    if (!auth) return undefined;
    if (auth.mode === "token" && typeof auth.token === "string" && auth.token.length > 0) {
      return auth.token;
    }
  } catch {
    // ignore
  }
  return undefined;
}
