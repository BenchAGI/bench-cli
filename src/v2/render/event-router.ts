// Top-level event router — SPEC §6 (post-ANVIL P1 fix).
// Routes EventFrame.event values to the right renderer paths and handles
// session.tool dedup against agent events.

import type { EventFrame, AgentEventPayload } from "../protocol/types.js";

export type LivenessClock = {
  recordEvent(now: number, isTick: boolean): void;
};

export type RouterHandlers = {
  onChatDelta(payload: unknown, runId?: string): void;
  onChatFinal(payload: unknown, runId?: string): void;
  onChatSideResult(payload: unknown): void;
  onAgent(payload: AgentEventPayload): void;
  onSessionsChanged(payload: unknown): void;
  onShutdown(reason: string, restartExpectedMs?: number): void;
  onApprovalResolved(kind: "exec" | "plugin", payload: unknown): void;
  onUnknown(event: string, payload: unknown): void;
  /**
   * Optional. Fires when a per-runId agent-payload seq number jumps by
   * more than 1 (e.g., we saw seq=5 then seq=8 — events 6 and 7 went
   * missing in between). Indicates the renderer's view of the run is
   * incomplete. Called once per gap. V1.1 — Item 1.
   */
  onSeqGap?(runId: string, prevSeq: number, nextSeq: number): void;
};

export class EventRouter {
  private seenKeys = new Set<string>();
  private keyOrder: string[] = [];
  private maxSeen = 1024;
  // Per-run max agent-payload seq, for gap detection (V1.1 — Item 1).
  private maxSeqPerRun = new Map<string, number>();

  constructor(
    private handlers: RouterHandlers,
    private liveness: LivenessClock,
  ) {}

  dispatch(frame: EventFrame): void {
    const now = Date.now();
    const isTick = frame.event === "tick";
    this.liveness.recordEvent(now, isTick);
    if (isTick) return;

    const event = frame.event;
    const payload = frame.payload as Record<string, unknown> | undefined;

    switch (event) {
      case "chat": {
        const state = payload && typeof payload === "object"
          ? (payload as { state?: string; phase?: string }).state
            ?? (payload as { state?: string; phase?: string }).phase
          : undefined;
        const runId = payload && typeof payload === "object" ? (payload as { runId?: string }).runId : undefined;
        if (state === "final" || state === "aborted" || state === "error" || state === "end") {
          this.handlers.onChatFinal(payload, runId);
        } else {
          this.handlers.onChatDelta(payload, runId);
        }
        return;
      }

      case "chat.side_result":
        this.handlers.onChatSideResult(payload);
        return;

      case "agent": {
        if (!payload || typeof payload !== "object") return;
        const ap = payload as unknown as AgentEventPayload;
        const key = this.makeKey("agent", ap);
        if (this.seenKeys.has(key)) return;
        this.recordKey(key);
        this.checkSeqGap(ap);
        this.handlers.onAgent(ap);
        return;
      }

      case "session.tool": {
        // Late-join mirror of run-scoped tool events. Dedupe against
        // already-received agent events with the same identity.
        if (!payload || typeof payload !== "object") return;
        const ap = payload as unknown as AgentEventPayload;
        const key = this.makeKey("agent", ap);
        if (this.seenKeys.has(key)) return;
        this.recordKey(key);
        this.checkSeqGap(ap);
        this.handlers.onAgent(ap);
        return;
      }

      case "sessions.changed":
        this.handlers.onSessionsChanged(payload);
        return;

      case "shutdown": {
        const reason = (payload as { reason?: string })?.reason ?? "unspecified";
        const restart = (payload as { restartExpectedMs?: number })?.restartExpectedMs;
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

  private makeKey(prefix: string, ap: AgentEventPayload): string {
    const data = ap.data as { toolCallId?: string; itemId?: string } | undefined;
    const sub = data?.toolCallId ?? data?.itemId ?? "";
    return `${prefix}|${ap.runId ?? ""}|${ap.seq ?? ""}|${ap.stream ?? ""}|${sub}`;
  }

  private recordKey(key: string): void {
    this.seenKeys.add(key);
    this.keyOrder.push(key);
    if (this.keyOrder.length > this.maxSeen) {
      const evicted = this.keyOrder.shift();
      if (evicted) this.seenKeys.delete(evicted);
    }
  }

  /**
   * Detect per-runId seq-number gaps. We only ever care about the
   * forward direction — replayed events with a smaller seq than already
   * seen are dedupe-rejected upstream and never reach this method. A
   * gap of >1 indicates one or more missed events. V1.1 — Item 1.
   */
  private checkSeqGap(ap: AgentEventPayload): void {
    if (!ap.runId || typeof ap.seq !== "number") return;
    const prev = this.maxSeqPerRun.get(ap.runId);
    if (prev === undefined) {
      this.maxSeqPerRun.set(ap.runId, ap.seq);
      return;
    }
    if (ap.seq <= prev) return;
    if (ap.seq > prev + 1 && this.handlers.onSeqGap) {
      this.handlers.onSeqGap(ap.runId, prev, ap.seq);
    }
    this.maxSeqPerRun.set(ap.runId, ap.seq);
  }
}
