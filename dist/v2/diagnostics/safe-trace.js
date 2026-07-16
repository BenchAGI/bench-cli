import { chmod, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|nonce|api[-_]?key|cloudAuth)/i;
const CONTENT_KEY = /^(?:message|text|content|prompt|input|output|result|raw|data|payload|arguments|args)$/i;
function boundedTtl(value) {
    if (!Number.isFinite(value) || Number(value) <= 0)
        return DEFAULT_TTL_MS;
    return Math.min(MAX_TTL_MS, Math.max(60_000, Number(value)));
}
function redactString(value) {
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
        .replace(/\b(?:bench|sk|xai|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g, REDACTED)
        .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
        .slice(0, 8_192);
}
export function redactTraceValue(value, key = "") {
    if (SENSITIVE_KEY.test(key) || CONTENT_KEY.test(key))
        return REDACTED;
    if (typeof value === "string")
        return redactString(value);
    if (Array.isArray(value))
        return value.slice(0, 128).map((item) => redactTraceValue(item));
    if (!value || typeof value !== "object")
        return value;
    const out = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 128)) {
        out[childKey] = redactTraceValue(child, childKey);
    }
    return out;
}
export function redactRawFrame(raw) {
    try {
        return redactTraceValue(JSON.parse(raw));
    }
    catch {
        // Unstructured bytes have no trustworthy field boundary, so a preview
        // cannot be proven content-free. Retain only the diagnostic size.
        return { unparsable: true, bytes: Buffer.byteLength(raw) };
    }
}
/**
 * Append-only diagnostic trace with intentionally lossy payload redaction.
 * The file is private, carries an expiry on every record, and is truncated on
 * first use if its prior mtime is older than the configured TTL.
 */
export class SafeTraceWriter {
    path;
    ttlMs;
    now;
    initPromise = null;
    queue = Promise.resolve();
    rotateAt = 0;
    constructor(path, opts = {}) {
        this.path = resolve(path);
        this.ttlMs = boundedTtl(opts.ttlMs);
        this.now = opts.now ?? Date.now;
    }
    append(direction, raw) {
        this.queue = this.queue
            .then(async () => {
            await this.ensureReady();
            await this.rotateIfExpired();
            const createdAt = new Date(this.now()).toISOString();
            const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
            const record = {
                schema: "excalibur-safe-trace-v1",
                createdAt,
                expiresAt,
                direction,
                frame: redactRawFrame(raw),
            };
            const handle = await open(this.path, "a", 0o600);
            try {
                await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
            }
            finally {
                await handle.close();
            }
            await chmod(this.path, 0o600);
        })
            .catch(() => {
            // Diagnostics are best-effort and must never terminate a session.
        });
    }
    async flush() {
        await this.queue;
    }
    async ensureReady() {
        if (!this.initPromise)
            this.initPromise = this.initialize();
        await this.initPromise;
    }
    async initialize() {
        const dir = dirname(this.path);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // The caller may choose an existing shared parent such as /tmp. Never
        // change that directory's mode; privacy is enforced on the trace itself.
        try {
            const info = await stat(this.path);
            const firstCreatedAt = await this.readFirstCreatedAt();
            const origin = firstCreatedAt ?? info.mtimeMs;
            if (this.now() - origin >= this.ttlMs)
                await unlink(this.path);
            else
                this.rotateAt = origin + this.ttlMs;
        }
        catch {
            // Missing trace is the normal first-run case.
        }
        const handle = await open(this.path, "a", 0o600);
        await handle.close();
        await chmod(this.path, 0o600);
        if (!this.rotateAt)
            this.rotateAt = this.now() + this.ttlMs;
    }
    async rotateIfExpired() {
        if (this.now() < this.rotateAt)
            return;
        const handle = await open(this.path, "w", 0o600);
        await handle.close();
        await chmod(this.path, 0o600);
        this.rotateAt = this.now() + this.ttlMs;
    }
    async readFirstCreatedAt() {
        const handle = await open(this.path, "r");
        try {
            const buffer = Buffer.alloc(4_096);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]?.trim();
            if (!line)
                return null;
            const parsed = JSON.parse(line);
            const value = Date.parse(String(parsed.createdAt || ""));
            return Number.isFinite(value) ? value : null;
        }
        catch {
            return null;
        }
        finally {
            await handle.close();
        }
    }
}
