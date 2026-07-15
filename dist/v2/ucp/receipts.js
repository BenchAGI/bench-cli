import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { UCP_SCHEMA_VERSION, UcpDeniedError, } from "./types.js";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SENSITIVE_DETAIL_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)/i;
const RECEIPT_KEYS = new Set([
    "schemaVersion", "receiptId", "effectId", "effectClass", "requestDigest", "status", "dryRun",
    "startedAt", "completedAt", "principal", "capabilityModes", "grantIds", "secretUses", "summary",
    "details", "denialCode",
]);
const EFFECT_CLASSES = new Set([
    "session", "local-prepare", "orchestra", "publish-draft", "bench-read", "tenant-mutation",
    "mesh-read", "mesh-mutation", "outbound-draft", "outbound-send",
]);
const EFFECT_STATUSES = new Set(["started", "succeeded", "dry_run", "denied", "missing_config", "failed"]);
const CAPABILITY_MODES = new Set(["observe", "prepare", "secret-use", "mutate-tenant", "publish-draft", "outbound-draft"]);
function canonical(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new UcpDeniedError("UCP_REQUEST_INVALID", "Effect input contains a non-finite number");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (typeof value !== "object")
        throw new UcpDeniedError("UCP_REQUEST_INVALID", "Effect input must be JSON-compatible");
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export function requestDigest(value) {
    const payload = canonical(value);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
        throw new UcpDeniedError("UCP_REQUEST_TOO_LARGE", "Effect input exceeds the bounded request size");
    }
    return createHash("sha256").update(payload).digest("hex");
}
export function ucpStateRoot(env = process.env) {
    return env.EXCALIBUR_UCP_STATE_DIR?.trim()
        || join(env.HOME?.trim() || homedir(), ".local", "state", "excalibur", "ucp");
}
export function receiptDirectory(env = process.env) {
    return join(ucpStateRoot(env), "state", "effects");
}
export function currentPrincipal() {
    try {
        return userInfo().username;
    }
    catch {
        return "local-operator";
    }
}
function safeString(value, maximum) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new UcpDeniedError("UCP_RECEIPT_UNSAFE", "Effect attempted to write unsafe receipt text");
    }
    if (/\b(?:Bearer\s+[A-Za-z0-9._~-]+|gh[opsu]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(trimmed)) {
        throw new UcpDeniedError("UCP_RECEIPT_SECRET_DENIED", "Effect attempted to place credential-shaped material in a receipt");
    }
    try {
        const parsed = new URL(trimmed);
        if (parsed.username || parsed.password) {
            throw new UcpDeniedError("UCP_RECEIPT_SECRET_DENIED", "Credential-bearing URLs are forbidden in receipts");
        }
        for (const key of parsed.searchParams.keys()) {
            if (SENSITIVE_DETAIL_KEY.test(key)) {
                throw new UcpDeniedError("UCP_RECEIPT_SECRET_DENIED", "Credential-bearing URLs are forbidden in receipts");
            }
        }
    }
    catch (error) {
        if (error instanceof UcpDeniedError)
            throw error;
        // Ordinary non-URL receipt text is expected.
    }
    return trimmed;
}
export function sanitizeReceiptDetails(details) {
    const output = {};
    for (const [key, value] of Object.entries(details || {})) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || SENSITIVE_DETAIL_KEY.test(key)) {
            throw new UcpDeniedError("UCP_RECEIPT_UNSAFE", "Effect attempted to write a disallowed receipt field");
        }
        if (typeof value === "string")
            output[key] = safeString(value, 2_048);
        else if (value === null || typeof value === "boolean")
            output[key] = value;
        else if (typeof value === "number" && Number.isFinite(value))
            output[key] = value;
        else
            throw new UcpDeniedError("UCP_RECEIPT_UNSAFE", "Effect attempted to write a non-scalar receipt field");
    }
    return output;
}
function validReceipt(value, expectedReceiptId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const receipt = value;
    const keys = Object.keys(value);
    const startedAt = Date.parse(receipt.startedAt);
    const completedAt = Date.parse(receipt.completedAt);
    if (keys.length !== RECEIPT_KEYS.size || keys.some((key) => !RECEIPT_KEYS.has(key)))
        return false;
    if (receipt.schemaVersion !== UCP_SCHEMA_VERSION
        || receipt.receiptId !== expectedReceiptId
        || !/^[0-9a-f-]{36}$/.test(receipt.receiptId)
        || !/^[a-z][a-z0-9_.-]{2,80}$/.test(receipt.effectId)
        || !EFFECT_CLASSES.has(receipt.effectClass)
        || !/^[a-f0-9]{64}$/.test(receipt.requestDigest)
        || !EFFECT_STATUSES.has(receipt.status)
        || typeof receipt.dryRun !== "boolean"
        || (receipt.status === "dry_run" && receipt.dryRun !== true)
        || !Number.isFinite(startedAt)
        || !Number.isFinite(completedAt)
        || completedAt < startedAt
        || typeof receipt.principal !== "string"
        || receipt.principal.length < 1
        || receipt.principal.length > 256
        || typeof receipt.summary !== "string"
        || receipt.summary.length < 1
        || receipt.summary.length > 500
        || (receipt.denialCode !== null && (typeof receipt.denialCode !== "string" || !/^[A-Z][A-Z0-9_]{2,100}$/.test(receipt.denialCode)))) {
        return false;
    }
    if (!Array.isArray(receipt.capabilityModes)
        || receipt.capabilityModes.some((mode) => !CAPABILITY_MODES.has(mode))
        || !Array.isArray(receipt.grantIds)
        || receipt.grantIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))
        || !Array.isArray(receipt.secretUses)
        || receipt.secretUses.some((item) => !item || typeof item !== "object"
            || typeof item.reference !== "string" || item.reference.length < 1 || item.reference.length > 512
            || typeof item.purpose !== "string" || item.purpose.length < 1 || item.purpose.length > 240
            || !["per_access", "mission_bundle"].includes(item.presence)
            || !Number.isInteger(item.ttlSeconds) || item.ttlSeconds < 0 || item.ttlSeconds > 900)) {
        return false;
    }
    if (!receipt.details || typeof receipt.details !== "object" || Array.isArray(receipt.details))
        return false;
    try {
        if (safeString(receipt.principal, 256) !== receipt.principal
            || safeString(receipt.summary, 500) !== receipt.summary)
            return false;
        for (const item of receipt.secretUses) {
            if (safeString(item.reference, 512) !== item.reference
                || safeString(item.purpose, 240) !== item.purpose)
                return false;
        }
        sanitizeReceiptDetails(receipt.details);
    }
    catch {
        return false;
    }
    return true;
}
async function privateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
        throw new UcpDeniedError("UCP_RECEIPT_STORE_UNSAFE", "Receipt storage must be an owner-private, non-symlinked directory");
    }
}
async function atomicPrivateJson(path, value) {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_RECEIPT_BYTES) {
        throw new UcpDeniedError("UCP_RECEIPT_TOO_LARGE", "Receipt exceeds the bounded receipt size");
    }
    await privateDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
