// Chat runner: ties transport + event router + renderer + liveness +
// approval state into a single durable run loop. Used by the REPL and by
// single-turn commands.

import { LocalGatewayWsTransport } from "./transport/local-gateway.js";
import { resolveGatewayToken, resolveGatewayPassword } from "./auth/gateway-token.js";
import { EventRouter } from "./render/event-router.js";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "./render/stream.js";
import { LivenessIndicator } from "./render/liveness.js";
import { ApprovalState, type ApprovalAction } from "./render/approval.js";
import { classifyByModel, resolveLivenessThreshold, type Liveness } from "./probe/capability.js";
import type { AgentEventPayload, EventFrame } from "./protocol/types.js";
import { PROTOCOL_VERSION } from "./protocol/types.js";
import { c, eprintln, println } from "./render/ansi.js";

export type RunnerOptions = {
  agentId: string;
  modelPrimary?: string;
  liveness?: Liveness;
  showFullToolOutput?: boolean;
  showThinking?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
};

export class ChatRunner {
  private transport: LocalGatewayWsTransport;
  private renderer: StreamRenderer;
  private router!: EventRouter;
  private liveness!: LivenessIndicator;
  private approval!: ApprovalState;
  private sessionKey: string | null = null;
  private currentRunId: string | null = null;
  private connected = false;
  private livenessThresholdMs = 5_000;
  private finalWaiter: ((reason: "final" | "aborted" | "error") => void) | null = null;
  private renderedRunStart = new Set<string>();
  // Highest transport-frame seq observed per session, for chat.history
  // replay on reconnect (V1.1 — Item 1).
  private lastSeenFrameSeq = new Map<string, number>();
  // Set while a chat.history replay is dispatching events through the
  // router, so the gap-warning suppression knows replayed events came
  // from history (a gap was already announced).
  private replayingHistory = false;
  // While `replayingHistory` is true, live event frames are buffered
  // here. After the history replay drains, the buffer drains in arrival
  // order. This prevents the live-vs-history ordering race that would
  // otherwise produce false seq-gap warnings (Codex Anvil P1).
  private liveFrameBuffer: EventFrame[] = [];

  constructor(private opts: RunnerOptions) {
    this.transport = new LocalGatewayWsTransport({ url: opts.gatewayUrl });
    this.renderer = new StreamRenderer({
      ...DEFAULT_RENDERER_OPTIONS,
      showFullToolOutput: opts.showFullToolOutput ?? false,
      showThinking: opts.showThinking ?? true,
    });
  }

  async connect(): Promise<void> {
    const reachable = await this.transport.isReachable();
    if (!reachable) {
      throw Object.assign(
        new Error(
          "Local OpenClaw Gateway not reachable at ws://127.0.0.1:18789. " +
          "Ensure the gateway is running, or run `openclaw doctor`."),
        { exitCode: 2 },
      );
    }

    const token = await resolveGatewayToken(this.opts.gatewayToken);
    const password = await resolveGatewayPassword(this.opts.gatewayPassword);
    const policy = await this.transport.connect({
      url: this.opts.gatewayUrl ?? "ws://127.0.0.1:18789",
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
      throw Object.assign(
        new Error(
          `gateway is missing required methods: ${missing.join(", ")}. ` +
          `Upgrade openclaw to a version supporting protocol v${policy.protocol}.`,
        ),
        { exitCode: 6 },
      );
    }

    // Configure liveness threshold from policy + heuristic.
    const hint = classifyByModel(this.opts.modelPrimary ?? null);
    this.livenessThresholdMs = resolveLivenessThreshold(
      hint,
      this.opts.liveness ?? "auto",
      policy.policy.tickIntervalMs,
    );

    // Wire approval, liveness, router.
    this.approval = new ApprovalState((action) => this.resolveApproval(action));
    this.liveness = new LivenessIndicator({
      agentId: this.opts.agentId,
      pid: process.pid,
      livenessThresholdMs: this.livenessThresholdMs,
      unhealthyTickThresholdMs: Math.max(15_000, 3 * policy.policy.tickIntervalMs),
      stuckRunThresholdMs: 120_000,
    });
    this.liveness.start();

    this.router = new EventRouter(
      {
        onChatDelta: (payload) => this.renderer.renderChatDelta(payload),
        onChatFinal: (payload) => {
          this.renderer.renderChatFinal(payload);
          const state = (payload as { state?: string } | undefined)?.state;
          if (state === "final") this.completeRun("final");
          if (state === "aborted") this.completeRun("aborted");
          if (state === "error") this.completeRun("error");
        },
        onChatSideResult: (payload) => this.renderer.renderChatSideResult(payload),
        onAgent: (ap: AgentEventPayload) => {
          // chat-event style (state-based) detection for batch backends
          // that emit chat events directly.
          if (ap.stream === "lifecycle") {
            const phase = (ap.data as { phase?: string } | undefined)?.phase;
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
              this.completeRun("final");
              return;
            }
          }
          if (ap.stream === "approval") {
            this.approval.onAgentApproval((ap.data as never) ?? null);
            return;
          }
          this.renderer.renderAgent(ap);
        },
        onSessionsChanged: () => { /* future: refresh session cache */ },
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
          if (this.replayingHistory) return;
          eprintln(c.dim(`(events may be incomplete: run ${runId.slice(0, 8)} seq ${prevSeq} → ${nextSeq})`));
        },
      },
      this.liveness,
    );

