import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { collectSessionHealthCard } from "./health.js";
import { createSeatPacket, readFrozenPacket, writeFrozenPacket } from "./packet.js";
import { runCaptured } from "./process.js";
import { requestDigest, ucpStateRoot } from "./receipts.js";
import { UcpDeniedError, } from "./types.js";
const HTTP_CHILD = `
const url = process.env.UCP_HTTP_URL;
const secret = process.env.UCP_EFFECT_SECRET;
const name = process.env.UCP_HTTP_SECRET_HEADER;
const prefix = process.env.UCP_HTTP_SECRET_PREFIX || "";
if (!url || !secret || !name) process.exit(64);
const extra = JSON.parse(process.env.UCP_HTTP_HEADERS || "{}");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(process.env.UCP_HTTP_TIMEOUT_MS || "8000"));
try {
  const response = await fetch(url, {
    method: process.env.UCP_HTTP_METHOD || "GET",
    headers: { ...extra, [name]: prefix + secret, Accept: "application/json" },
    redirect: "error",
    signal: controller.signal,
  });
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 1048576) { await reader.cancel(); process.exit(65); }
      chunks.push(Buffer.from(next.value));
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { nonJson: true }; }
  process.stdout.write(JSON.stringify({ status: response.status, ok: response.ok, body }));
} catch { process.exit(69); } finally { clearTimeout(timer); }
`;
const GITHUB_CHECKS_CHILD = `
const repository = process.env.UCP_GITHUB_REPOSITORY;
const pullRequest = process.env.UCP_GITHUB_PULL_REQUEST;
const token = process.env.GH_TOKEN;
if (!repository || !pullRequest || !token) process.exit(64);
const headers = {
  Authorization: "Bearer " + token,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "excalibur-ucp/1",
};
async function json(url) {
  const response = await fetch(url, { headers, redirect: "error" });
  if (!response.ok) return { status: response.status, body: null };
  const reader = response.body?.getReader();
  const chunks = [];
  let total = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 1048576) { await reader.cancel(); process.exit(65); }
      chunks.push(Buffer.from(next.value));
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return { status: response.status, body: raw ? JSON.parse(raw) : null }; }
  catch { process.exit(66); }
}
try {
  const root = "https://api.github.com/repos/" + repository;
  const pr = await json(root + "/pulls/" + encodeURIComponent(pullRequest));
  const sha = pr.body?.head?.sha;
  if (pr.status !== 200 || typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) process.exit(67);
  const checks = await json(root + "/commits/" + sha + "/check-runs?per_page=100");
  if (checks.status !== 200) process.exit(68);
  process.stdout.write(JSON.stringify({ headSha: sha, checks: checks.body?.check_runs || [] }));
} catch { process.exit(69); }
`;
function record(value, label = "input") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new UcpDeniedError("UCP_INPUT_INVALID", `${label} must be an object`);
    }
    return value;
}
function stringValue(value, label, maximum = 2_048) {
    if (typeof value !== "string")
        throw new UcpDeniedError("UCP_INPUT_INVALID", `${label} must be text`);
    const text = value.trim();
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new UcpDeniedError("UCP_INPUT_INVALID", `${label} is empty, oversized, or contains control characters`);
    }
    return text;
}
function absolutePath(value, label) {
    const path = stringValue(value, label, 1_024);
    if (!isAbsolute(path) || path.split("/").includes("..")) {
        throw new UcpDeniedError("UCP_PATH_DENIED", `${label} must be absolute and traversal-free`);
    }
    return resolve(path);
}
function boundedInt(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new UcpDeniedError("UCP_INPUT_INVALID", `${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return number;
}
function safeRef(value, label) {
    const ref = stringValue(value, label, 255);
    if (ref.startsWith("-") || /(?:\.\.|[~^:?*\[\\\s])/.test(ref) || /^(?:HEAD|main|master)$/.test(ref) && label === "head") {
        throw new UcpDeniedError("UCP_GIT_REF_DENIED", `${label} is not a safe branch ref`);
    }
    return ref;
}
function repository(value, allowedOrgs) {
    const name = stringValue(value, "repository", 220);
    const match = name.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/);
    if (!match || !allowedOrgs.some((org) => org.toLowerCase() === match[1].toLowerCase())) {
        throw new UcpDeniedError("GITHUB_REPOSITORY_DENIED", "Repository organization is not allowlisted");
    }
    return name;
}
function secretShape(text) {
    return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{20,}|op:\/\/[^\s]+)/.test(text);
}
function safeBody(value, label, maximum = 64_000) {
    if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new UcpDeniedError("UCP_INPUT_INVALID", `${label} is oversized or contains control characters`);
    }
    if (secretShape(value))
        throw new UcpDeniedError("UCP_SECRET_IN_CONTENT_DENIED", `${label} contains credential-shaped material`);
    return value.trim();
}
function isInside(root, candidate) {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function stateOutputPath(ctx, value, bucket, label) {
    const path = absolutePath(value, label);
    const root = join(ucpStateRoot(ctx.env), "state", bucket);
    if (!isInside(root, path) || path === resolve(root)) {
        throw new UcpDeniedError("UCP_OUTPUT_PATH_DENIED", `${label} must be a new file beneath the UCP ${bucket} state directory`);
    }
    return path;
}
function redactExternal(value, depth = 0) {
    if (depth > 10)
        return "[truncated]";
    if (value === null || typeof value === "boolean" || typeof value === "number")
        return value;
    if (typeof value === "string") {
        if (secretShape(value))
            return "[redacted]";
        return value.length > 16_000 ? `${value.slice(0, 16_000)}…` : value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    }
    if (Array.isArray(value))
        return value.slice(0, 200).map((item) => redactExternal(item, depth + 1));
    if (typeof value !== "object")
        return null;
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 256)) {
        if (/(?:authorization|cookie|credential|password|secret|token|api[-_]?key|preauth)/i.test(key))
            output[key] = "[redacted]";
        else
            output[key] = redactExternal(child, depth + 1);
    }
    return output;
}
function arrayCount(value) {
    if (Array.isArray(value))
        return value.length;
    if (!value || typeof value !== "object")
        return 0;
    for (const key of ["deals", "nodes", "items", "results", "data"]) {
        const child = value[key];
        if (Array.isArray(child))
            return child.length;
    }
    return 0;
}
async function secretJsonRequest(ctx, options) {
    const target = new URL(options.url);
    if (target.protocol !== "https:" || target.username || target.password) {
        throw new UcpDeniedError("UCP_UPSTREAM_TARGET_DENIED", "Protected upstream requests require a credential-free HTTPS target");
    }
    const result = await ctx.gatekeeper.runSecretCommand({
        effectId: ctx.effectId,
        secretRef: options.secretRef,
        envName: "UCP_EFFECT_SECRET",
        purpose: `${options.purpose} · target ${target.origin}`,
        command: process.execPath,
        args: ["-e", HTTP_CHILD],
        env: {
            ...ctx.env,
            UCP_HTTP_URL: options.url,
            UCP_HTTP_SECRET_HEADER: options.headerName,
            UCP_HTTP_SECRET_PREFIX: options.headerPrefix || "",
            UCP_HTTP_HEADERS: JSON.stringify(options.headers || {}),
            UCP_HTTP_TIMEOUT_MS: "8000",
        },
        timeoutMs: 12_000,
        maxBytes: 1024 * 1024 + 4_096,
        grants: ctx.grants,
    });
    ctx.secretUses.push(result.audit);
    if (result.process.code !== 0 || result.process.truncated) {
        throw new UcpDeniedError("UCP_UPSTREAM_UNAVAILABLE", "Protected upstream request failed without exposing response content");
    }
    let parsed;
    try {
        parsed = JSON.parse(result.process.stdout);
    }
    catch {
        throw new UcpDeniedError("UCP_UPSTREAM_INVALID", "Protected upstream returned an invalid response envelope");
    }
    const envelope = record(parsed, "upstream response");
    const status = Number(envelope.status);
    if (!Number.isInteger(status))
        throw new UcpDeniedError("UCP_UPSTREAM_INVALID", "Protected upstream omitted its HTTP status");
    return { status, body: envelope.body };
}
async function writePrivateFile(path, body) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(path));
    const uid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
        throw new UcpDeniedError("UCP_OUTPUT_PATH_DENIED", "Protected local output requires an owner-private, non-symlinked directory");
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
    }
    catch {
        throw new UcpDeniedError("UCP_OUTPUT_EXISTS", "Protected local output already exists; no file was replaced");
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
function requireBenchConfig(ctx) {
    if (!ctx.config.bench.apiBase || !ctx.config.bench.secretRef) {
        throw new UcpDeniedError("BENCH_MISSING_CONFIG", `Bench live access is missing_config; create/reference 1Password item “${ctx.config.bench.requiredItem}”`, "missing_config");
    }
    const instanceId = stringValue(ctx.input.instanceId, "instanceId", 128);
    requireBoundInstance(ctx, instanceId);
    return { apiBase: ctx.config.bench.apiBase, secretRef: ctx.config.bench.secretRef, instanceId };
}
function requireBoundInstance(ctx, instanceId) {
    const bound = ctx.env.EXCALIBUR_INSTANCE_ID?.trim() || ctx.env.BENCHAGI_INSTANCE_ID?.trim();
    const validScope = (value) => Boolean(value
        && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value)
        && !/^(?:all|any|bulk|default|global|operator-local|unbound)$/i.test(value));
    if (!validScope(bound)) {
        throw new UcpDeniedError("UCP_TENANT_SCOPE_MISSING", "A live customer effect requires an explicit Excalibur instance scope", "missing_config");
    }
    if (!validScope(instanceId)) {
        throw new UcpDeniedError("UCP_TENANT_SCOPE_INVALID", "Customer effects deny implicit, placeholder, and bulk instance scopes");
    }
    if (bound !== instanceId) {
        throw new UcpDeniedError("UCP_TENANT_SCOPE_DENIED", "Requested instance does not match the selected Excalibur instance scope");
    }
}
async function benchRead(ctx, path) {
    const config = requireBenchConfig(ctx);
    const response = await secretJsonRequest(ctx, {
        secretRef: config.secretRef,
        url: `${config.apiBase}${path}`,
        headerName: "X-API-Key",
        headers: { "x-expected-instance-id": config.instanceId },
        purpose: `${ctx.effectId} · tenant-bound Bench read`,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new UcpDeniedError("BENCH_READ_DENIED", `Bench returned HTTP ${response.status}; no file fallback was used`);
    }
    return {
        status: "succeeded",
        summary: "Bench returned authenticated tenant-scoped live truth",
        details: { httpStatus: response.status, recordCount: arrayCount(response.body), source: "bench.agent_api" },
        output: redactExternal(response.body),
    };
}
async function worktreePrepare(ctx) {
    const repoPath = absolutePath(ctx.input.repoPath, "repoPath");
    const worktreePath = absolutePath(ctx.input.worktreePath, "worktreePath");
    const branch = safeRef(ctx.input.branch, "head");
    const baseRef = safeRef(ctx.input.baseRef ?? "main", "baseRef");
    if (!branch.startsWith("codex/"))
        throw new UcpDeniedError("WORKTREE_BRANCH_DENIED", "Prepared branches must use the codex/ prefix");
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "Worktree prepare validated; no git command ran", details: { branch, baseRef, worktreePath } };
    }
    const result = await runCaptured("/usr/bin/git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath, baseRef], {
        timeoutMs: 30_000,
        maxBytes: 32 * 1024,
    });
    if (result.code !== 0)
        throw new UcpDeniedError("WORKTREE_PREPARE_FAILED", "Git could not prepare the bounded worktree");
    return { status: "succeeded", summary: "Prepared isolated local worktree", details: { branch, baseRef, worktreePath } };
}
async function packetFreeze(ctx) {
    const packet = createSeatPacket(ctx.input.packet);
    const outputPath = stateOutputPath(ctx, ctx.input.outputPath, "packets", "outputPath");
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "Seat packet schema validated; no packet was written", details: { packetDigest: packet.packetDigest, maxFiles: packet.maxFiles }, output: packet };
    }
    await writeFrozenPacket(outputPath, packet);
    return { status: "succeeded", summary: "Frozen owner-private bounded seat packet", details: { packetDigest: packet.packetDigest, maxFiles: packet.maxFiles, outputPath }, output: packet };
}
async function seatDispatch(ctx) {
    const packetPath = absolutePath(ctx.input.packetPath, "packetPath");
    const seat = stringValue(ctx.input.seat, "seat", 64);
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(seat))
        throw new UcpDeniedError("SEAT_TARGET_DENIED", "Seat ID is invalid");
    const packet = await readFrozenPacket(packetPath);
    for (const repoPath of packet.repoPaths) {
        const topLevel = await runCaptured("/usr/bin/git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
            timeoutMs: 3_000,
            maxBytes: 4 * 1024,
        });
        if (topLevel.code !== 0 || topLevel.truncated || resolve(topLevel.stdout.trim()) !== resolve(repoPath)) {
            throw new UcpDeniedError("SEAT_PACKET_REPOSITORY_DENIED", "Every seat packet repoPath must be an existing Git repository root");
        }
    }
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "Bounded effects-none seat dispatch validated; OpenClaw was not invoked", details: { seat, packetDigest: packet.packetDigest, maxFiles: packet.maxFiles } };
    }
    throw new UcpDeniedError("CANONICAL_ORCHESTRA_BROKER_REQUIRED", "Model dispatch is available only through /orchestra advance with the exact mission digest");
}
function exactDigest(value, label, length = 64) {
    const digest = stringValue(value, label, length);
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(digest)) {
        throw new UcpDeniedError("UCP_DIGEST_INVALID", `${label} must be an exact lowercase hex digest`);
    }
    return digest;
}
async function watchChecks(ctx) {
    const repo = repository(ctx.input.repository, ctx.config.github.allowedOrgs);
    const pullRequest = boundedInt(ctx.input.pullRequest, "pullRequest", 1, Number.MAX_SAFE_INTEGER);
    const expectedHeadSha = exactDigest(ctx.input.expectedHeadSha, "expectedHeadSha", 40);
    if (!ctx.config.github.secretRef) {
        throw new UcpDeniedError("GITHUB_MISSING_CONFIG", `GitHub checks are missing_config; create/reference 1Password item “${ctx.config.github.requiredItem}”`, "missing_config");
    }
    const result = await ctx.gatekeeper.runSecretCommand({
        effectId: ctx.effectId,
        secretRef: ctx.config.github.secretRef,
        envName: "GH_TOKEN",
        purpose: `Read checks for ${repo}#${pullRequest}`,
        command: process.execPath,
        args: ["-e", GITHUB_CHECKS_CHILD],
        env: {
            ...ctx.env,
            UCP_GITHUB_REPOSITORY: repo,
            UCP_GITHUB_PULL_REQUEST: String(pullRequest),
        },
        timeoutMs: 30_000,
        maxBytes: 256 * 1024,
        grants: ctx.grants,
    });
    ctx.secretUses.push(result.audit);
    if (result.process.code !== 0 || result.process.truncated)
        throw new UcpDeniedError("GITHUB_CHECKS_READ_FAILED", "GitHub checks could not be read");
    let checks;
    try {
        checks = JSON.parse(result.process.stdout);
    }
    catch {
        throw new UcpDeniedError("GITHUB_CHECKS_INVALID", "GitHub returned invalid checks JSON");
    }
    const safe = redactExternal(checks);
    const safeRecord = record(safe, "GitHub checks");
    if (safeRecord.headSha !== expectedHeadSha) {
        throw new UcpDeniedError("GITHUB_CHECKS_HEAD_MISMATCH", "GitHub pull request head no longer matches the expected reviewed SHA");
    }
    const runs = Array.isArray(safeRecord.checks) ? safeRecord.checks : [];
    const failures = runs
        ? runs.filter((item) => item && typeof item === "object" && ["failure", "cancelled", "timed_out", "action_required"].includes(String(item.conclusion))).length
        : 0;
    return { status: "succeeded", summary: "Read GitHub check state for the expected reviewed head without mutation", details: { repository: repo, pullRequest, expectedHeadSha, checkCount: runs.length, failureCount: failures }, output: safe };
}
async function stampRoster(ctx) {
    const path = stateOutputPath(ctx, ctx.input.outputPath, "stamps", "outputPath");
    const packetDigest = stringValue(ctx.input.packetDigest, "packetDigest", 64);
    if (!/^[a-f0-9]{64}$/.test(packetDigest))
        throw new UcpDeniedError("ROSTER_PACKET_DIGEST_INVALID", "packetDigest must be a SHA-256 digest");
    const value = {
        schemaVersion: "excalibur.pattern-a-roster.v1",
        packetDigest,
        roles: ["Fable:story", "Sol:implement", "Opus:T2+", "Terra:verify", "Human:land"],
        externalEffects: [],
        stampedAt: new Date().toISOString(),
    };
    if (ctx.dryRun)
        return { status: "dry_run", summary: "Pattern A roster stamp validated; no file written", details: { packetDigest } };
    await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return { status: "succeeded", summary: "Wrote owner-private Pattern A roster stamp", details: { packetDigest, outputPath: path } };
}
async function benchEffect(ctx) {
    switch (ctx.effectId) {
        case "bench.health": return await benchRead(ctx, "/api/v1/agent/health");
        case "bench.deals.search": {
            const query = encodeURIComponent(stringValue(ctx.input.query, "query", 200));
            const limit = boundedInt(ctx.input.limit ?? 50, "limit", 1, 200);
            return await benchRead(ctx, `/api/v1/agent/deals?search=${query}&limit=${limit}`);
        }
        case "bench.deals.get": {
            const id = encodeURIComponent(stringValue(ctx.input.dealId, "dealId", 256));
            return await benchRead(ctx, `/api/v1/agent/deals/${id}`);
        }
        case "bench.deals.list": {
            const limit = boundedInt(ctx.input.limit ?? 50, "limit", 1, 200);
            const status = ctx.input.status === undefined ? "" : `&status=${encodeURIComponent(stringValue(ctx.input.status, "status", 64))}`;
            return await benchRead(ctx, `/api/v1/agent/deals?limit=${limit}${status}`);
        }
        case "bench.cs.instance_summary": return await benchRead(ctx, "/api/v1/agent/deployment/status");
        default: throw new UcpDeniedError("UCP_EFFECT_NOT_IMPLEMENTED", "Bench effect is not implemented");
    }
}
async function benchCsGrant(ctx) {
    const instanceId = stringValue(ctx.input.instanceId, "instanceId", 128);
    requireBoundInstance(ctx, instanceId);
    const principal = stringValue(ctx.input.principal, "principal", 256);
    const customerSuccessEnabled = ctx.input.customerSuccessEnabled === true;
    if (!customerSuccessEnabled)
        throw new UcpDeniedError("BENCH_CS_GRANT_INVALID", "Customer-success grant dry-run must explicitly enable the scoped flag");
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "CS grant request validated; no tenant mutation ran", details: { instanceId, principal, customerSuccessEnabled, broker: "required" } };
    }
    throw new UcpDeniedError("BENCH_CS_GRANT_BROKER_REQUIRED", "Live CS grant broker is not bound; use the existing web-first admin lifecycle");
}
async function meshControlHealth(ctx) {
    const probe = async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        timer.unref();
        try {
            return (await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal })).status;
        }
        catch {
            return 0;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const [control, derp] = await Promise.all([probe(ctx.config.mesh.controlUrl), probe(ctx.config.mesh.derpUrl)]);
    if (!control || !derp)
        throw new UcpDeniedError("MESH_CONTROL_UNREACHABLE", "Flyway control or DERP public edge is unreachable");
    return { status: "succeeded", summary: "Observed Flyway public control and DERP edges; admin/customer readiness not inferred", details: { controlStatus: control, derpStatus: derp, rawHeadscalePublic: false } };
}
async function meshNodeStatus() {
    const result = await runCaptured("tailscale", ["status", "--json"], { timeoutMs: 5_000, maxBytes: 512 * 1024 });
    if (result.code !== 0)
        throw new UcpDeniedError("MESH_NODE_STATUS_UNAVAILABLE", "Local Tailscale status is unavailable");
    let status;
    try {
        status = JSON.parse(result.stdout);
    }
    catch {
        throw new UcpDeniedError("MESH_NODE_STATUS_INVALID", "Tailscale returned invalid status JSON");
    }
    const safe = redactExternal(status);
    const self = safe && typeof safe === "object" ? safe.Self : null;
    return { status: "succeeded", summary: "Read local Tailscale node status; join does not imply web CS membership", details: { backendState: String(safe?.BackendState || "unknown"), selfObserved: Boolean(self) }, output: self };
}
async function meshPreauth(ctx) {
    const instanceId = stringValue(ctx.input.instanceId, "instanceId", 128);
    requireBoundInstance(ctx, instanceId);
    const userId = stringValue(ctx.input.headscaleUserId, "headscaleUserId", 32);
    if (!/^[1-9]\d*$/.test(userId))
        throw new UcpDeniedError("MESH_USER_ID_INVALID", "Headscale user must be a tenant-resolved numeric ID");
    if (ctx.input.reusable !== false)
        throw new UcpDeniedError("MESH_REUSABLE_KEY_DENIED", "Preauth keys must be explicitly single-use");
    const ttlSeconds = boundedInt(ctx.input.ttlSeconds, "ttlSeconds", 1, 900);
    const tags = Array.isArray(ctx.input.aclTags) ? ctx.input.aclTags.map((item) => stringValue(item, "aclTag", 128)) : [];
    if (!tags.length || tags.some((item) => !/^tag:tenant-[a-z0-9-]+$/.test(item))) {
        throw new UcpDeniedError("MESH_TENANT_TAG_INVALID", "A tenant-scoped ACL tag is required");
    }
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "Single-use tenant-bound mesh mint validated; no key was minted", details: { instanceId, headscaleUserId: userId, reusable: false, ttlSeconds, tagCount: tags.length, broker: "required" } };
    }
    throw new UcpDeniedError("MESH_PREAUTH_BROKER_REQUIRED", "Mesh preauth mint remains broker-only; no key was created or logged");
}
async function verifyMeshJoin(ctx) {
    if (!ctx.config.mesh.secretRef) {
        throw new UcpDeniedError("MESH_MISSING_CONFIG", `Mesh verification is missing_config; create/reference 1Password item “${ctx.config.mesh.requiredItem}”`, "missing_config");
    }
    const instanceId = stringValue(ctx.input.instanceId, "instanceId", 128);
    requireBoundInstance(ctx, instanceId);
    const nodeName = stringValue(ctx.input.nodeName, "nodeName", 128);
    const expectedTag = stringValue(ctx.input.expectedTag, "expectedTag", 128);
    if (!/^tag:tenant-[a-z0-9-]+$/.test(expectedTag))
        throw new UcpDeniedError("MESH_TENANT_TAG_INVALID", "expectedTag must be tenant-scoped");
    const response = await secretJsonRequest(ctx, {
        secretRef: ctx.config.mesh.secretRef,
        url: `${ctx.config.mesh.controlUrl}/api/v1/node`,
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        purpose: `Verify Headscale join for ${nodeName}`,
    });
    if (response.status !== 200)
        throw new UcpDeniedError("MESH_NODE_LIST_DENIED", `Headscale returned HTTP ${response.status}`);
    const nodes = record(response.body, "Headscale response").nodes;
    if (!Array.isArray(nodes))
        throw new UcpDeniedError("MESH_NODE_LIST_INVALID", "Headscale node list shape is invalid");
    const match = nodes.find((item) => {
        if (!item || typeof item !== "object")
            return false;
        const node = item;
        const name = String(node.givenName || node.name || "");
        const tags = [...(Array.isArray(node.forcedTags) ? node.forcedTags : []), ...(Array.isArray(node.validTags) ? node.validTags : [])];
        return name === nodeName && tags.includes(expectedTag);
    });
    if (!match)
        throw new UcpDeniedError("MESH_CUSTOMER_JOIN_UNVERIFIED", "No live node matched the expected name and tenant tag");
    return {
        status: "succeeded",
        summary: "Verified live Headscale node and tenant tag; Firebase/web CS membership remains separate",
        details: { instanceId, nodeName, expectedTag, online: match.online === true, nodeId: String(match.id || "unknown") },
    };
}
async function mailDoctor(ctx) {
    if (!ctx.config.mail.draftDirectory) {
        throw new UcpDeniedError("MAIL_DRAFT_MISSING_CONFIG", "Mail drafting directory is missing_config; send remains denied", "missing_config");
    }
    const directory = resolve(ctx.config.mail.draftDirectory);
    const info = await lstat(directory).catch(() => null);
    const uid = typeof process.getuid === "function" ? process.getuid() : info?.uid;
    if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
        throw new UcpDeniedError("MAIL_DRAFT_DIRECTORY_UNAVAILABLE", "Mail drafting directory is absent or not owner-private; mail.doctor did not succeed");
    }
    return {
        status: "succeeded",
        summary: "Inspected local mail drafting readiness; no mailbox or message content was read",
        details: { draftDirectory: directory, draftReady: true, sendReady: false, externalSend: false },
    };
}
async function mailDraft(ctx) {
    if (!ctx.config.mail.draftDirectory)
        throw new UcpDeniedError("MAIL_DRAFT_MISSING_CONFIG", "Mail draft directory is missing_config", "missing_config");
    const to = Array.isArray(ctx.input.to) ? ctx.input.to.map((item) => stringValue(item, "to", 320)) : [];
    if (!to.length || to.length > 10 || to.some((item) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))) {
        throw new UcpDeniedError("MAIL_DRAFT_RECIPIENT_INVALID", "Draft recipients are invalid");
    }
    const subject = stringValue(ctx.input.subject, "subject", 240);
    const body = safeBody(ctx.input.body, "body", 128_000);
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.eml`;
    const path = resolve(ctx.config.mail.draftDirectory, fileName);
    if (!isInside(ctx.config.mail.draftDirectory, path))
        throw new UcpDeniedError("MAIL_DRAFT_PATH_DENIED", "Mail draft path escaped its configured directory");
    if (ctx.dryRun) {
        return { status: "dry_run", summary: "Mail draft validated; no file was written and nothing was sent", details: { recipientCount: to.length, subjectLength: subject.length, externalSend: false } };
    }
    const content = `To: ${to.join(", ")}\nSubject: ${subject}\nX-Excalibur-Status: draft-only\n\n${body}\n`;
    await writePrivateFile(path, content);
    return { status: "succeeded", summary: "Wrote owner-private draft; no external send occurred", details: { recipientCount: to.length, draftPath: path, externalSend: false } };
}
async function receiptMarker(ctx) {
    const purpose = stringValue(ctx.input.purpose, "purpose", 240);
    return { status: "succeeded", summary: "Recorded value-free operator marker", details: { purpose, markerDigest: requestDigest({ purpose }) } };
}
export async function runAdapter(ctx) {
    switch (ctx.effectId) {
        case "worktree.prepare": return await worktreePrepare(ctx);
        case "packet.freeze": return await packetFreeze(ctx);
        case "seat.dispatch": return await seatDispatch(ctx);
        case "github.watch_checks": return await watchChecks(ctx);
        case "stamp.roster": return await stampRoster(ctx);
        case "bench.health":
        case "bench.deals.search":
        case "bench.deals.get":
        case "bench.deals.list":
        case "bench.cs.instance_summary": return await benchEffect(ctx);
        case "bench.cs.grant": return await benchCsGrant(ctx);
        case "mesh.control_health": return await meshControlHealth(ctx);
        case "mesh.node_status": return await meshNodeStatus();
        case "mesh.preauth.mint": return await meshPreauth(ctx);
        case "mesh.verify_customer_join": return await verifyMeshJoin(ctx);
        case "mail.doctor": return await mailDoctor(ctx);
        case "mail.draft": return await mailDraft(ctx);
        case "mail.send": throw new UcpDeniedError("MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED", "External mail send remains denied; a separate second-grant broker is not shipped");
        case "session.health_card": {
            const card = await collectSessionHealthCard({ env: ctx.env, gatekeeper: ctx.gatekeeper });
            return { status: "succeeded", summary: "Collected observe-only UCP health card", details: { blockerCount: card.blockers.length, fullyReady: card.blockers.length === 0 }, output: card };
        }
        case "receipt.write": return await receiptMarker(ctx);
        default: throw new UcpDeniedError("UCP_EFFECT_NOT_IMPLEMENTED", "Effect adapter is not implemented");
    }
}