export class ReceiptStore {
    env;
    constructor(env = process.env) {
        this.env = env;
    }
    async write(receipt) {
        const normalized = {
            ...receipt,
            schemaVersion: UCP_SCHEMA_VERSION,
            summary: safeString(receipt.summary, 500),
            details: sanitizeReceiptDetails(receipt.details),
            secretUses: receipt.secretUses.map((item) => ({
                reference: safeString(item.reference, 512),
                purpose: safeString(item.purpose, 240),
                presence: item.presence,
                ttlSeconds: item.ttlSeconds,
            })),
        };
        if (!validReceipt(normalized, normalized.receiptId)) {
            throw new UcpDeniedError("UCP_RECEIPT_INVALID", "Effect attempted to write a structurally invalid receipt");
        }
        const path = join(receiptDirectory(this.env), `${normalized.receiptId}.json`);
        await atomicPrivateJson(path, normalized);
        return path;
    }
    async list(limit = 100) {
        const directory = receiptDirectory(this.env);
        const directoryInfo = await lstat(directory).catch(() => null);
        const uid = typeof process.getuid === "function" ? process.getuid() : directoryInfo?.uid;
        if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
            || directoryInfo.uid !== uid || (directoryInfo.mode & 0o077) !== 0)
            return [];
        let names;
        try {
            names = await readdir(directory);
        }
        catch {
            return [];
        }
        const receipts = [];
        for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item)).sort().reverse().slice(0, limit)) {
            const path = join(directory, name);
            const info = await lstat(path).catch(() => null);
            if (!info?.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > MAX_RECEIPT_BYTES)
                continue;
            try {
                const parsed = JSON.parse(await readFile(path, "utf8"));
                if (validReceipt(parsed, name.slice(0, -5)))
                    receipts.push(parsed);
            }
            catch {
                // A malformed receipt is ignored rather than trusted.
            }
        }
        return receipts;
    }
}
export function newReceiptId() {
    return randomUUID();
}