    // Wire reconnect lifecycle (V1.1 — Item 1 + Item 2).
    this.transport.setReconnectListeners({
      onDisconnected: () => {
        eprintln(c.dim("(connection lost — reconnecting…)"));
      },
      onReconnecting: (attempt, delayMs) => {
        eprintln(
          c.dim(
            `(reconnect attempt ${attempt} in ${Math.round(delayMs / 1000)}s)`,
          ),
        );
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
  private async replayHistoryAfterReconnect(): Promise<void> {
    if (!this.sessionKey) return;
    // Set the replay flag BEFORE the chat.history request so any live
    // frames the gateway emits during the request are buffered.
    this.replayingHistory = true;
    try {
      const sinceSeq = this.lastSeenFrameSeq.get(this.sessionKey) ?? -1;
      let resp: unknown;
      try {
        resp = await this.transport.request("chat.history", {
          sessionKey: this.sessionKey,
          sinceSeq,
        });
      } catch (err) {
        // TODO(V1.1 follow-up — Codex Anvil P2): retry chat.history
        // with bounded backoff before giving up. Today we proceed with
        // whatever live frames are buffered, which may leave a gap in
        // the rendered output for the missed window.
        eprintln(
          c.red(
            `history replay failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      const events = extractHistoryEvents(resp);
      for (const frame of events) {
        try {
          this.recordFrameSeq(frame);
          this.router.dispatch(frame);
        } catch (err) {
          eprintln(
            c.red(
              `history replay render error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }
      // Drain the live-frame buffer that accumulated during replay.
      // Loop because new frames may have arrived during the drain.
      while (this.liveFrameBuffer.length > 0) {
        const buffered = this.liveFrameBuffer.splice(0);
        for (const frame of buffered) {
          try {
            this.router.dispatch(frame);
          } catch (err) {
            eprintln(
              c.red(
                `live frame drain render error: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        }
      }
    } finally {
      this.replayingHistory = false;
    }
  }

  private recordFrameSeq(frame: EventFrame): void {
    if (typeof frame.seq !== "number" || !this.sessionKey) return;
    const prev = this.lastSeenFrameSeq.get(this.sessionKey) ?? -1;
    if (frame.seq > prev) this.lastSeenFrameSeq.set(this.sessionKey, frame.seq);
  }

  private async eventLoop(): Promise<void> {
    try {
      for await (const frame of this.transport.events()) {
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
            } catch (err) {
              eprintln(c.red(`render error (buffered): ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        try {
          this.router.dispatch(frame);
        } catch (err) {
          eprintln(c.red(`render error: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } catch (err) {
      eprintln(c.red(`event loop terminated: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  async waitForFinal(timeoutMs: number): Promise<"final" | "aborted" | "error" | "timeout"> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finalWaiter = null;
        resolve("timeout");
      }, timeoutMs);
      this.finalWaiter = (reason) => {
        clearTimeout(timer);
        this.finalWaiter = null;
        resolve(reason);
      };
    });
  }

  private completeRun(reason: "final" | "aborted" | "error"): void {
    // V1.1 — Item 2: hide the liveness indicator between REPL turns.
    if (this.liveness) this.liveness.setInFlight(false);
    if (this.finalWaiter) {
      const w = this.finalWaiter;
      this.finalWaiter = null;
      w(reason);
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.connected) throw new Error("not connected");

    // Ensure session with verboseLevel=full.
    if (!this.sessionKey) {
      await this.ensureSession();
    } else {
      await this.transport
        .request("sessions.patch", { key: this.sessionKey, verboseLevel: "full" })
        .catch(() => { /* tolerate older gateways */ });
    }

    const idempotencyKey = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

    try {
      await this.transport.request("chat.send", {
        sessionKey: this.sessionKey,
        message,
        idempotencyKey,
        deliver: true,
      });
    } catch (err) {
      // TODO(V1.1 follow-up — Codex Anvil P1): chat.send acceptance race.
      // If the gateway ACK was lost mid-flight but the run was actually
      // accepted, the user sees "chat.send failed" while history later
      // recovers the run's output. Re-issue chat.send with the same
      // idempotencyKey on reconnect (gateway already dedupes), or call
      // chat.history/sessions.list to confirm acceptance before failing
      // the user-visible send.
      eprintln(c.red(`chat.send failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  async abortCurrent(): Promise<void> {
    if (this.sessionKey) {
      try {
        await this.transport.request("chat.abort", { sessionKey: this.sessionKey });
      } catch (err) {
        eprintln(c.red(`abort failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  /**
   * Route a single keystroke from the REPL to the approval state
   * machine. Returns true if the key was consumed by an approval
   * handler ([A]/[D]), false otherwise (REPL passes through).
   * V1.1 — Item 3.
   */
  async handleApprovalKey(key: string): Promise<boolean> {
    if (!this.approval) return false;
    return await this.approval.handleKey(key);
  }

  /**
   * SIGINT/Ctrl-C disposition. If an approval is pending, default-
   * deny it (per SPEC §6.5). Otherwise, abort the current run.
   * V1.1 — Item 3.
   */
  async interruptCurrent(): Promise<"denied" | "aborted"> {
    if (this.approval?.isPending()) {
      await this.approval.denyOnInterrupt();
      return "denied";
    }
    await this.abortCurrent();
    return "aborted";
  }

  async close(): Promise<void> {
    if (this.liveness) this.liveness.stop();
    await this.transport.close();
  }

  async setLivenessOverride(): Promise<void> {
    // No-op placeholder for runtime --liveness flips.
  }

  resumeKey(): string | null {
    return this.sessionKey;
  }

  private async ensureSession(): Promise<void> {
    // ANVIL-3 P1 fix: SessionsCreateParamsSchema rejects `verboseLevel` as an
    // additional property. Create with only allowed fields, then assert
    // verboseLevel via sessions.patch (SPEC §5.3).
    const resp = await this.transport
      .request("sessions.create", { agentId: this.opts.agentId })
      .catch(() => null);
    const key = (resp as { key?: string; sessionKey?: string } | null)?.key
      ?? (resp as { key?: string; sessionKey?: string } | null)?.sessionKey;
    if (typeof key === "string" && key.length > 0) {
      this.sessionKey = key;
    } else {
      this.sessionKey = `agent:${this.opts.agentId}`;
    }
    // Now assert full verboseLevel; tolerate older gateways gracefully.
    await this.transport
      .request("sessions.patch", { key: this.sessionKey, verboseLevel: "full" })
      .catch(() => { /* tolerate */ });
  }

  private async resolveApproval(action: ApprovalAction): Promise<void> {
    const method = action.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
    try {
      await this.transport.request(method, {
        id: action.approvalId,
        decision: action.decision,
      });
    } catch (err) {
      eprintln(c.red(`approval ${action.decision} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

export function passLine(line: string): void {
  println(line);
}

/**
 * Best-effort extractor for the events array returned by chat.history.
 * Different gateway versions may shape the response slightly differently;
 * accept a few common shapes. Returns [] if nothing usable.
 */
function extractHistoryEvents(resp: unknown): EventFrame[] {
  if (!resp || typeof resp !== "object") return [];
  const r = resp as { events?: unknown; frames?: unknown };
  const list = Array.isArray(r.events)
    ? r.events
    : Array.isArray(r.frames)
      ? r.frames
      : null;
  if (!list) return [];
  return list.filter((e): e is EventFrame => {
    return Boolean(
      e && typeof e === "object" && (e as { type?: string }).type === "event"
        && typeof (e as { event?: string }).event === "string",
    );
  });
}
