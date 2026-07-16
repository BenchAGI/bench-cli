import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { UCP_SCHEMA_VERSION, UcpDeniedError, type UcpConfig } from "./types.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const OP_REF = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;

export const DEFAULT_UCP_CONFIG: UcpConfig = {
  schemaVersion: UCP_SCHEMA_VERSION,
  openclaw: {
    bin: "openclaw",
    gatewayTarget: "http://100.64.0.3:18789",
  },
  memory: {
    remoteMcpUrl: "https://control-bench.benchagi.com/mcp",
  },
  bench: {
    apiBase: null,
    secretRef: null,
    requiredItem: "Bench Chassis API",
  },
  mesh: {
    controlUrl: "https://control-bench.benchagi.com:8443",
    derpUrl: "https://relay-bench.benchagi.com",
    secretRef: null,
    requiredItem: "Flyway Headscale API",
  },
  github: {
    allowedOrgs: ["BenchAGI"],
    secretRef: null,
    requiredItem: "GitHub Draft Publisher",
  },
  mail: {
    draftDirectory: null,
  },
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(env.HOME?.trim() || homedir(), ".config", "excalibur", "ucp.json");
  const override = env.EXCALIBUR_UCP_CONFIG?.trim();
  if (override && resolve(override) !== resolve(path)) {
    throw new UcpDeniedError("UCP_CONFIG_PATH_INVALID", "UCP configuration is pinned to $HOME/.config/excalibur/ucp.json");
  }
  return path;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function url(value: unknown, fallback: string | null): string | null {
  const candidate = text(value, fallback);
  if (candidate === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UcpDeniedError("UCP_CONFIG_INVALID", "UCP configuration contains an invalid URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new UcpDeniedError("UCP_CONFIG_INVALID", "UCP URLs must be credential-free HTTP(S) origins");
  }
  return parsed.toString().replace(/\/$/, "");
}

function httpsUrl(value: unknown, fallback: string | null): string | null {
  const candidate = url(value, fallback);
  if (candidate === null) return null;
  if (new URL(candidate).protocol !== "https:") {
    throw new UcpDeniedError("UCP_CONFIG_INVALID", "Credential-bearing control-plane origins must use HTTPS");
  }
  return candidate;
}

function secretRef(value: unknown, fallback: string | null): string | null {
  const candidate = text(value, fallback);
  if (candidate === null) return null;
  if (!OP_REF.test(candidate)) {
    throw new UcpDeniedError("UCP_SECRET_REF_INVALID", "Secret references must use op://vault/item/field form");
  }
  return candidate;
}

function assertNoEmbeddedSecrets(value: unknown, trail: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, [...trail, String(index)]));
    return;
  }
  const record = object(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (/^(?:apikey|password|token|authorization|credential|secret|privatekey)$/.test(normalized)
        && normalized !== "secretref") {
      throw new UcpDeniedError(
        "UCP_EMBEDDED_SECRET_DENIED",
        `UCP configuration may contain secret references, not secret material (${[...trail, key].join(".")})`,
      );
    }
    assertNoEmbeddedSecrets(child, [...trail, key]);
  }
}

