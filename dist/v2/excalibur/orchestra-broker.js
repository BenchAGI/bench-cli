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
export const EXCALIBUR_ORCHESTRA_PREPARE_REQUEST_SCHEMA = "excalibur-pattern-a-prepare-request-v1";
export const EXCALIBUR_ORCHESTRA_PROGRESS_RESULT_SCHEMA = "excalibur.pattern-a-progress-result.v1";
export const EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA = "excalibur-pattern-a-progress-event/v1";
export const EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX = "EXCALIBUR_PATTERN_A_PROGRESS ";
const MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RECEIPT_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SEAT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PUBLICATION_METADATA_SCHEMA = "excalibur-pattern-a-publication-metadata/v1";
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
function parseProgressEvent(value, expected) {
    if (!isRecord(value) || !exactKeys(value, [
        "schema", "sequence", "priorEventDigest", "eventDigest", "missionId",
        "missionDigest", "state", "phase", "status", "seat", "taskId", "round",
        "completed", "total", "occurredAt",
    ]) || value.schema !== EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA
        || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > 4096
        || typeof value.priorEventDigest !== "string" || !DIGEST_RE.test(value.priorEventDigest)
        || typeof value.eventDigest !== "string" || !DIGEST_RE.test(value.eventDigest)
        || typeof value.missionId !== "string" || !MISSION_ID_RE.test(value.missionId)
        || typeof value.missionDigest !== "string" || !DIGEST_RE.test(value.missionDigest)
        || !boundedText(value.state, 128) || !boundedText(value.phase, 128)
        || !["STARTED", "COMPLETED", "RETURNED", "BLOCKED"].includes(String(value.status || ""))
        || (value.seat !== null && (typeof value.seat !== "string" || !SEAT_ID_RE.test(value.seat)))
        || (value.taskId !== null && (typeof value.taskId !== "string" || !MISSION_ID_RE.test(value.taskId)))
        || (value.round !== null
            && (!Number.isSafeInteger(value.round) || Number(value.round) < 1 || Number(value.round) > 4))
        || !Number.isSafeInteger(value.completed) || Number(value.completed) < 0 || Number(value.completed) > 100
        || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > 100
        || Number(value.completed) > Number(value.total)
        || typeof value.occurredAt !== "string" || !TIMESTAMP_RE.test(value.occurredAt)
        || (expected !== undefined && value.missionId !== expected.missionId)
        || (expected?.missionDigest !== undefined && value.missionDigest !== expected.missionDigest)) {
        throw new Error("broker returned a malformed Pattern A progress event");
    }
    const { eventDigest, ...eventWithoutDigest } = value;
    if (canonicalSha256(eventWithoutDigest) !== eventDigest) {
        throw new Error("broker returned a Pattern A progress event with an invalid digest");
    }
    return value;
}
function parseProgressResult(value, missionId) {
    if (!isRecord(value) || !exactKeys(value, [
        "schemaVersion", "missionId", "missionDigest", "missionState", "revision",
        "eventCount", "latestEvent",
    ]) || value.schemaVersion !== EXCALIBUR_ORCHESTRA_PROGRESS_RESULT_SCHEMA
        || value.missionId !== missionId
        || typeof value.missionDigest !== "string" || !DIGEST_RE.test(value.missionDigest)
        || !boundedText(value.missionState, 128)
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
        || !Number.isSafeInteger(value.eventCount) || Number(value.eventCount) < 0 || Number(value.eventCount) > 4096
        || (Number(value.eventCount) === 0 ? value.latestEvent !== null : value.latestEvent === null)) {
        throw new Error("broker returned a malformed Pattern A progress result");
    }
    const latestEvent = value.latestEvent === null
        ? null
        : parseProgressEvent(value.latestEvent, { missionId, missionDigest: value.missionDigest });
    return { ...value, latestEvent };
}
function renderProgressEvent(event) {
    return `Orchestra · progress #${event.sequence} · ${event.phase} · ${event.seat ?? "orchestrator"} ${event.status} · ${event.completed}/${event.total}`;
}
function renderProgressResult(result) {
    return [
        `Orchestra · ${result.missionId} · ${result.missionState} · revision ${result.revision}`,
        `  progress events: ${result.eventCount}`,
        ...(result.latestEvent ? [`  latest: ${renderProgressEvent(result.latestEvent)}`] : ["  latest: none"]),
        `  mission digest: ${result.missionDigest}`,
    ];
}
async function defaultExecFile(executable, argv, options) {
    return await new Promise((resolve, reject) => {
        const { input, onStderrLine, ...execOptions } = options;
        let pendingStderr = "";
        let progressError = null;
        const deliverLines = (text, final = false) => {
            pendingStderr += text;
            if (Buffer.byteLength(pendingStderr, "utf8") > 256 * 1024) {
                throw new Error("broker progress output exceeded the bounded response size");
            }
            const lines = pendingStderr.split(/\r?\n/);
            pendingStderr = final ? "" : (lines.pop() ?? "");
            for (const line of lines)
                if (line)
                    onStderrLine?.(line);
            if (final && pendingStderr)
                onStderrLine?.(pendingStderr);
        };
        const child = execFile(executable, argv, execOptions, (error, stdout, stderr) => {
            try {
                deliverLines("", true);
            }
            catch (progressFailure) {
                progressError = progressFailure;
            }
            if (progressError)
                reject(progressError);
            else if (error)
                reject(error);
            else
                resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
        child.stderr?.on("data", (chunk) => {
            if (progressError)
                return;
            try {
                deliverLines(String(chunk));
            }
            catch (error) {
                progressError = error;
                child.kill();
            }
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
async function readOwnerPrivateJson(path, label, maximum) {
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
        const raw = await handle.readFile("utf8");
        const value = JSON.parse(raw);
        canonicalJson(value);
        return { path: await realpath(path), value };
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
function validatePublicationMetadata(value) {
    if (!isRecord(value) || !exactKeys(value, ["schema", "title", "body", "labels"])
        || value.schema !== PUBLICATION_METADATA_SCHEMA
        || !boundedText(value.title, 256)
        || !boundedText(value.body, 32_768)
        || !Array.isArray(value.labels) || value.labels.length !== 0) {
        throw new Error("details JSON must contain only exact Pattern A publication metadata");
    }
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
    if (/^(?:broker (?:returned|output|result|progress)|(?:brief|details) JSON) /.test(message))
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
    if (verb !== "prepare" && verb !== "status" && verb !== "progress" && verb !== "advance") {
        return ["Orchestra · usage: /orchestra prepare <brief-json> | status <mission-id> | progress <mission-id> | advance <mission-id> <exact-mission-digest> | propose <mission-id> <metadata-json>"];
    }
    if (verb === "prepare") {
        if (args.length !== 2 || !missionId || !isAbsolute(missionId)) {
            return ["Orchestra · usage: /orchestra prepare <absolute-mission-brief-json>"];
        }
        if (!boundedText(options.principalId, 160) || !boundedText(options.sessionId, 160)) {
            return unavailable("authenticated operator principal and active conversation are required for mission preparation");
        }
    }
    else if (!missionId || !MISSION_ID_RE.test(missionId)) {
        return ["Orchestra · invalid mission id (use 1-128 letters, numbers, '.', '_', ':', or '-')"];
    }
    const digest = args[2];
    if ((["status", "progress"].includes(verb) && args.length !== 2)
        || (verb === "advance" && (args.length !== 3 || !digest || !DIGEST_RE.test(digest)))) {
        return [verb === "status" || verb === "progress"
                ? `Orchestra · usage: /orchestra ${verb} <mission-id>`
                : "Orchestra · usage: /orchestra advance <mission-id> <exact-mission-digest>"];
    }
    const broker = await resolveOrchestraBrokerConfig(env, options);
    if ("reason" in broker)
        return unavailable(broker.reason);
    try {
        const brief = verb === "prepare"
            ? await readOwnerPrivateJson(missionId, "brief", 256 * 1024)
            : null;
        if (brief && !isRecord(brief.value))
            throw new Error("brief JSON must contain one object");
        const prepareInput = brief === null ? undefined : canonicalJson({
            schema: EXCALIBUR_ORCHESTRA_PREPARE_REQUEST_SCHEMA,
            principalId: options.principalId,
            sessionId: options.sessionId,
            brief: brief.value,
        });
        const argv = verb === "prepare"
            ? ["prepare"]
            : verb === "status"
                ? ["status", "--mission-id", missionId]
                : verb === "progress"
                    ? ["progress", "--mission-id", missionId]
                    : ["advance", "--mission-id", missionId, "--confirm-mission-digest", digest];
        let lastProgress = null;
        let streamedProgress = 0;
        const consumeProgressLine = (line) => {
            if (!line.startsWith(EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX))
                return;
            const payload = line.slice(EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX.length);
            if (Buffer.byteLength(payload, "utf8") > 16 * 1024) {
                throw new Error("broker progress event exceeded the bounded response size");
            }
            const raw = JSON.parse(payload);
            if (canonicalJson(raw) !== payload)
                throw new Error("broker progress event is not canonical JSON");
            const event = parseProgressEvent(raw, {
                missionId: missionId,
                missionDigest: digest,
            });
            if (lastProgress && (event.sequence !== lastProgress.sequence + 1
                || event.priorEventDigest !== lastProgress.eventDigest)) {
                throw new Error("broker progress stream broke sequence or prior-digest continuity");
            }
            lastProgress = event;
            streamedProgress += 1;
            options.onProgress?.(renderProgressEvent(event));
        };
        if (verb === "advance")
            options.onProgress?.("Orchestra · advance running · Pattern A seats may take up to 4 hours; do not resubmit");
        const executed = await (options.execFileFn ?? defaultExecFile)(broker.executable, argv, {
            cwd: dirname(broker.executable),
            env: brokerEnvironment(env, broker.configPath, broker.stateRoot),
            timeout: verb === "advance" ? 14_400_000 : 30_000,
            maxBuffer: 256 * 1024,
            shell: false,
            windowsHide: true,
            ...(prepareInput === undefined ? {} : { input: `${prepareInput}\n` }),
            ...(verb === "advance" ? { onStderrLine: consumeProgressLine } : {}),
        });
        if (Buffer.byteLength(executed.stdout, "utf8") > 256 * 1024) {
            throw new Error("broker output exceeded the bounded response size");
        }
        if (verb === "progress") {
            return renderProgressResult(parseProgressResult(JSON.parse(executed.stdout), missionId));
        }
        if (verb === "advance" && streamedProgress === 0) {
            for (const line of executed.stderr.split(/\r?\n/))
                consumeProgressLine(line);
        }
        const result = parseResult(JSON.parse(executed.stdout));
        if ((verb !== "prepare" && result.missionId !== missionId)
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
        const details = await readOwnerPrivateJson(detailsPath, "details", 64 * 1024);
        validatePublicationMetadata(details.value);
        const executed = await (options.execFileFn ?? defaultExecFile)(broker.executable, [
            "propose", "--mission-id", missionId, "--details", details.path,
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
