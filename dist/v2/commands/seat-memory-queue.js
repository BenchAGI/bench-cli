// seat-memory-queue — durable promotion of local-seat (Claude Code) workspace
// memory into native OpenClaw agent memory.
//
// Background: a local Claude Code seat writes "durable memories" with its Write
// tool into ~/.claude/projects/<slug>/memory/*.md. Those files are NOT native
// OpenClaw agent memory, so `openclaw memory search --agent <id>` never finds
// them. This module records a durable intent whenever such a file is written,
// and drains the queue by invoking `openclaw memory promote-file`, which writes
// the file into the agent's configured native memory and reindexes it.
//
// Correctness lives in the queue + retry, never in a hook's timeout budget:
// PostToolUse enqueues (fast), session_stop/session_start drain best-effort, and
// a launchd backstop drains on an interval. Promotion is idempotent end-to-end,
// so duplicate triggers are safe.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
const MEMORY_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Matches a Claude Code workspace-memory file path (incl. MEMORY.md).
const MEMORY_FILE_RE = /\.claude\/projects\/[^/]+\/memory\/[^/]*\.md$/i;
const MAX_ATTEMPTS = 8;
const DEFAULT_HOOK_DRAIN_TIMEOUT_MS = 8_000;
const DEFAULT_BACKFILL_TIMEOUT_MS = 120_000;
// --- shared helpers ----------------------------------------------------------
// Linear edge-trim; the `/^_+|_+$/`-style alternations here were flagged as
// polynomial ReDoS (CodeQL js/polynomial-redos) on long runs of the trim char.
function trimEdgeChars(value, chars) {
    let start = 0;
    let end = value.length;
    while (start < end && chars.includes(value[start]))
        start++;
    while (end > start && chars.includes(value[end - 1]))
        end--;
    return value.slice(start, end);
}
export function safeSegment(value) {
    return trimEdgeChars(value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_"), "_") || "unknown";
}
/** sha256 of normalized content — MUST match memory-core promote-file.contentHashOf. */
export function contentHashOf(content) {
    const normalized = content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[\t ]+$/, ""))
        .join("\n")
        .replace(/\n+$/, "\n")
        .trim();
    return createHash("sha256").update(normalized).digest("hex");
}
function slugForSourceFile(filePath) {
    const base = basename(filePath).replace(/\.md$/i, "");
    const slug = trimEdgeChars(base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), "-.")
        .slice(0, 120);
    return slug || "memory";
}
function configRoot() {
    return (process.env.BENCHAGI_CONFIG_DIR?.trim() || join(homedir(), ".config", "benchagi"));
}
export function seatMemoryQueueDir(agentId) {
    const base = process.env.BENCHAGI_SEAT_PROMOTIONS_DIR?.trim() ||
        join(configRoot(), "seat-promotions");
    return join(base, safeSegment(agentId));
}
// --- queue I/O ---------------------------------------------------------------
function recordPath(agentId, slug) {
    return join(seatMemoryQueueDir(agentId), `${slug}.json`);
}
function readRecord(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function writeRecord(record) {
    const dir = seatMemoryQueueDir(record.agentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${record.sourceSlug}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return file;
}
export function listSeatMemoryRecords(agentId) {
    const dir = seatMemoryQueueDir(agentId);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        const record = readRecord(join(dir, name));
        if (record)
            out.push(record);
    }
    return out;
}
// --- detection + enqueue -----------------------------------------------------
function parsePayload(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return {};
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return {};
    }
}
function readField(payload, keys) {
    if (!payload || typeof payload !== "object")
        return undefined;
    const record = payload;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return undefined;
}
/**
 * Inspect a PostToolUse hook payload; return the written Claude-memory file path
 * when the tool is a Write/Edit/MultiEdit/NotebookEdit targeting a memory file.
 */
