import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
export const OPERATOR_MEMORY_SCHEMA_VERSION = "excalibur.operator-memory.v1";
const MAX_CONFIG_BYTES = 4 * 1024;
export class OperatorMemoryConfigError extends Error {
    exitCode;
    constructor(message, options = {}, exitCode = 13) {
        super(message, options);
        this.name = "OperatorMemoryConfigError";
        this.exitCode = exitCode;
    }
}
function privateText(value, label, maximum) {
    if (typeof value !== "string")
        throw new OperatorMemoryConfigError(`${label} must be a string`);
    const text = value.trim();
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new OperatorMemoryConfigError(`${label} is malformed`);
    }
    return text;
}
function normalizeShelfPath(value) {
    const shelfPath = privateText(value, "operator memory shelf path", 2_048);
    if (!isAbsolute(shelfPath) || basename(shelfPath) !== "SESSION_LANDMARKS.md") {
        throw new OperatorMemoryConfigError("operator memory shelf must be an absolute SESSION_LANDMARKS.md path");
    }
    return resolve(shelfPath);
}
export function parseOperatorMemoryConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OperatorMemoryConfigError("operator memory configuration must be an object");
    }
    const raw = value;
    const expected = ["schemaVersion", "enabled", "adapter", "shelfPath"].sort();
    const actual = Object.keys(raw).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new OperatorMemoryConfigError("operator memory configuration has unexpected fields");
    }
    if (raw.schemaVersion !== OPERATOR_MEMORY_SCHEMA_VERSION || raw.adapter !== "aurelius_local"
        || typeof raw.enabled !== "boolean") {
        throw new OperatorMemoryConfigError("operator memory configuration has an unsupported schema or adapter");
    }
    return {
        schemaVersion: OPERATOR_MEMORY_SCHEMA_VERSION,
        enabled: raw.enabled,
        adapter: "aurelius_local",
        shelfPath: normalizeShelfPath(raw.shelfPath),
    };
}
export function operatorMemoryConfigPath(env = process.env) {
    const configured = env.EXCALIBUR_OPERATOR_MEMORY_CONFIG?.trim();
    if (configured)
        return resolve(configured);
    return join(env.HOME || homedir(), ".config", "excalibur", "v1", "operator-memory.json");
}
function stableIdentity(info) {
    return [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(":");
}
export async function readOperatorMemoryConfig(env = process.env) {
    const path = operatorMemoryConfigPath(env);
    let handle = null;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const before = await handle.stat();
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_CONFIG_BYTES
            || (uid !== null && before.uid !== uid) || (before.mode & 0o777) !== 0o600) {
            throw new OperatorMemoryConfigError("operator memory configuration must be an owner-only 0600 regular file");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (stableIdentity(before) !== stableIdentity(after) || bytes.length !== before.size) {
            throw new OperatorMemoryConfigError("operator memory configuration changed while it was being read");
        }
        let raw;
        try {
            raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        }
        catch (error) {
            throw new OperatorMemoryConfigError("operator memory configuration is not valid UTF-8 JSON", { cause: error });
        }
        return { path, state: "configured", config: parseOperatorMemoryConfig(raw), mode: before.mode & 0o777 };
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return { path, state: "missing", config: null, mode: null };
        }
        if (error instanceof OperatorMemoryConfigError)
            throw error;
        throw new OperatorMemoryConfigError("operator memory configuration could not be read safely", { cause: error });
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function ensurePrivateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid)) {
        throw new OperatorMemoryConfigError("operator memory configuration directory is unsafe");
    }
    await chmod(path, 0o700);
}
export async function writeOperatorMemoryConfig(value, env = process.env) {
    const config = parseOperatorMemoryConfig(value);
    const path = operatorMemoryConfigPath(env);
    const directory = dirname(path);
    await ensurePrivateDirectory(directory);
    const temporary = join(directory, `.operator-memory.${process.pid}.${randomUUID()}.tmp`);
    let handle = null;
    try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
    }
    finally {
        await handle?.close().catch(() => { });
        await unlink(temporary).catch(() => { });
    }
    return await readOperatorMemoryConfig(env);
}
export function parseOperatorMemoryConfigureArgs(args) {
    let shelfPath = null;
    const remaining = [...args];
    const index = remaining.findIndex((item) => item === "--shelf" || item.startsWith("--shelf="));
    if (index >= 0) {
        const token = remaining[index];
        if (token === "--shelf") {
            shelfPath = remaining[index + 1] || null;
            remaining.splice(index, 2);
        }
        else {
            shelfPath = token.slice("--shelf=".length);
            remaining.splice(index, 1);
        }
    }
    if (remaining.length || !shelfPath) {
        throw new OperatorMemoryConfigError("usage: excalibur memory configure --shelf <absolute SESSION_LANDMARKS.md>", {}, 2);
    }
    return parseOperatorMemoryConfig({
        schemaVersion: OPERATOR_MEMORY_SCHEMA_VERSION,
        enabled: true,
        adapter: "aurelius_local",
        shelfPath,
    });
}
export async function disableOperatorMemory(env = process.env) {
    const current = await readOperatorMemoryConfig(env);
    if (!current.config)
        return current;
    return await writeOperatorMemoryConfig({ ...current.config, enabled: false }, env);
}
export function renderOperatorMemoryStatus(result) {
    if (!result.config) {
        return [
            "Operator memory · not configured",
            `  file: ${result.path}`,
            "  configure an absolute SESSION_LANDMARKS.md shelf; tenant threads never fall back to it",
        ];
    }
    return [
        `Operator memory · ${result.config.enabled ? "enabled" : "disabled"}`,
        "  adapter: aurelius_local · shelf: configured (hidden)",
        `  file: ${result.path} · mode: ${(result.mode ?? 0).toString(8).padStart(4, "0")}`,
        "  scope: operator thread only · tenant fallback disabled · native model memory disabled",
    ];
}
