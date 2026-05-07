// Top-level event router — SPEC §6 (post-ANVIL P1 fix).
// Routes EventFrame.event values to the right renderer paths and handles
// session.tool dedup against agent events.
export class EventRouter {
    handlers;
    liveness;
    seenKeys = new Set();
    keyOrder = [];
    maxSeen = 1024;
    // Per-run max agent-payload seq, for gap detection (V1.1 — Item 1).
    maxSeqPerRun = new Map();
    constructor(handlers, liveness) {
        this.handlers = handlers;
        this.liveness = liveness;
    }
    dispatch(frame) {
        const now = Date.now();
        const isTick = frame.event === "tick";
        this.liveness.recordEvent(now, isTick);
        if (isTick)
            return;
        const event = frame.event;
        const payload = frame.payload;
        switch (event) {
            case "chat": {
                const state = payload && typeof payload === "object"
                    ? payload.state
                        ?? payload.phase
                    : undefined;
                const runId = payload && typeof payload === "object" ? payload.runId : undefined;
                if (state === "final" || state === "aborted" || state === "error" || state === "end") {
                    this.handlers.onChatFinal(payload, runId);
                }
                else {
                    this.handlers.onChatDelta(payload, runId);
                }
                return;
            }
            case "chat.side_result":
                this.handlers.onChatSideResult(payload);
                return;
            case "agent": {
                if (!payload || typeof payload !== "object")
                    return;
                const ap = payload;
                const key = this.makeKey("agent", ap);
                if (this.seenKeys.has(key))
                    return;
                this.recordKey(key);
                this.checkSeqGap(ap);
                this.handlers.onAgent(ap);
                return;
            }
            case "session.tool": {
                // Late-join mirror of run-scoped tool events. Dedupe against
                // already-received agent events with the same identity.
                if (!payload || typeof payload !== "object")
                    return;
                const ap = payload;
                const key = this.makeKey("agent", ap);
                if (this.seenKeys.has(key))
                    return;
                this.recordKey(key);
                this.checkSeqGap(ap);
                this.handlers.onAgent(ap);
                return;
            }
            case "sessions.changed":
                this.handlers.onSessionsChanged(payload);
                return;
            case "shutdown": {
                const reason = payload?.reason ?? "unspecified";
                const restart = payload?.restartExpectedMs;
                this.handlers.onShutdown(reason, restart);
                return;
            }
            case "exec.approval.resolved":
                this.handlers.onApprovalResolved("exec", payload);
                return;
            case "plugin.approval.resolved":
                this.handlers.onApprovalResolved("plugin", payload);
                return;
            default:
                this.handlers.onUnknown(event, payload);
        }
    }
    makeKey(prefix, ap) {
        const data = ap.data;
        const sub = data?.toolCallId ?? data?.itemId ?? "";
        return `${prefix}|${ap.runId ?? ""}|${ap.seq ?? ""}|${ap.stream ?? ""}|${sub}`;
    }
    recordKey(key) {
        this.seenKeys.add(key);
        this.keyOrder.push(key);
        if (this.keyOrder.length > this.maxSeen) {
            const evicted = this.keyOrder.shift();
            if (evicted)
                this.seenKeys.delete(evicted);
        }
    }
    /**
     * Detect per-runId seq-number gaps. We only ever care about the
     * forward direction — replayed events with a smaller seq than already
     * seen are dedupe-rejected upstream and never reach this method. A
     * gap of >1 indicates one or more missed events. V1.1 — Item 1.
     */
    checkSeqGap(ap) {
        if (!ap.runId || typeof ap.seq !== "number")
            return;
        const prev = this.maxSeqPerRun.get(ap.runId);
        if (prev === undefined) {
            this.maxSeqPerRun.set(ap.runId, ap.seq);
            return;
        }
        if (ap.seq <= prev)
            return;
        if (ap.seq > prev + 1 && this.handlers.onSeqGap) {
            this.handlers.onSeqGap(ap.runId, prev, ap.seq);
        }
        this.maxSeqPerRun.set(ap.runId, ap.seq);
    }
}
