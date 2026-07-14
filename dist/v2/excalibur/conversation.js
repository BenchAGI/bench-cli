import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { replLoop, runTuiSeat, singleTurn } from "../launcher/cloud-seat.js";
import { loadAccount, resolveApiBase } from "../launcher/account.js";
import { resolveEntitledAgents } from "../launcher/entitlements.js";
import { c, println } from "../render/ansi.js";
import { GrokAcpRuntime } from "./grok-acp-runtime.js";
import { inspectGrokProvider } from "./grok-managed.js";
import { ExcaliburEffectsLockedError, ExcaliburHttpTransport, ExcaliburTransportError, } from "./http-transport.js";
import { loadExcaliburState, recordReceipt, } from "./scoped-state.js";
import { ExcaliburSidecarRuntime } from "./sidecar-runtime.js";
function shouldUseTui(opts) {
    if (opts.message)
        return false;
    if (opts.classic || opts.env?.BENCHAGI_CLASSIC_REPL || process.env.BENCHAGI_CLASSIC_REPL)
        return false;
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
async function runConnected(runtime, agent, opts, locationLabel) {
    if (opts.message) {
        await singleTurn(runtime, opts.message, "excalibur");
    }
    else if (shouldUseTui(opts)) {
        await runTuiSeat(runtime, agent, "excalibur");
    }
    else if (process.stdin.isTTY) {
        await replLoop(runtime, "grok", agent.model, "excalibur", locationLabel);
    }
    else {
        throw Object.assign(new Error("no prompt supplied; use `excalibur ask <message>` outside a TTY"), { exitCode: 2 });
    }
}
function cloudControlBase(env, accountBase) {
    const configured = env.EXCALIBUR_CLOUD_CONTROL_URL?.trim();
    if (configured)
        return configured;
    return new URL(accountBase).origin;
}
/**
 * Establishes the only permitted sidecar-loss fallback: exact tenant-bound,
 * authenticated control-plane reads. The returned transport rejects chat,
 * proposals, approvals, aborts, and every other mutation before fetch.
 */
export async function activateTenantCloudReadOnly(opts, reason = "shared loopback sidecar unavailable") {
    if (opts.contextId === "operator-local" || opts.scope.instanceId === "unbound"
        || opts.contextId !== opts.scope.instanceId) {
        throw Object.assign(new Error("cloud read fallback requires one exact principal-bound tenant context"), { exitCode: 13 });
    }
    const env = opts.env ?? process.env;
    const firebaseToken = opts.firebaseToken === undefined
        ? await loadFreshFirebaseIdToken().catch(() => null)
        : opts.firebaseToken;
    if (!firebaseToken) {
        throw Object.assign(new Error("tenant cloud reads require a fresh authenticated human session"), { exitCode: 13 });
    }
    const entitled = await (opts.entitlementResolver ?? resolveEntitledAgents)({
        env,
        scope: opts.scope,
        firebaseToken,
    });
    if (entitled === null) {
        throw Object.assign(new Error("tenant cloud reads require authenticated instance entitlements"), { exitCode: 13 });
    }
    let transport = opts.cloudReadTransport;
    if (!transport) {
        const account = await loadAccount(env);
        transport = new ExcaliburHttpTransport({
            baseUrl: cloudControlBase(env, resolveApiBase(account, env)),
            posture: "cloud_read_only",
            scope: { kind: "tenant", instanceId: opts.contextId },
            accessToken: firebaseToken,
        });
    }
    if (transport.posture !== "cloud_read_only" || transport.scope.kind !== "tenant"
        || transport.scope.instanceId !== opts.contextId) {
        throw Object.assign(new Error("cloud read transport is not bound to the selected tenant"), { exitCode: 13 });
    }
    const controlSession = await transport.getControlSession();
    if (controlSession.authMethod !== "firebase_human") {
        throw Object.assign(new Error("cloud read fallback did not return a Firebase human control session"), { exitCode: 13 });
    }
    await recordReceipt({
        kind: "fallback",
        status: "degraded",
        provider: "cloud-read-only",
        detail: `${reason}; reads available, chat/proposals/approvals/effects locked`,
    }, { scope: opts.scope, env });
    return transport;
}
export async function runExcaliburConversation(opts) {
    if (opts.resume?.provider === "cloud-read-only") {
        throw Object.assign(new Error("cloud read-only state has no resumable conversation; restore the shared sidecar"), { exitCode: 13 });
    }
    if (opts.resume?.provider === "grok-acp") {
        throw Object.assign(new Error("direct Grok ACP sessions are legacy diagnostics; use `excalibur legacy-grok-acp` explicitly"), { exitCode: 13 });
    }
    const runtime = new ExcaliburSidecarRuntime({
        env: opts.env,
        scope: opts.scope,
        contextId: opts.contextId,
        resumeSessionId: opts.resume?.sessionId,
        transport: opts.sidecarTransport,
        sidecarUrl: opts.sidecarUrl,
        cloudAccessToken: opts.firebaseToken,
        traceFramesPath: opts.traceFramesPath,
        showFullToolOutput: opts.full,
        showThinking: !opts.noThinking,
        tui: shouldUseTui(opts),
    });
    try {
        await runtime.connect();
    }
    catch (error) {
        await runtime.close().catch(() => { });
        const customerContext = opts.contextId !== "operator-local";
        const safeReason = error instanceof ExcaliburTransportError
            ? error.code.toLowerCase().replaceAll("_", "-")
            : "sidecar-unavailable";
        await recordReceipt({
            kind: "preflight",
            status: "blocked",
            provider: "excalibur-sidecar",
            detail: safeReason,
        }, { scope: opts.scope, env: opts.env }).catch(() => { });
        if (customerContext) {
            await activateTenantCloudReadOnly(opts, safeReason);
            println(c.yellow("tenant cloud read-only mode active; chat, proposals, approvals, and effects are locked"));
            throw new ExcaliburEffectsLockedError("chat");
        }
        throw Object.assign(new Error("shared Excalibur loopback sidecar is unavailable; start Excalibur Desktop and retry"), { exitCode: 6, cause: error });
    }
    try {
        await runConnected(runtime, { id: "grok", model: runtime.currentModel() }, opts, "shared sidecar");
    }
    finally {
        // Detach only. The sidecar-owned conversation remains active so Desktop and
        // the next CLI invocation retain the exact same scoped conversation id.
        await runtime.close();
    }
}
/** Explicit operator-only diagnostic. Never used as the canonical path. */
export async function runLegacyGrokAcpDiagnostic(opts) {
    if (opts.contextId !== "operator-local") {
        throw Object.assign(new Error("legacy Grok ACP diagnostic is forbidden in tenant scope"), { exitCode: 13 });
    }
    const inspection = await inspectGrokProvider({ env: opts.env, scope: opts.scope });
    if (!inspection.ready) {
        throw Object.assign(new Error(inspection.issue || "legacy Grok ACP preflight failed"), { exitCode: 6 });
    }
    println(c.yellow("legacy diagnostic: direct Grok ACP is isolated from the shared Excalibur conversation"));
    const runtime = new GrokAcpRuntime({
        env: opts.env,
        scope: opts.scope,
        model: inspection.model,
        contextId: "operator-local",
        showFullToolOutput: opts.full,
        showThinking: !opts.noThinking,
        tui: shouldUseTui(opts),
    });
    try {
        await runtime.connect();
        await runConnected(runtime, { id: "grok", model: inspection.model }, opts, "legacy direct ACP diagnostic");
    }
    finally {
        await runtime.close().catch(() => { });
    }
}
export async function currentConversationState(scope, env = process.env) {
    const state = await loadExcaliburState({ scope, env });
    return { contextId: state.selectedContext };
}
