import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { currentPrincipal, ucpStateRoot } from "./receipts.js";
import {
  UCP_SCHEMA_VERSION,
  UcpDeniedError,
  type CapabilityMode,
  type GrantRecord,
} from "./types.js";

const MAX_GRANT_TTL_SECONDS = 15 * 60;
const GRANT_MODES = new Set<GrantRecord["mode"]>([
  "secret-use",
  "mutate-tenant",
  "publish-draft",
  "outbound-draft",
]);

function grantsDirectory(env: NodeJS.ProcessEnv): string {
  return join(ucpStateRoot(env), "state", "grants");
}

async function writePrivate(path: string, value: GrantRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  const uid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new UcpDeniedError("UCP_GRANT_STORE_UNSAFE", "Grant storage must be an owner-private, non-symlinked directory");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function validGrant(value: unknown): value is GrantRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as GrantRecord;
  return grant.schemaVersion === UCP_SCHEMA_VERSION
    && /^[0-9a-f-]{36}$/.test(grant.grantId)
    && GRANT_MODES.has(grant.mode)
    && Array.isArray(grant.effectIds)
    && grant.effectIds.length > 0
    && grant.effectIds.every((item) => /^[a-z][a-z0-9_.-]{2,80}$/.test(item))
    && /^[a-f0-9]{64}$/.test(grant.requestDigest)
    && /^[0-9a-f-]{36}$/.test(grant.sourceReceiptId)
    && grant.missionSecretBundle === false
    && typeof grant.principal === "string"
    && grant.principal.length > 0
    && grant.principal.length <= 256
    && typeof grant.purpose === "string"
    && grant.purpose.length >= 3
    && grant.purpose.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(grant.purpose)
    && Number.isFinite(Date.parse(grant.issuedAt))
    && Number.isFinite(Date.parse(grant.expiresAt));
}

function safeGrantWindow(grant: GrantRecord, nowMs: number): boolean {
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  return issuedAt <= nowMs + 5_000
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= MAX_GRANT_TTL_SECONDS * 1_000
    && expiresAt <= nowMs + MAX_GRANT_TTL_SECONDS * 1_000;
}

export class GrantStore {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    mode: GrantRecord["mode"];
    effectIds: string[];
    requestDigest: string;
    sourceReceiptId: string;
    ttlSeconds: number;
    missionSecretBundle: boolean;
    purpose: string;
  }): Promise<GrantRecord> {
    if (!GRANT_MODES.has(input.mode)) {
      throw new UcpDeniedError("UCP_GRANT_MODE_INVALID", "Only protected capability modes can be granted");
    }
    if (input.missionSecretBundle) {
      throw new UcpDeniedError("UCP_MISSION_BUNDLE_UNAVAILABLE", "Durable mission bundles require a tamper-resistant broker and are not accepted");
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_GRANT_TTL_SECONDS) {
      throw new UcpDeniedError("UCP_GRANT_TTL_INVALID", "Grant TTL must be between 1 and 900 seconds");
    }
    const effectIds = [...new Set(input.effectIds)];
    if (effectIds.length === 0 || effectIds.some((item) => !/^[a-z][a-z0-9_.-]{2,80}$/.test(item))) {
      throw new UcpDeniedError("UCP_GRANT_EFFECT_INVALID", "A grant must enumerate valid effect IDs");
    }
    if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw new UcpDeniedError("UCP_GRANT_REQUEST_INVALID", "A grant must bind to one dry-run request digest");
    }
    if (!/^[0-9a-f-]{36}$/.test(input.sourceReceiptId)) {
      throw new UcpDeniedError("UCP_GRANT_RECEIPT_INVALID", "A grant must cite one successful dry-run receipt");
    }
    const purpose = input.purpose.trim();
    if (purpose.length < 3 || purpose.length > 240 || /[\u0000-\u001f\u007f]/.test(purpose)) {
      throw new UcpDeniedError("UCP_GRANT_PURPOSE_INVALID", "A bounded, printable grant purpose is required");
    }
    const issued = this.now();
    const grant: GrantRecord = {
      schemaVersion: UCP_SCHEMA_VERSION,
      grantId: randomUUID(),
      mode: input.mode,
      effectIds,
      requestDigest: input.requestDigest,
      sourceReceiptId: input.sourceReceiptId,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + input.ttlSeconds * 1_000).toISOString(),
      principal: currentPrincipal(),
      missionSecretBundle: input.missionSecretBundle,
      purpose,
    };
    await writePrivate(join(grantsDirectory(this.env), `${grant.grantId}.json`), grant);
    return grant;
  }

  async getOpen(grantIds?: string[]): Promise<GrantRecord[]> {
    const directory = grantsDirectory(this.env);
    const directoryInfo = await lstat(directory).catch(() => null);
    const uid = typeof process.getuid === "function" ? process.getuid() : directoryInfo?.uid;
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
        || directoryInfo.uid !== uid || (directoryInfo.mode & 0o077) !== 0) return [];
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const wanted = grantIds ? new Set(grantIds) : null;
    const nowMs = this.now().getTime();
    const output: GrantRecord[] = [];
    for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item))) {
      const id = name.slice(0, -5);
      if (wanted && !wanted.has(id)) continue;
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) continue;
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!validGrant(value) || value.principal !== currentPrincipal()) continue;
        if (!safeGrantWindow(value, nowMs)) continue;
        if (Date.parse(value.expiresAt) <= nowMs) continue;
        output.push(value);
      } catch {
        // Invalid files do not become authority.
      }
    }
    return output.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  async revoke(grantId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(grantId)) throw new UcpDeniedError("UCP_GRANT_INVALID", "Invalid grant ID");
    await unlink(join(grantsDirectory(this.env), `${grantId}.json`)).catch(() => undefined);
  }

  async authorize(
    effectId: string,
    modes: CapabilityMode[],
    explicitGrantIds: string[],
    requestDigest: string,
  ): Promise<{ grants: GrantRecord[]; capabilityModes: CapabilityMode[] }> {
    const grants = await this.getOpen(explicitGrantIds);
    if (grants.length !== explicitGrantIds.length) {
      throw new UcpDeniedError("UCP_GRANT_MISSING_OR_EXPIRED", "An explicit effect grant is missing, expired, or unsafe");
    }
    const ambient = new Set<CapabilityMode>(["observe", "prepare"]);
    for (const grant of grants) {
      if (grant.effectIds.includes(effectId) && grant.requestDigest === requestDigest) ambient.add(grant.mode);
    }
    for (const mode of modes) {
      if (mode === "secret-use") continue;
      if (!ambient.has(mode)) {
        throw new UcpDeniedError("UCP_CAPABILITY_MODE_DENIED", `Effect requires an explicit ${mode} grant`);
      }
    }
    return { grants, capabilityModes: [...ambient] };
  }
}