function parseConfig(raw: unknown): UcpConfig {
  const root = object(raw);
  if (!root) throw new UcpDeniedError("UCP_CONFIG_INVALID", "UCP configuration must be a JSON object");
  assertNoEmbeddedSecrets(root);
  const openclaw = object(root.openclaw) || {};
  const memory = object(root.memory) || {};
  const bench = object(root.bench) || {};
  const mesh = object(root.mesh) || {};
  const github = object(root.github) || {};
  const mail = object(root.mail) || {};
  const allowedOrgs = Array.isArray(github.allowedOrgs)
    ? github.allowedOrgs
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(item))
    : DEFAULT_UCP_CONFIG.github.allowedOrgs;
  if (allowedOrgs.length === 0) {
    throw new UcpDeniedError("UCP_CONFIG_INVALID", "At least one GitHub organization must be allowlisted");
  }
  return {
    schemaVersion: UCP_SCHEMA_VERSION,
    openclaw: {
      bin: text(openclaw.bin, DEFAULT_UCP_CONFIG.openclaw.bin)!,
      gatewayTarget: url(openclaw.gatewayTarget, DEFAULT_UCP_CONFIG.openclaw.gatewayTarget)!,
    },
    memory: {
      remoteMcpUrl: httpsUrl(memory.remoteMcpUrl, DEFAULT_UCP_CONFIG.memory.remoteMcpUrl),
    },
    bench: {
      apiBase: httpsUrl(bench.apiBase, DEFAULT_UCP_CONFIG.bench.apiBase),
      secretRef: secretRef(bench.secretRef, DEFAULT_UCP_CONFIG.bench.secretRef),
      requiredItem: text(bench.requiredItem, DEFAULT_UCP_CONFIG.bench.requiredItem)!,
    },
    mesh: {
      controlUrl: httpsUrl(mesh.controlUrl, DEFAULT_UCP_CONFIG.mesh.controlUrl)!,
      derpUrl: httpsUrl(mesh.derpUrl, DEFAULT_UCP_CONFIG.mesh.derpUrl)!,
      secretRef: secretRef(mesh.secretRef, DEFAULT_UCP_CONFIG.mesh.secretRef),
      requiredItem: text(mesh.requiredItem, DEFAULT_UCP_CONFIG.mesh.requiredItem)!,
    },
    github: {
      allowedOrgs: [...new Set(allowedOrgs)],
      secretRef: secretRef(github.secretRef, DEFAULT_UCP_CONFIG.github.secretRef),
      requiredItem: text(github.requiredItem, DEFAULT_UCP_CONFIG.github.requiredItem)!,
    },
    mail: {
      draftDirectory: text(mail.draftDirectory, DEFAULT_UCP_CONFIG.mail.draftDirectory),
    },
  };
}

export async function loadUcpConfig(env: NodeJS.ProcessEnv = process.env): Promise<{
  config: UcpConfig;
  path: string;
  exists: boolean;
  privateMode: boolean | null;
  ownedByPrincipal: boolean | null;
  safeFile: boolean | null;
}> {
  const path = defaultConfigPath(env);
  if (!isAbsolute(path)) {
    throw new UcpDeniedError("UCP_CONFIG_PATH_INVALID", "EXCALIBUR_UCP_CONFIG must be absolute");
  }
  const info = await lstat(path).catch(() => null);
  if (!info) {
    return { config: structuredClone(DEFAULT_UCP_CONFIG), path, exists: false, privateMode: null, ownedByPrincipal: null, safeFile: null };
  }
  const parent = await lstat(dirname(path)).catch(() => null);
  const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  const privateMode = (info.mode & 0o077) === 0;
  const ownedByPrincipal = info.uid === uid;
  const safeParent = Boolean(parent?.isDirectory() && parent.uid === uid && (parent.mode & 0o022) === 0);
  const safeFile = info.isFile() && !info.isSymbolicLink() && info.size <= MAX_CONFIG_BYTES
    && privateMode && ownedByPrincipal && safeParent;
  if (!safeFile) {
    return { config: structuredClone(DEFAULT_UCP_CONFIG), path, exists: true, privateMode, ownedByPrincipal, safeFile: false };
  }
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UcpDeniedError("UCP_CONFIG_INVALID", "UCP configuration is not valid JSON");
  }
  return {
    config: parseConfig(parsed),
    path,
    exists: true,
    privateMode,
    ownedByPrincipal,
    safeFile: true,
  };
}

export function parseOnePasswordRef(reference: string): { vault: string; item: string; field: string } {
  if (!OP_REF.test(reference)) {
    throw new UcpDeniedError("UCP_SECRET_REF_INVALID", "Secret references must use op://vault/item/field form");
  }
  const [vault, item, field] = reference.slice("op://".length).split("/");
  return { vault: vault!, item: item!, field: field! };
}