export function detectSeatMemoryWrite(rawHookPayload) {
    const payload = parsePayload(rawHookPayload);
    const toolName = readField(payload, ["tool_name", "toolName", "name"]);
    if (!toolName || !MEMORY_TOOLS.has(toolName))
        return null;
    const toolInput = payload && typeof payload === "object"
        ? (payload.tool_input ??
            payload.toolInput)
        : undefined;
    const filePath = readField(toolInput, ["file_path", "filePath", "path", "notebook_path"]) ??
        readField(payload, ["file_path", "filePath"]);
    if (!filePath || !MEMORY_FILE_RE.test(filePath))
        return null;
    return { filePath };
}
/** Derive the Claude Code project-memory dir from a hook payload or the cwd. */
export function resolveClaudeMemoryDir(params) {
    const { rawHookPayload, cwd } = params;
    if (rawHookPayload) {
        const transcript = readField(parsePayload(rawHookPayload), [
            "transcript_path",
            "transcriptPath",
        ]);
        if (transcript) {
            const dir = join(dirname(transcript), "memory");
            if (existsSync(dir))
                return dir;
        }
    }
    const seatCwd = cwd?.trim() || process.env.BENCHAGI_SEAT_CWD?.trim();
    if (seatCwd) {
        // Claude Code encodes the project dir slug by replacing "/" and "." with "-".
        const slug = seatCwd.replace(/[/.]/g, "-");
        return join(homedir(), ".claude", "projects", slug, "memory");
    }
    return null;
}
function nowMs() {
    return Date.now();
}
/** Upsert a pending intent for a single memory file (idempotent by content). */
export function enqueueMemoryFile(ctx, filePath) {
    let content;
    try {
        content = readFileSync(filePath, "utf8");
    }
    catch {
        return null;
    }
    const slug = slugForSourceFile(filePath);
    const hash = contentHashOf(content);
    const existing = readRecord(recordPath(ctx.agentId, slug));
    if (existing && existing.sourcePath === filePath && existing.sourceHash === hash) {
        // Same content already tracked: keep promoted/pending/poisoned state as-is.
        return existing;
    }
    const record = {
        schemaVersion: 1,
        agentId: ctx.agentId,
        seatKind: ctx.seatKind,
        seatSessionId: ctx.seatSessionId,
        sourcePath: filePath,
        sourceSlug: slug,
        sourceHash: hash,
        detectedAt: nowMs(),
        state: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        promotedAt: null,
        targetPath: null,
    };
    writeRecord(record);
    return record;
}
/** Scan a Claude-memory dir and enqueue every *.md file. Returns enqueued count. */
export function scanAndEnqueue(ctx, memoryDir) {
    let names;
    try {
        names = readdirSync(memoryDir);
    }
    catch {
        return 0;
    }
    let count = 0;
    for (const name of names) {
        if (!name.toLowerCase().endsWith(".md"))
            continue;
        const full = join(memoryDir, name);
        try {
            if (!statSync(full).isFile())
                continue;
        }
        catch {
            continue;
        }
        if (enqueueMemoryFile(ctx, full))
            count += 1;
    }
    return count;
}
// --- openclaw bin resolution + promotion -------------------------------------
export function resolveOpenclawBin(explicit) {
    const candidates = [
        explicit?.trim(),
        process.env.BENCHAGI_OPENCLAW_BIN?.trim(),
    ].filter((value) => Boolean(value));
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    const which = spawnSync("which", ["openclaw"], { encoding: "utf8" });
    const found = which.status === 0 ? which.stdout.trim().split("\n")[0]?.trim() : "";
    if (found && existsSync(found))
        return found;
    for (const fallback of ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]) {
        if (existsSync(fallback))
            return fallback;
    }
    return null;
}
function runPromoteCli(params) {
    const args = [
        "memory",
        "promote-file",
        "--from-dir",
        params.memoryDir,
        "--agent",
        params.agentId,
        "--source-agent",
        params.agentId,
        "--source-label",
        "claude-code-seat",
        "--json",
    ];
    if (params.seatKind)
        args.push("--seat-kind", params.seatKind);
    if (params.force)
        args.push("--force");
    const proc = spawnSync(params.openclawBin, args, {
        encoding: "utf8",
        timeout: params.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (proc.error || proc.status !== 0) {
        return {
            ok: false,
            results: [],
            error: proc.error
                ? proc.error.message
                : `openclaw exited ${proc.status ?? "?"}: ${(proc.stderr ?? "").slice(0, 400)}`,
        };
    }
    try {
        const parsed = JSON.parse(proc.stdout || "{}");
        return { ok: true, results: Array.isArray(parsed.results) ? parsed.results : [] };
    }
    catch (err) {
        return { ok: false, results: [], error: `unparseable promote-file output: ${String(err)}` };
    }
}
function markRecord(record, outcome) {
    record.attempts += 1;
    record.lastAttemptAt = nowMs();
    if (!outcome.ok) {
        record.lastError = outcome.error ?? "promote failed";
        record.state = "pending";
        writeRecord(record);
        return;
    }
    const match = outcome.results.find((entry) => entry.contentHash === record.sourceHash);
    if (!match) {
        record.lastError = "no matching promote-file result";
        record.state = record.attempts >= MAX_ATTEMPTS ? "poisoned" : "pending";
        writeRecord(record);
        return;
    }
    if (match.status === "created" || match.status === "updated" || match.status === "unchanged") {
        record.state = "promoted";
        record.promotedAt = nowMs();
        record.targetPath = match.target ?? null;
        record.lastError = null;
    }
    else {
        // secret-blocked / skipped-handauthored are terminal; do not retry forever.
        record.state = "failed";
        record.lastError = `terminal:${match.status}${match.reason ? `:${match.reason}` : ""}`;
    }
    writeRecord(record);
}
/**
 * Drain pending records by invoking `openclaw memory
 * promote-file --from-dir` once per dirty memory dir, then update record state.
 * Best-effort: on any failure the records stay pending for the next retry.
 */
export function drainSeatMemoryQueue(params) {
    const records = listSeatMemoryRecords(params.agentId).filter((r) => r.state === "pending");
    if (records.length === 0)
        return { drained: 0, ok: true, promoted: 0 };
    const openclawBin = resolveOpenclawBin(params.openclawBin);
    if (!openclawBin) {
        for (const record of records) {
            record.attempts += 1;
            record.lastAttemptAt = nowMs();
            record.lastError = "openclaw-not-found";
            record.state = "pending";
            writeRecord(record);
        }
        return { drained: 0, ok: false, promoted: 0, error: "openclaw-not-found" };
    }
    const byDir = new Map();
    for (const record of records) {
        const dir = dirname(record.sourcePath);
        const group = byDir.get(dir) ?? [];
        group.push(record);
        byDir.set(dir, group);
    }
    let promoted = 0;
    let ok = true;
    let lastError;
    for (const [dir, group] of byDir) {
        const outcome = runPromoteCli({
            openclawBin,
            memoryDir: dir,
            agentId: params.agentId,
            seatKind: params.seatKind ?? group[0]?.seatKind,
            force: Boolean(params.force),
            timeoutMs: params.timeoutMs ?? DEFAULT_HOOK_DRAIN_TIMEOUT_MS,
        });
        if (!outcome.ok) {
            ok = false;
            lastError = outcome.error;
        }
        for (const record of group) {
            const before = record.state;
            markRecord(record, outcome);
            if (record.state === "promoted" && before !== "promoted")
                promoted += 1;
        }
    }
    return { drained: records.length, ok, promoted, error: lastError };
}
// --- backfill ----------------------------------------------------------------
/**
 * One-shot promotion of every existing memory file in the seat's Claude memory
 * dir (used by `benchagi seat-bridge backfill`). Forces a reindex.
 */
export function backfillSeatMemory(params) {
    const memoryDir = params.memoryDir?.trim() || resolveClaudeMemoryDir({ cwd: params.cwd });
    if (!memoryDir || !existsSync(memoryDir)) {
        return { ok: false, memoryDir, results: [], error: "claude-memory-dir-not-found" };
    }
    // Enqueue first so state is durable even if the CLI invocation is interrupted.
    scanAndEnqueue({ agentId: params.agentId, seatKind: params.seatKind }, memoryDir);
    const openclawBin = resolveOpenclawBin(params.openclawBin);
    if (!openclawBin) {
        return { ok: false, memoryDir, results: [], error: "openclaw-not-found" };
    }
    const outcome = runPromoteCli({
        openclawBin,
        memoryDir,
        agentId: params.agentId,
        seatKind: params.seatKind,
        force: true,
        timeoutMs: params.timeoutMs ?? DEFAULT_BACKFILL_TIMEOUT_MS,
    });
    // Reconcile queue records from the backfill outcome.
    for (const record of listSeatMemoryRecords(params.agentId)) {
        if (dirname(record.sourcePath) === memoryDir && record.state !== "promoted") {
            markRecord(record, outcome);
        }
    }
    return { ok: outcome.ok, memoryDir, results: outcome.results, error: outcome.error };
}
