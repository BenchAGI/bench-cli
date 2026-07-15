import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { EXCALIBUR_DRAFT_PR_ACTION_ID, } from "./http-transport.js";
export const EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA = "excalibur.pattern-a-broker-config.v1";
export const EXCALIBUR_ORCHESTRA_RESULT_SCHEMA = "excalibur.pattern-a-broker-result.v1";
export const EXCALIBUR_ORCHESTRA_PREFLIGHT_REQUEST_SCHEMA = "excalibur-pattern-a-publication-verifier-preflight-request-v1";
export const EXCALIBUR_ORCHESTRA_PREFLIGHT_RESULT_SCHEMA = "excalibur-pattern-a-publication-verifier-preflight-result-v1";
const MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RECEIPT_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index]);
}
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("broker contract contains a non-finite number");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (isRecord(value)) {
        const keys = Object.keys(value).sort();
        if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
            throw new Error("broker contract contains an unsafe key");
        }
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    throw new Error("broker contract contains an unsupported value");
}
function canonicalSha256(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function boundedText(value, maximum) {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
        && !/[\u0000-\u001f\u007f]/.test(value);
}
async function readBoundedJson(path) {
    let handle = null;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > 16 * 1024) {
            throw new Error("config is not a bounded regular file");
        }
        const operatorUid = typeof process.getuid === "function" ? process.getuid() : null;
        if ((operatorUid !== null && info.uid !== operatorUid) || (info.mode & 0o077) !== 0) {
            throw new Error("config must be owned by the current operator with no group/world permissions");
        }
        return JSON.parse(await handle.readFile("utf8"));
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
function parseConfig(value) {
    if (!isRecord(value)
        || !exactKeys(value, [
            "schemaVersion", "brokerExecutable", "brokerSha256", "resourceSetDigest", "stateRoot",
        ])
        || value.schemaVersion !== EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA
        || !boundedText(value.brokerExecutable, 4_096)
        || !isAbsolute(value.brokerExecutable)
        || typeof value.brokerSha256 !== "string" || !DIGEST_RE.test(value.brokerSha256)
        || typeof value.resourceSetDigest !== "string" || !DIGEST_RE.test(value.resourceSetDigest)
        || !boundedText(value.stateRoot, 4_096) || !isAbsolute(value.stateRoot)) {
        throw new Error("config must pin one absolute broker, its SHA-256, resource-set digest, and state root");
    }
    return value;
}
function parsePreflight(value, expected) {
    if (!isRecord(value) || !exactKeys(value, [
        "schema", "available", "stateRootRealpath", "resourceSetDigest", "attestationDigest",
    ]) || value.schema !== EXCALIBUR_ORCHESTRA_PREFLIGHT_RESULT_SCHEMA
        || value.available !== true
        || value.stateRootRealpath !== expected.stateRoot
        || value.resourceSetDigest !== expected.resourceSetDigest
        || typeof value.attestationDigest !== "string" || !DIGEST_RE.test(value.attestationDigest)) {
        throw new Error("broker preflight did not attest the pinned Pattern A resource set and state root");
    }
    const { attestationDigest, ...attested } = value;
    if (canonicalSha256(attested) !== attestationDigest) {
        throw new Error("broker preflight attestation digest is invalid");
    }
    return attestationDigest;
}
function parsePublicationIntent(value, missionId) {
    if (!isRecord(value) || !exactKeys(value, [
        "intent", "intentDigest", "publicationGateDigest", "actionBindingDigest",
    ]) || !isRecord(value.intent)
        || !exactKeys(value.intent, ["actionId", "target", "payload", "idempotencyKey"])
        || value.intent.actionId !== EXCALIBUR_DRAFT_PR_ACTION_ID
        || !isRecord(value.intent.target) || !isRecord(value.intent.payload)
        || typeof value.intent.idempotencyKey !== "string"
        || !DIGEST_RE.test(String(value.intentDigest || ""))
        || !DIGEST_RE.test(String(value.publicationGateDigest || ""))
        || !DIGEST_RE.test(String(value.actionBindingDigest || ""))
        || value.intent.payload.missionId !== missionId
        || value.intent.payload.publicationGateDigest !== value.publicationGateDigest) {
        throw new Error("broker returned a malformed Pattern A publication intent");
    }
    if (canonicalSha256(value.intent) !== value.intentDigest) {
        throw new Error("broker returned a publication intent with an invalid digest");
    }
    const { publicationGateDigest: _publicationGateDigest, ...boundPayload } = value.intent.payload;
    if (canonicalSha256({
        actionId: value.intent.actionId,
        target: value.intent.target,
        payload: boundPayload,
        idempotencyKey: value.intent.idempotencyKey,
    }) !== value.actionBindingDigest) {
        throw new Error("broker returned a publication intent with an invalid action binding");
    }
    return value;
}
function parseResult(value) {
    if (!isRecord(value)
        || Object.keys(value).sort().join(",") !== "missionDigest,missionId,receiptCounts,schemaVersion,state"
        || value.schemaVersion !== EXCALIBUR_ORCHESTRA_RESULT_SCHEMA
        || typeof value.missionId !== "string" || !MISSION_ID_RE.test(value.missionId)
        || !boundedText(value.state, 128)
        || !isRecord(value.receiptCounts)
        || Object.keys(value.receiptCounts).length > 32
        || typeof value.missionDigest !== "string" || !DIGEST_RE.test(value.missionDigest)) {
        throw new Error("broker returned a malformed Pattern A result");
    }
    const counts = {};
    for (const [name, count] of Object.entries(value.receiptCounts)) {
        if (!RECEIPT_KEY_RE.test(name) || !Number.isSafeInteger(count) || Number(count) < 0) {
            throw new Error("broker returned malformed receipt counts");
        }
        counts[name] = Number(count);
    }
    return { ...value, receiptCounts: counts };
}
async function defaultExecFile(executable, argv, options) {
    return await new Promise((resolve, reject) => {
        const { input, ...execOptions } = options;
        const child = execFile(executable, argv, execOptions, (error, stdout, stderr) => {
            if (error)
                reject(error);
            else
                resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
        child.stdin?.end(input ?? "");
    });
}
function unavailable(reason) {
    return [
        "Orchestra · unavailable",
        `  ${reason}`,
        "  no mission command, model, or external effect was invoked",
    ];
}
async function resolveOwnerPrivateJson(path, label, maximum) {
    if (!isAbsolute(path))
        throw new Error(`${label} JSON path must be absolute`);
    let handle = null;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await handle.stat();
        const operatorUid = typeof process.getuid === "function" ? process.getuid() : null;
        if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > maximum) {
            throw new Error(`${label} JSON must be a bounded regular file`);
        }
        if ((operatorUid !== null && info.uid !== operatorUid) || (info.mode & 0o077) !== 0) {
            throw new Error(`${label} JSON must be owned by the current operator with no group/world permissions`);
        }
    }
    finally {
        await handle?.close().catch(() => { });
    }
    return await realpath(path);
}
export async function resolveOrchestraBrokerConfig(env, options = {}) {
    const configPath = env.EXCALIBUR_ORCHESTRA_CONFIG?.trim();
    if (!configPath) {
        return { reason: "EXCALIBUR_ORCHESTRA_CONFIG is not configured" };
    }
    if (!isAbsolute(configPath)) {
        return { reason: "EXCALIBUR_ORCHESTRA_CONFIG must be an absolute path" };
    }
    try {
        const config = parseConfig(await readBoundedJson(configPath));
        const [canonicalConfigPath, executable, stateRoot] = await Promise.all([
            realpath(configPath),
            realpath(config.brokerExecutable),
            realpath(config.stateRoot),
        ]);
        if (executable !== config.brokerExecutable || stateRoot !== config.stateRoot) {
            throw new Error("broker executable and state root paths must already be canonical realpaths");
        }
        const packagedRelativePath = relative(dirname(canonicalConfigPath), executable);
        if (!packagedRelativePath || packagedRelativePath === ".."
            || packagedRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
            || isAbsolute(packagedRelativePath)) {
            throw new Error("broker executable must be packaged beside or below the orchestra config");
        }
        const info = await stat(executable);
        const operatorUid = typeof process.getuid === "function" ? process.getuid() : null;
        if (!info.isFile())
            throw new Error("broker executable is not a regular file");
        if ((operatorUid !== null && info.uid !== operatorUid) || (info.mode & 0o022) !== 0) {
            throw new Error("broker executable must be operator-owned and not group/world writable");
        }
        await access(executable, constants.X_OK);
        const brokerHandle = await open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let brokerSha256;
        try {
            const openedInfo = await brokerHandle.stat();
            if (!openedInfo.isFile() || openedInfo.nlink !== 1 || openedInfo.size < 1
                || openedInfo.size > 16 * 1024 * 1024) {
                throw new Error("broker executable is not a bounded single-link file");
            }
            const wrapperBytes = await brokerHandle.readFile();
            if (!wrapperBytes.subarray(0, 10).toString("utf8").startsWith("#!/bin/sh\n")) {
                throw new Error("broker executable must be a sealed /bin/sh wrapper around the absolute Node and broker paths");
            }
            brokerSha256 = createHash("sha256").update(wrapperBytes).digest("hex");
        }
        finally {
            await brokerHandle.close().catch(() => { });
        }
        if (brokerSha256 !== config.brokerSha256) {
            throw new Error("broker executable SHA-256 does not match the config pin");
        }
        const stateInfo = await lstat(stateRoot);
        if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()
            || (operatorUid !== null && stateInfo.uid !== operatorUid) || (stateInfo.mode & 0o077) !== 0) {
            throw new Error("Pattern A state root must be a canonical owner-private directory");
        }
        const resolved = {
            executable,
            configPath: canonicalConfigPath,
            brokerSha256,
            resourceSetDigest: config.resourceSetDigest,
            stateRoot,
        };
        const request = {
            schema: EXCALIBUR_ORCHESTRA_PREFLIGHT_REQUEST_SCHEMA,
            stateRootRealpath: stateRoot,
            expectedResourceSetDigest: config.resourceSetDigest,
        };
        const preflight = await (options.execFileFn ?? defaultExecFile)(executable, ["status"], {
            cwd: dirname(executable),
            env: brokerEnvironment(env, canonicalConfigPath, stateRoot),
            timeout: 30_000,
            maxBuffer: 256 * 1024,
            shell: false,
            windowsHide: true,
            input: `${canonicalJson(request)}\n`,
        });
        if (Buffer.byteLength(preflight.stdout, "utf8") > 256 * 1024) {
            throw new Error("broker preflight output exceeded the bounded response size");
        }
        const preflightAttestationDigest = parsePreflight(JSON.parse(preflight.stdout), resolved);
        return { ...resolved, preflightAttestationDigest };
    }
    catch (error) {
        const code = error.code;
        const reason = code === "ENOENT"
            ? "configured Pattern A broker or config does not exist"
            : code === "EACCES"
                ? "configured Pattern A broker is not executable"
                : error.message;
        return { reason };
    }
}
function brokerEnvironment(env, configPath, stateRoot) {
    const allowed = ["HOME", "TMPDIR", "LANG", "LC_ALL"];
    const home = typeof env.HOME === "string" && isAbsolute(env.HOME) ? env.HOME : null;
    const path = [...new Set([
            dirname(process.execPath),
            ...(home ? [
                join(home, ".local", "node-current", "bin"),
                join(home, ".local", "bin"),
                join(home, ".npm-global", "bin"),
            ] : []),
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
        ])].join(delimiter);
    return Object.fromEntries([
        ...allowed.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]]]),
        ["PATH", path],
        ["EXCALIBUR_ORCHESTRA_CONFIG", configPath],
        ["EXCALIBUR_PATTERN_A_STATE_ROOT", stateRoot],
    ]);
}
function renderResult(result) {
    const counts = Object.entries(result.receiptCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ");
    return [
        `Orchestra · ${result.missionId} · ${result.state}`,
        `  receipts: ${counts || "none reported"}`,
        `  mission digest: ${result.missionDigest}`,
    ];
}
function safeBrokerFailure(error) {
    if (error instanceof SyntaxError)
        return "broker returned invalid JSON";
    const message = error instanceof Error ? error.message : "";
    if (/^(?:broker (?:returned|output|result)|(?:mission|details) JSON) /.test(message))
        return message;
    const code = error?.code;
    return code
        ? `broker process did not complete (${String(code).slice(0, 32)})`
        : "broker process did not complete";
}
/**
 * Run the packaged Pattern A broker as one executable + argv vector. The CLI
 * never discovers it on PATH and never passes the command through a shell.
 */
export async function runOrchestraCommand(args, options = {}) {
    const env = options.env ?? process.env;
    const verb = args[0];
    const missionId = args[1];
    if (verb !== "init" && verb !== "status" && verb !== "advance") {
        return ["Orchestra · usage: /orchestra init <absolute-mission-json> | status <mission-id> | advance <mission-id> <exact-mission-digest>"];
    }
    if (verb === "init") {
        if (args.length !== 2 || !missionId || !isAbsolute(missionId)) {
            return ["Orchestra · usage: /orchestra init <absolute-mission-json>"];
        }
    }
    else if (!missionId || !MISSION_ID_RE.test(missionId)) {
        return ["Orchestra · invalid mission id (use 1-128 letters, numbers, '.', '_', ':', or '-')"];
    }
    const digest = args[2];
    if ((verb === "status" && args.length !== 2)
        || (verb === "advance" && (args.length !== 3 || !digest || !DIGEST_RE.test(digest)))) {
        return [verb === "status"
                ? "Orchestra · usage: /orchestra status <mission-id>"
                : "Orchestra · usage: /orchestra advance <mission-id> <exact-mission-digest>"];
    }
    const broker = await resolveOrchestraBrokerConfig(env, options);
    if ("reason" in broker)
        return unavailable(broker.reason);
    try {
        const missionPath = verb === "init"
            ? await resolveOwnerPrivateJson(missionId, "mission", 256 * 1024)
            : null;
        const argv = verb === "init"
            ? ["init", "--mission", missionPath]
            : verb === "status"
                ? ["status", "--mission-id", missionId]
                : ["advance", "--mission-id", missionId, "--confirm-mission-digest", digest];
        if (verb === "advance") {
            options.onProgress?.("Orchestra · advance running · Pattern A seats may take up to 4 hours; do not resubmit");
        }
        const executed = await (options.execFileFn ?? defaultExecFile)(broker.executable, argv, {
            cwd: dirname(broker.executable),
            env: brokerEnvironment(env, broker.configPath, broker.stateRoot),
            timeout: verb === "advance" ? 14_400_000 : 30_000,
            maxBuffer: 256 * 1024,
            shell: false,
            windowsHide: true,
        });
        if (Buffer.byteLength(executed.stdout, "utf8") > 256 * 1024) {
            throw new Error("broker output exceeded the bounded response size");
        }
        const result = parseResult(JSON.parse(executed.stdout));
        if ((verb !== "init" && result.missionId !== missionId)
            || (verb === "advance" && result.missionDigest !== digest)) {
            throw new Error("broker result did not bind the exact mission and digest");
        }
        return renderResult(result);
    }
    catch (error) {
        return unavailable(`Pattern A broker failed: ${safeBrokerFailure(error)}`);
    }
}
/**
 * Ask the pinned Pattern A broker for the exact ANVIL_GATED draft-publication
 * intent. This does not call an executor; the connected sidecar must still
 * create and render a server-owned proposal/approval card.
 */
export async function requestOrchestraPublicationIntent(missionId, detailsPath, options = {}) {
    if (!MISSION_ID_RE.test(missionId))
        return { reason: "invalid mission id" };
    if (!isAbsolute(detailsPath))
        return { reason: "details JSON path must be absolute" };
    const env = options.env ?? process.env;
    const broker = await resolveOrchestraBrokerConfig(env, options);
    if ("reason" in broker)
        return broker;
    try {
        const details = await resolveOwnerPrivateJson(detailsPath, "details", 64 * 1024);
        const executed = await (options.execFileFn ?? defaultExecFile)(broker.executable, [
            "publish-intent", "--mission-id", missionId, "--details", details,
        ], {
            cwd: dirname(broker.executable),
            env: brokerEnvironment(env, broker.configPath, broker.stateRoot),
            timeout: 30_000,
            maxBuffer: 256 * 1024,
            shell: false,
            windowsHide: true,
        });
        if (Buffer.byteLength(executed.stdout, "utf8") > 256 * 1024) {
            throw new Error("broker output exceeded the bounded response size");
        }
        return { publication: parsePublicationIntent(JSON.parse(executed.stdout), missionId) };
    }
    catch (error) {
        return { reason: `Pattern A broker failed: ${safeBrokerFailure(error)}` };
    }
}
