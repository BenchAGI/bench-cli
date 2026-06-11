// Chat runner: ties transport + event router + renderer + liveness +
// approval state into a single durable run loop. Used by the REPL and by
// single-turn commands.
import { appendFile } from "node:fs/promises";
import { LocalGatewayWsTransport } from "./transport/local-gateway.js";
import { resolveGatewayToken, resolveGatewayPassword } from "./auth/gateway-token.js";
import { loadFreshFirebaseIdToken } from "./auth/firebase-token.js";
import { EventRouter } from "./render/event-router.js";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "./render/stream.js";
import { LivenessIndicator } from "./render/liveness.js";
import { ApprovalState } from "./render/approval.js";
import { classifyByModel, resolveLivenessThreshold } from "./probe/capability.js";
import { PROTOCOL_VERSION } from "./protocol/types.js";
import { c, eprintln, println } from "./render/ansi.js";
export class ChatRunner {
    opts;
    transport;
    renderer;
    router;
    liveness;
    approval;
    sessionKey = null;
    modelOverride = null; // set by /model over the flyway (sessions.patch)
    currentRunId = null;
    activeRunIds = new Set();
    completedRuns = new Map();
    connected = false;
    livenessThresholdMs = 5_000;
    finalWaiter = null;
    renderedRunStart = new Set();
    verbosePatchUnavailable = false;
    // Highest transport-frame seq observed per session, for chat.history
    // replay on reconnect (V1.1 — Item 1).
    lastSeenFrameSeq = new Map();
    // Set while a chat.history replay is dispatching events through the
    // router, so the gap-warning suppression knows replayed events came
    // from history (a gap was already announced).
    replayingHistory = false;
    // While `replayingHistory` is true, live event frames are buffered
    // here. After the history replay drains, the buffer drains in arrival
    // order. This prevents the live-vs-history ordering race that would
    // otherwise produce false seq-gap warnings (Codex Anvil P1).
    liveFrameBuffer = [];
    traceFramesPath = null;
    constructor(opts) {
        this.opts = opts;
        this.traceFramesPath = opts.traceFramesPath ?? process.env.BENCHAGI_TRACE_FRAMES ?? null;
        this.transport = new LocalGatewayWsTransport({
            url: opts.gatewayUrl,
            rawFrameLog: (direction, raw) => this.traceRawFrame(direction, raw),
        });
        this.renderer = new StreamRenderer({
            ...DEFAULT_RENDERER_OPTIONS,
            showFullToolOutput: opts.showFullToolOutput ?? false,
            showThinking: opts.showThinking ?? true,
            assistantLabel: opts.assistantLabel,
        });
    }
    async connect() {
        const reachable = await this.transport.isReachable();
        const url = this.opts.gatewayUrl ?? "ws://127.0.0.1:18789";
        if (!reachable) {
            throw Object.assign(new Error(`OpenClaw Gateway not reachable at ${url}. ` +
                "Ensure the gateway is running, or run `openclaw doctor`."), { exitCode: 2 });
        }
        const token = await resolveGatewayToken(this.opts.gatewayToken);
        const password = await resolveGatewayPassword(this.opts.gatewayPassword);
        const policy = await this.transport.connect({
            url,
            token,
            password,
            protocolVersion: PROTOCOL_VERSION,
        });
        this.connected = true;
        // Validate required methods (SPEC §5.4 / ANVIL-3 P1).
        const required = [
            "chat.send", "chat.history", "chat.abort",
            "sessions.list", "sessions.patch",
            "exec.approval.resolve", "plugin.approval.resolve",
        ];
        const missing = required.filter((m) => !policy.methods.includes(m));
        if (missing.length > 0) {
            throw Object.assign(new Error(`gateway is missing required methods: ${missing.join(", ")}. ` +
                `Upgrade openclaw to a version supporting protocol v${policy.protocol}.`), { exitCode: 6 });
        }
        // Configure liveness threshold from policy + heuristic.
        const hint = classifyByModel(this.opts.modelPrimary ?? null);
        this.livenessThresholdMs = resolveLivenessThreshold(hint, this.opts.liveness ?? "auto", policy.policy.tickIntervalMs);
        // Wire approval, liveness, router.
        this.approval = new ApprovalState((action) => this.resolveApproval(action));
        this.liveness = new LivenessIndicator({
            agentId: this.opts.agentId,
            pid: process.pid,
            livenessThresholdMs: this.livenessThresholdMs,
            unhealthyTickThresholdMs: Math.max(15_000, 3 * policy.policy.tickIntervalMs),
            stuckRunThresholdMs: 120_000,
            managed: this.opts.tui ?? false,
        });
        this.liveness.start();
        this.router = new EventRouter({
            onChatDelta: (payload, runId) => {
                if (!this.shouldAcceptRunId(runId))
                    return;
                this.renderer.renderChatDelta(payload);
            },
            onChatFinal: (payload, runId) => {
                if (!this.shouldAcceptRunId(runId))
                    return;
                this.renderer.renderChatFinal(payload);
                const state = payload?.state;
                if (state === "final")
                    this.completeRun("final", runId);
                if (state === "aborted")
                    this.completeRun("aborted", runId);
                if (state === "error")
                    this.completeRun("error", runId);
            },
            onChatSideResult: (payload) => {
                const runId = resolveFrameRunId({ event: "chat.side_result", payload });
                if (!this.shouldAcceptRunId(runId))
                    return;
                this.renderer.renderChatSideResult(payload);
            },
            onAgent: (ap) => {
                if (!this.shouldAcceptRunId(ap.runId))
                    return;
                // chat-event style (state-based) detection for batch backends
                // that emit chat events directly.
                if (ap.stream === "lifecycle") {
                    const phase = ap.data?.phase;
                    if (phase === "start" || phase === "started") {
                        if (ap.runId && !this.renderedRunStart.has(ap.runId)) {
                            this.renderedRunStart.add(ap.runId);
                            this.currentRunId = ap.runId;
                            this.liveness.recordLifecycleStart();
                            this.renderer.renderAgent(ap);
                        }
                        return;
                    }
                    if (phase === "end" || phase === "ended" || phase === "complete" || phase === "completed") {
                        this.renderer.renderAgent(ap);
                        return;
                    }
                }
                if (ap.stream === "approval") {
                    this.approval.onAgentApproval(ap.data ?? null);
                    return;
                }
                this.renderer.renderAgent(ap);
            },
            onSessionsChanged: () => { },
            onShutdown: (reason, restartExpectedMs) => {
                this.renderer.renderShutdown(reason, restartExpectedMs);
                // TODO(V1.1 follow-up — Codex Anvil P2): plumb
                // restartExpectedMs into transport.reconnectLoop's first-
                // attempt floor so the reconnect UX respects the shutdown
                // hint (today we always start at 1s regardless).
            },
            onApprovalResolved: (kind, payload) => {
                void kind;
                this.approval.onTopLevelResolved(payload);
            },
            onUnknown: (event) => this.renderer.renderUnknownEvent(event),
            onSeqGap: (runId, prevSeq, nextSeq) => {
                // Suppress gap warning during a chat.history replay — the
                // replay is itself the recovery for the gap, and emitting
                // the warning while we are filling it would be misleading.
                if (this.replayingHistory)
                    return;
                eprintln(c.dim(`(events may be incomplete: run ${runId.slice(0, 8)} seq ${prevSeq} → ${nextSeq})`));
            },
        }, this.liveness);
        // Wire reconnect lifecycle (V1.1 — Item 1 + Item 2).
        this.transport.setReconnectListeners({
            onDisconnected: () => {
                eprintln(c.dim("(connection lost — reconnecting…)"));
            },
            onReconnecting: (attempt, delayMs) => {
                eprintln(c.dim(`(reconnect attempt ${attempt} in ${Math.round(delayMs / 1000)}s)`));
                // V1.1 — Item 2: feed the truthful reconnect state to the
                // liveness indicator so its label reflects transport reality.
                this.liveness.setReconnecting(attempt, delayMs);
            },
            onReconnected: () => {
                eprintln(c.dim("(reconnected)"));
                this.liveness.clearReconnecting();
                void this.replayHistoryAfterReconnect();
            },
        });
        // Pump events.
        void this.eventLoop();
    }
    /**
     * After a successful reconnect, ask the gateway for any session
     * events we missed. The router dedupes against already-rendered
     * events via its existing `(runId, seq, stream, sub)` key set.
     * V1.1 — Item 1 (SPEC §13 "Reconnect: in-flight run recovery").
     *
     * Live frames arriving while this method is in flight are buffered
     * by `eventLoop` so they cannot be dispatched ahead of the replay,
     * which would otherwise produce false seq-gap warnings and
     * out-of-order rendering (Codex Anvil P1).
     */
    async replayHistoryAfterReconnect() {
        if (!this.sessionKey)
            return;
        // Set the replay flag BEFORE the chat.history request so any live
        // frames the gateway emits during the request are buffered.
        this.replayingHistory = true;
        try {
            const sinceSeq = this.lastSeenFrameSeq.get(this.sessionKey) ?? -1;
            let resp;
            try {
                resp = await this.transport.request("chat.history", {
                    sessionKey: this.sessionKey,
                    sinceSeq,
                });
            }
            catch (err) {
                // TODO(V1.1 follow-up — Codex Anvil P2): retry chat.history
                // with bounded backoff before giving up. Today we proceed with
                // whatever live frames are buffered, which may leave a gap in
                // the rendered output for the missed window.
                eprintln(c.red(`history replay failed: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
            const events = extractHistoryEvents(resp);
            for (const frame of events) {
                try {
                    this.recordFrameSeq(frame);
                    this.router.dispatch(frame);
                }
                catch (err) {
                    eprintln(c.red(`history replay render error: ${err instanceof Error ? err.message : String(err)}`));
                }
            }
            // Drain the live-frame buffer that accumulated during replay.
            // Loop because new frames may have arrived during the drain.
            while (this.liveFrameBuffer.length > 0) {
                const buffered = this.liveFrameBuffer.splice(0);
                for (const frame of buffered) {
                    try {
                        this.router.dispatch(frame);
                    }
                    catch (err) {
                        eprintln(c.red(`live frame drain render error: ${err instanceof Error ? err.message : String(err)}`));
                    }
                }
            }
        }
        finally {
            this.replayingHistory = false;
        }
    }
    recordFrameSeq(frame) {
        if (typeof frame.seq !== "number" || !this.sessionKey)
            return;
        const prev = this.lastSeenFrameSeq.get(this.sessionKey) ?? -1;
        if (frame.seq > prev)
            this.lastSeenFrameSeq.set(this.sessionKey, frame.seq);
    }
    async eventLoop() {
        try {
            for await (const frame of this.transport.events()) {
                if (!this.shouldDispatchFrame(frame)) {
                    continue;
                }
                // Record the highest transport-frame seq we've seen so a
                // post-reconnect chat.history call can resume from there
                // (V1.1 — Item 1).
                this.recordFrameSeq(frame);
                // History-replay window: buffer live frames so they cannot be
                // dispatched ahead of the chat.history replay (Codex Anvil P1).
                if (this.replayingHistory) {
                    this.liveFrameBuffer.push(frame);
                    continue;
                }
                // Drain any buffer stragglers that arrived just as the replay
                // window closed but before this iteration ran.
                if (this.liveFrameBuffer.length > 0) {
                    const buffered = this.liveFrameBuffer.splice(0);
                    for (const f of buffered) {
                        try {
                            this.router.dispatch(f);
                        }
                        catch (err) {
                            eprintln(c.red(`render error (buffered): ${err instanceof Error ? err.message : String(err)}`));
                        }
                    }
                }
                try {
                    this.router.dispatch(frame);
                }
                catch (err) {
                    eprintln(c.red(`render error: ${err instanceof Error ? err.message : String(err)}`));
                }
            }
        }
        catch (err) {
            eprintln(c.red(`event loop terminated: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    traceRawFrame(direction, raw) {
        if (!this.traceFramesPath)
            return;
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            direction,
            raw,
        });
        void appendFile(this.traceFramesPath, `${line}\n`).catch(() => { });
    }
    async waitForFinal(timeoutMs, runId) {
        if (runId) {
            const alreadyCompleted = this.completedRuns.get(runId);
            if (alreadyCompleted)
                return alreadyCompleted;
        }
        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.finalWaiter = null;
                resolve("timeout");
            }, timeoutMs);
            this.finalWaiter = {
                runId,
                resolve: (reason) => {
                    clearTimeout(timer);
                    this.finalWaiter = null;
                    resolve(reason);
                },
            };
        });
    }
    completeRun(reason, runId) {
        const completedRunId = runId ?? this.currentRunId ?? undefined;
        if (completedRunId) {
            this.activeRunIds.delete(completedRunId);
            this.completedRuns.set(completedRunId, reason);
            while (this.completedRuns.size > 64) {
                const oldest = this.completedRuns.keys().next().value;
                if (typeof oldest !== "string")
                    break;
                this.completedRuns.delete(oldest);
            }
            if (this.currentRunId === completedRunId) {
                this.currentRunId = this.activeRunIds.values().next().value ?? null;
            }
        }
        // V1.1 — Item 2: hide the liveness indicator between REPL turns.
        if (this.liveness && this.activeRunIds.size === 0)
            this.liveness.setInFlight(false);
        if (this.finalWaiter &&
            (!this.finalWaiter.runId || !completedRunId || this.finalWaiter.runId === completedRunId)) {
            const w = this.finalWaiter;
            this.finalWaiter = null;
            w.resolve(reason);
        }
    }
    async sendMessage(message) {
        if (!this.connected)
            throw new Error("not connected");
        if (this.activeRunIds.size > 0) {
            const run = this.currentRunId ? ` ${this.currentRunId.slice(0, 8)}` : "";
            eprintln(c.yellow(`turn${run} is still in flight — Ctrl-C to abort before sending another`));
            return null;
        }
        if (!this.sessionKey) {
            await this.ensureSession();
        }
        else {
            await this.ensureVerboseEvents();
        }
        const idempotencyKey = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
        const firebaseIdToken = await loadFreshFirebaseIdToken();
        this.currentRunId = idempotencyKey;
        this.activeRunIds.add(idempotencyKey);
        this.completedRuns.delete(idempotencyKey);
        this.liveness.recordLifecycleStart();
        try {
            const resp = await this.transport.request("chat.send", {
                sessionKey: this.sessionKey,
                message,
                idempotencyKey,
                deliver: true,
                // cloudAuth drives the bench-cloud bridge (company allotment), but its field is
                // NOT in the v4 chat.send schema on a standard gateway (strict → rejects it).
                // Send it only when explicitly opted in (a bridge-capable gateway); otherwise the
                // gateway runs the agent under its own creds. Connect already authenticated the user.
                ...(firebaseIdToken && process.env.BENCHAGI_CLOUD_BRIDGE
                    ? { cloudAuth: { firebaseIdToken } }
                    : {}),
            });
            const acceptedRunId = extractRunId(resp) ?? idempotencyKey;
            if (acceptedRunId !== idempotencyKey) {
                this.activeRunIds.delete(idempotencyKey);
                this.activeRunIds.add(acceptedRunId);
                this.currentRunId = acceptedRunId;
            }
            return acceptedRunId;
        }
        catch (err) {
            this.activeRunIds.delete(idempotencyKey);
            this.currentRunId = this.activeRunIds.values().next().value ?? null;
            if (this.activeRunIds.size === 0)
                this.liveness.setInFlight(false);
            // TODO(V1.1 follow-up — Codex Anvil P1): chat.send acceptance race.
            // If the gateway ACK was lost mid-flight but the run was actually
            // accepted, the user sees "chat.send failed" while history later
            // recovers the run's output. Re-issue chat.send with the same
            // idempotencyKey on reconnect (gateway already dedupes), or call
            // chat.history/sessions.list to confirm acceptance before failing
            // the user-visible send.
            eprintln(c.red(`chat.send failed: ${err instanceof Error ? err.message : String(err)}`));
            return null;
        }
    }
    async abortCurrent() {
        if (this.sessionKey) {
            try {
                await this.transport.request("chat.abort", { sessionKey: this.sessionKey });
            }
            catch (err) {
                eprintln(c.red(`abort failed: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
    }
    /**
     * Sync predicate that mirrors `handleApprovalKey`'s consume-or-not
     * decision without firing any side effects. Used by the REPL to
     * synchronously clear its line buffer before the async resolve
     * yields to the event loop. V1.1 — Item 3 (Codex Anvil P1).
     *
     * Now also consumes [r] for the V1.1 Item 5 expand-toggle.
     */
    canHandleApprovalKey(key) {
        if (this.approval?.canConsumeKey(key))
            return true;
        if (key === "r" || key === "R")
            return true;
        return false;
    }
    /** True when the agent is waiting on the operator (a pending approval). */
    hasPendingApproval() {
        return Boolean(this.approval?.isPending());
    }
    /**
     * Route a single keystroke from the REPL.
     *
     * - [A]/[D] resolve a pending approval (V1.1 — Item 3).
     * - [r] flips the renderer's per-session full-tool-output flag
     *   (V1.1 — Item 5). A status line confirms the new state.
     *
     * Returns true if the key was consumed, false otherwise.
     */
    async handleApprovalKey(key) {
        if (this.approval && await this.approval.handleKey(key)) {
            return true;
        }
        if (key === "r" || key === "R") {
            const on = this.renderer.toggleFullOutput();
            println(c.dim(`(expand mode: ${on ? "on" : "off"})`));
            return true;
        }
        return false;
    }
    /**
     * SIGINT/Ctrl-C disposition. If an approval is pending, default-
     * deny it (per SPEC §6.5). Otherwise, abort the current run.
     * V1.1 — Item 3.
     */
    async interruptCurrent() {
        if (this.approval?.isPending()) {
            await this.approval.denyOnInterrupt();
            return "denied";
        }
        await this.abortCurrent();
        this.completeRun("aborted", this.currentRunId ?? undefined);
        return "aborted";
    }
    async close() {
        if (this.liveness)
            this.liveness.stop();
        await this.transport.close();
    }
    async setLivenessOverride() {
        // No-op placeholder for runtime --liveness flips.
    }
    resumeKey() {
        return this.sessionKey;
    }
    /** Structured connection health for the TUI status bar (idle before connect). */
    healthSnapshot() {
        if (this.liveness)
            return this.liveness.snapshot();
        return { state: "ok", runQuietMs: 0, gatewayTickMs: 0, inFlight: false, reconnectAttempt: null, reconnectDelayMs: null };
    }
    /** True while a run is in flight (drives the working indicator). */
    isInFlight() {
        return this.activeRunIds.size > 0;
    }
    /** The current run id, for the working indicator's deterministic word seed. */
    currentRun() {
        return this.currentRunId;
    }
    /** Set the thinking presentation mode (/thinking). Returns the new mode. */
    setThinking(mode) {
        return this.renderer.setThinking(mode);
    }
    /** Read-only view of the current thinking mode. */
    getThinking() {
        return this.renderer.getThinking();
    }
    /** Read-only view of the expand-tool-output flag (/expand toggles it via [r]). */
    isExpanded() {
        return this.renderer.isFullOutput();
    }
    /** Expand the last collapsed tool's full output inline (Ctrl+O). Returns true if there was one. */
    expandLastTool() {
        return this.renderer.expandLast();
    }
    /** The model this session is running on (the /model override, else the launch default). */
    currentModel() {
        return this.modelOverride ?? this.opts.modelPrimary ?? "";
    }
    /**
     * Set the session's model over the flyway (sessions.patch {model}). The gateway validates against
     * the agent's allowed models and rejects an unknown one. Returns true on success.
     */
    async setModel(model) {
        this.modelOverride = model; // applied at session-create (works without elevated scope)
        if (!this.sessionKey)
            return true; // no session yet → takes effect on your first message
        return this.patchSession({ model }); // existing session → sessions.patch (operator.admin gated)
    }
    /**
     * Set the agent's thinking/reasoning level (sessions.patch {thinkingLevel}). Only possible once a
     * session exists, and the gateway gates it behind operator.admin — so over a normal flyway seat
     * this is effectively a Flyway·deep feature. Valid: off·minimal·low·medium·high·xhigh·max.
     */
    async setThinkingLevel(level) {
        if (!this.sessionKey)
            return false; // sessions.create can't carry thinkingLevel
        return this.patchSession({ thinkingLevel: level });
    }
    // True once a server session exists (after the first message). Lets the UI know whether a model
    // change can still be applied at create-time vs needs the (scope-gated) patch path.
    hasSession() {
        return this.sessionKey != null;
    }
    // Patch the current session. sessions.patch accepts model/thinkingLevel but the gateway requires
    // operator.admin to apply them — absent on a normal flyway seat, so we swallow that specific error
    // and let the caller show clean guidance.
    async patchSession(patch) {
        if (!this.connected || !this.sessionKey)
            return false;
        try {
            await this.transport.request("sessions.patch", { key: this.sessionKey, ...patch });
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/operator\.admin/i.test(msg))
                eprintln(c.red(`session update failed: ${msg}`));
            return false;
        }
    }
    async ensureSession() {
        // ANVIL-3 P1 fix: SessionsCreateParamsSchema rejects `verboseLevel` as an
        // additional property. Create with only allowed fields, then assert
        // verboseLevel via sessions.patch (SPEC §5.3).
        const resp = await this.transport
            .request("sessions.create", {
            agentId: this.opts.agentId,
            ...(this.modelOverride ? { model: this.modelOverride } : {}), // /model takes effect at create
        })
            .catch(() => null);
        const key = resp?.key
            ?? resp?.sessionKey;
        if (typeof key === "string" && key.length > 0) {
            this.sessionKey = key;
        }
        else {
            this.sessionKey = `agent:${this.opts.agentId}`;
        }
        await this.ensureVerboseEvents();
    }
    async ensureVerboseEvents() {
        if (!this.sessionKey || this.verbosePatchUnavailable)
            return;
        try {
            await this.transport.request("sessions.patch", { key: this.sessionKey, verboseLevel: "full" });
        }
        catch (err) {
            this.verbosePatchUnavailable = true;
            const message = err instanceof Error ? err.message : String(err);
            if (!/missing scope: operator\.admin/i.test(message)) {
                eprintln(c.dim(`verbose event upgrade unavailable: ${message}`));
            }
        }
    }
    async resolveApproval(action) {
        const method = action.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
        try {
            await this.transport.request(method, {
                id: action.approvalId,
                decision: action.decision,
            });
        }
        catch (err) {
            eprintln(c.red(`approval ${action.decision} failed: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    shouldDispatchFrame(frame) {
        return shouldDispatchFrameForActiveRun(frame, {
            sessionKey: this.sessionKey,
            activeRunIds: this.activeRunIds,
        });
    }
    shouldAcceptRunId(runId) {
        if (!runId)
            return true;
        return this.activeRunIds.has(runId);
    }
}
export function passLine(line) {
    println(line);
}
/**
 * Best-effort extractor for the events array returned by chat.history.
 * Different gateway versions may shape the response slightly differently;
 * accept a few common shapes. Returns [] if nothing usable.
 */
function extractHistoryEvents(resp) {
    if (!resp || typeof resp !== "object")
        return [];
    const r = resp;
    const list = Array.isArray(r.events)
        ? r.events
        : Array.isArray(r.frames)
            ? r.frames
            : null;
    if (!list)
        return [];
    return list.filter((e) => {
        return Boolean(e && typeof e === "object" && e.type === "event"
            && typeof e.event === "string");
    });
}
function extractRunId(resp) {
    if (!resp || typeof resp !== "object")
        return null;
    const runId = resp.runId;
    return typeof runId === "string" && runId.length > 0 ? runId : null;
}
export function resolveFrameSessionKey(frame) {
    const payload = asRecord(frame.payload);
    const topLevel = readNonEmptyString(payload?.sessionKey);
    if (topLevel)
        return topLevel;
    const data = asRecord(payload?.data);
    return readNonEmptyString(data?.sessionKey);
}
export function resolveFrameRunId(frame) {
    const payload = asRecord(frame.payload);
    const topLevel = readNonEmptyString(payload?.runId);
    if (topLevel)
        return topLevel;
    const data = asRecord(payload?.data);
    return readNonEmptyString(data?.runId);
}
export function shouldDispatchFrameForActiveRun(frame, args) {
    if (frame.event === "tick" || frame.event === "shutdown")
        return true;
    const sessionKey = resolveFrameSessionKey(frame);
    if (sessionKey && args.sessionKey && sessionKey !== args.sessionKey) {
        return false;
    }
    const runId = resolveFrameRunId(frame);
    if (isRunScopedFrame(frame) && runId && !args.activeRunIds.has(runId)) {
        return false;
    }
    if (sessionKey) {
        return args.sessionKey === null || sessionKey === args.sessionKey;
    }
    return !isSessionScopedFrame(frame);
}
function isRunScopedFrame(frame) {
    return frame.event === "chat" || frame.event === "chat.side_result" ||
        frame.event === "agent" || frame.event === "session.tool";
}
function isSessionScopedFrame(frame) {
    return isRunScopedFrame(frame) || frame.event === "sessions.changed" ||
        frame.event === "session.message";
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function readNonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
