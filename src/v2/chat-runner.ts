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
import type { AgentEventPayload } from "./protocol/types.js";
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
        },
        onApprovalResolved: (kind, payload) => {
          void kind;
          this.approval.onTopLevelResolved(payload);
        },
        onUnknown: (event) => this.renderer.renderUnknownEvent(event),
      },
      this.liveness,
    );

    // Pump events.
    void this.eventLoop();
  }

  private async eventLoop(): Promise<void> {
    try {
      for await (const frame of this.transport.events()) {
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
