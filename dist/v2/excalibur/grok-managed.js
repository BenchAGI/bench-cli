import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveStateScope, scopeDirectory } from "../state/scope.js";
const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "grok-4.5";
const MANAGED_CONFIG = `[cli]
auto_update = false
use_leader = false

[ui]
permission_mode = "default"
remember_tool_approvals = false

[features]
telemetry = false
feedback = false
lsp_tools = false
codebase_indexing = false

[session]
load_envrc = false

[memory]
enabled = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false

[permission]
rules = [
  { action = "deny", tool = "bash" },
  { action = "deny", tool = "read" },
  { action = "deny", tool = "edit" },
  { action = "deny", tool = "grep" },
  { action = "deny", tool = "mcp" },
  { action = "deny", tool = "webfetch" },
  { action = "deny", tool = "websearch" },
]
`;
const MANAGED_REQUIREMENTS = `[ui]
disable_bypass_permissions_mode = true
yolo = false
`;
const CONDUCTOR_RULES = `# Excalibur managed conductor

You are the conversational conductor for the Excalibur contact surface.

- Operate in advisory, read-only mode. Never execute tools, mutate files, call external systems, or perform customer-data effects.
- Never ask for credentials, tokens, passwords, payment data, or raw customer records.
- Treat the active account and customer instance as hard data boundaries. Do not infer or blend facts across instances.
- Explain any proposed effect and the approval boundary needed to perform it. This preview cannot approve or execute effects.
- Be explicit when current data is unavailable. Never fabricate a successful action, receipt, lookup, or customer state.
`;
function sourceGrokHome(env) {
    return resolve(env.EXCALIBUR_GROK_SOURCE_HOME || join(homedir(), ".grok"));
}
async function executable(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function resolveGrokBinary(env = process.env) {
    const candidates = [];
    if (env.EXCALIBUR_GROK_BIN?.trim())
        candidates.push(resolve(env.EXCALIBUR_GROK_BIN));
    candidates.push(join(sourceGrokHome(env), "bin", "grok"));
    for (const entry of (env.PATH || "").split(delimiter)) {
        if (entry.trim())
            candidates.push(resolve(entry, "grok"));
    }
    for (const candidate of [...new Set(candidates)]) {
        if (await executable(candidate))
            return candidate;
    }
    return null;
}
function collectModelIds(value, into, depth = 0) {
    if (depth > 5 || value == null)
        return;
    if (typeof value === "string") {
        if (/^grok[-_.a-z0-9]+$/i.test(value))
            into.add(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 1_000))
            collectModelIds(item, into, depth + 1);
        return;
    }
    if (typeof value !== "object")
        return;
    for (const [key, child] of Object.entries(value).slice(0, 1_000)) {
        if (/^(?:id|name|model|modelId)$/i.test(key) && typeof child === "string")
            collectModelIds(child, into, depth + 1);
        else
            collectModelIds(child, into, depth + 1);
    }
}
export async function readCachedGrokModels(home) {
    try {
        const parsed = JSON.parse(await readFile(join(home, "models_cache.json"), "utf8"));
        const values = new Set();
        collectModelIds(parsed, values);
        return [...values].sort();
    }
    catch {
        return [];
    }
}
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function privateAtomicWrite(path, data) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => { });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, data, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
        await chmod(path, 0o600);
    }
    finally {
        await unlink(tmp).catch(() => { });
    }
}
async function binaryVersion(binary) {
    const result = await execFileAsync(binary, ["--version"], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
    });
    return String(result.stdout || result.stderr || "unknown").trim().split("\n")[0] || "unknown";
}
export async function inspectGrokProvider(opts = {}) {
    const env = opts.env ?? process.env;
    const model = opts.model?.trim() || env.EXCALIBUR_GROK_MODEL?.trim() || DEFAULT_MODEL;
    const sourceHome = sourceGrokHome(env);
    const binary = await resolveGrokBinary(env);
    const availableModels = await readCachedGrokModels(sourceHome);
    const modelReady = availableModels.includes(model);
    const authReady = await fileExists(join(sourceHome, "auth.json"));
    if (!binary)
        return { ready: false, model, modelReady, authReady, issue: "Grok binary not found" };
    try {
        const version = await binaryVersion(binary);
        if (!modelReady) {
            return {
                ready: false,
                binary,
                version,
                model,
                modelReady,
                authReady,
                issue: `model ${model} is not present in Grok's local model catalog`,
            };
        }
        if (!authReady) {
            return { ready: false, binary, version, model, modelReady, authReady, issue: "Grok authentication is not ready" };
        }
        return { ready: true, binary, version, model, modelReady, authReady };
    }
    catch (error) {
        return {
            ready: false,
            binary,
            model,
            modelReady,
            authReady,
            issue: `Grok preflight failed: ${error.message}`,
        };
    }
}
export async function prepareManagedGrok(opts = {}) {
    const env = opts.env ?? process.env;
    const scope = opts.scope ?? await resolveStateScope({ env });
    const inspection = await inspectGrokProvider(opts);
    if (!inspection.ready || !inspection.binary || !inspection.version) {
        throw Object.assign(new Error(inspection.issue || "Grok is not ready"), { exitCode: 4 });
    }
    const sourceHome = sourceGrokHome(env);
    const managedHome = join(scopeDirectory(scope, env), "providers", "grok");
    const workspace = join(managedHome, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await chmod(managedHome, 0o700).catch(() => { });
    await chmod(workspace, 0o700).catch(() => { });
    await privateAtomicWrite(join(managedHome, "config.toml"), MANAGED_CONFIG);
    await privateAtomicWrite(join(managedHome, "requirements.toml"), MANAGED_REQUIREMENTS);
    await privateAtomicWrite(join(managedHome, "AGENTS.md"), CONDUCTOR_RULES);
    await privateAtomicWrite(join(workspace, "AGENTS.md"), CONDUCTOR_RULES);
    for (const filename of ["auth.json", "models_cache.json"]) {
        const source = join(sourceHome, filename);
        if (await fileExists(source))
            await privateAtomicWrite(join(managedHome, filename), await readFile(source));
    }
    return {
        binary: inspection.binary,
        version: inspection.version,
        model: inspection.model,
        sourceHome,
        managedHome,
        workspace,
        authReady: inspection.authReady,
        availableModels: await readCachedGrokModels(sourceHome),
        scope,
    };
}
export function managedGrokEnvironment(base, paths) {
    return {
        ...base,
        GROK_HOME: paths.managedHome,
        GROK_MEMORY: "0",
        GROK_TELEMETRY_ENABLED: "false",
        GROK_CLAUDE_SKILLS_ENABLED: "false",
        GROK_CLAUDE_RULES_ENABLED: "false",
        GROK_CLAUDE_AGENTS_ENABLED: "false",
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CLAUDE_HOOKS_ENABLED: "false",
        GROK_CURSOR_SKILLS_ENABLED: "false",
        GROK_CURSOR_RULES_ENABLED: "false",
        GROK_CURSOR_AGENTS_ENABLED: "false",
        GROK_CURSOR_MCPS_ENABLED: "false",
        GROK_CURSOR_HOOKS_ENABLED: "false",
    };
}
