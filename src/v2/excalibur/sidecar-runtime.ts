import { randomUUID } from "node:crypto";

import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { SafeTraceWriter } from "../diagnostics/safe-trace.js";
import type { AgentEventPayload } from "../protocol/types.js";
import { c, println } from "../render/ansi.js";
import type { LivenessSnapshot } from "../render/liveness.js";
import { DEFAULT_RENDERER_OPTIONS, StreamRenderer, type ThinkingMode } from "../render/stream.js";
import type { ConversationRuntime, RunCompletion, RuntimeDisposition } from "../runtime/conversation-runtime.js";
import type { StateScope } from "../state/scope.js";
import { EXCALIBUR_EXPECTED_DIGESTS } from "./contract-baseline.js";
import {
  EXCALIBUR_VIEW_COMMANDS,
  renderApprovalCard,
  renderCapabilities,
  renderReceipt,
  renderReceiptPage,
  renderSnapshot,
} from "./control-render.js";
import {
  ExcaliburHttpTransport,
  ExcaliburTransportError,
  EXCALIBUR_DRAFT_PR_ACTION_ID,
  parseExcaliburApproval,
  parseExcaliburExecutionReceipt,
  parseExcaliburProposal,
  resolveSidecarConnection,
  type ExcaliburApproval,
  type ExcaliburCapability,
  type ExcaliburConversationEvent,
  type ExcaliburConversationScope,
  type ExcaliburConversationSession,
  type ExcaliburControlSession,
  type ExcaliburProposal,
  type ExcaliburTokenProvider,
} from "./http-transport.js";
import {
  loadExcaliburState,
  recordReceipt,
  upsertSession,
  type ExcaliburSessionRecord,
  type ScopedStateOptions,
} from "./scoped-state.js";
import {
  requestOrchestraPublicationIntent,
  resolveOrchestraBrokerConfig,
  runOrchestraCommand,
  type OrchestraExecFile,
} from "./orchestra-broker.js";
import { renderOneSurfaceStartupBrief, summarizeOneSurfaceReadiness } from "./readiness.js";

export type ExcaliburSidecarRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  scope: StateScope;
  contextId: string;
  resumeSessionId?: string;
  transport?: ExcaliburHttpTransport;
  sidecarUrl?: string;
  cloudAccessToken?: ExcaliburTokenProvider | null;
  traceFramesPath?: string;
  showFullToolOutput?: boolean;
  showThinking?: boolean;
  tui?: boolean;
  reconnectDelaysMs?: number[];
  /** Test seam only; production always executes the pinned absolute broker. */
  orchestraExecFileFn?: OrchestraExecFile;
};

const DEFAULT_RECONNECT_DELAYS_MS = [0, 100, 250, 500, 1_000];

async function orchestraHealthLine(
  env: NodeJS.ProcessEnv,
  execFileFn?: OrchestraExecFile,
): Promise<string> {
  const result = await resolveOrchestraBrokerConfig(env, { execFileFn });
  return "reason" in result
    ? `  orchestra: unavailable · ${result.reason} · no fallback`
    : `  orchestra: ready · ${result.executable} · broker ${result.brokerSha256.slice(0, 12)} · resources ${result.resourceSetDigest.slice(0, 12)} · preflight ${result.preflightAttestationDigest.slice(0, 12)}`;
}

function selectedScope(opts: Pick<ExcaliburSidecarRuntimeOptions, "scope" | "contextId">): ExcaliburConversationScope {
  if (opts.contextId === "operator-local") return { kind: "operator" };
  if (opts.scope.instanceId === "unbound" || opts.contextId !== opts.scope.instanceId) {
    throw new ExcaliburTransportError(
      "CONTEXT_SCOPE_MISMATCH",
      "tenant conversation context is not the exact principal-bound instance",
    );
  }
  return { kind: "tenant", instanceId: opts.contextId };
}

function textField(payload: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    if (typeof payload[name] === "string") return payload[name] as string;
  }
  return "";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("event replay aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("event replay aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
}

/**
 * Presentation adapter for the shared Excalibur loopback sidecar.
 *
 * The sidecar owns the provider process, served-model attestation, canonical
 * conversation id, and ordered event ledger. This class only renders that
 * contract for the terminal and reconnects SSE from its last accepted cursor.
 */
export class ExcaliburSidecarRuntime implements ConversationRuntime {
  private transport: ExcaliburHttpTransport | null;
  private controlSession: ExcaliburControlSession | null = null;
  private session: ExcaliburConversationSession | null = null;
  private connected = false;
  private currentRunId: string | null = null;
  private cursor = 0;
  private lastEventAt = Date.now();
  private reconnectAttempt: number | null = null;
  private eventAbort: AbortController | null = null;
  private readonly renderer: StreamRenderer;
  private readonly trace: SafeTraceWriter | null;
  private thinkingMode: ThinkingMode;
  private completions = new Map<string, Exclude<RunCompletion, "timeout">>();
  private completionWaiters = new Map<string, Set<(value: Exclude<RunCompletion, "timeout">) => void>>();
  private proposals = new Map<string, ExcaliburProposal>();
  private capabilities = new Map<string, ExcaliburCapability>();
  private pendingApproval: { proposal: ExcaliburProposal; approval: ExcaliburApproval } | null = null;
  private approvalInFlight = false;
  private awaitingReceipts = new Set<string>();
  private reconciliationPending = new Set<string>();

  constructor(private readonly opts: ExcaliburSidecarRuntimeOptions) {
    this.transport = opts.transport ?? null;
    this.thinkingMode = opts.showThinking === false ? "off" : "on";
    this.renderer = new StreamRenderer({
      ...DEFAULT_RENDERER_OPTIONS,
      showFullToolOutput: Boolean(opts.showFullToolOutput),
      showThinking: opts.showThinking !== false,
      assistantLabel: "Grok",
    });
    this.trace = opts.traceFramesPath ? new SafeTraceWriter(opts.traceFramesPath) : null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const scope = selectedScope(this.opts);
    if (!this.transport) {
      const env = this.opts.sidecarUrl
        ? { ...(this.opts.env ?? process.env), EXCALIBUR_SIDECAR_URL: this.opts.sidecarUrl }
        : (this.opts.env ?? process.env);
      const connection = await resolveSidecarConnection(env);
      this.transport = new ExcaliburHttpTransport({
        baseUrl: connection.baseUrl,
        posture: "sidecar",
        scope,
        accessToken: connection.token,
        cloudAccessToken: scope.kind === "tenant"
          ? this.opts.cloudAccessToken === null
            ? undefined
            : this.opts.cloudAccessToken ?? (async () => (
              await loadFreshFirebaseIdToken().catch(() => null)
            ) || undefined)
          : undefined,
      });
    }
    if (this.transport.posture !== "sidecar") {
      throw new TypeError("ExcaliburSidecarRuntime requires a sidecar transport");
    }
    if (!sameScope(this.transport.scope, scope)) {
      throw new ExcaliburTransportError("CONTEXT_SCOPE_MISMATCH", "sidecar transport was created for another scope");
    }

    this.controlSession = await this.transport.getControlSession();
    const session = this.opts.resumeSessionId
      ? await this.transport.resumeConversation(this.opts.resumeSessionId)
      : await this.transport.createConversation();
    if (session.state !== "active") {
      throw new ExcaliburTransportError("CONVERSATION_CLOSED", "the selected shared conversation is no longer active");
    }
    this.session = session;
    this.cursor = session.eventCursor;
    // Load the content-free adapter posture first so the following projection reflects
    // the same initialized memory context. Neither response is submitted as a model turn.
    const memoryStatus = await this.transport.getMemoryStatus().catch(() => null);
    const [snapshot, capabilities, receiptProbe] = await Promise.all([
      this.transport.getSnapshot(),
      this.transport.getCapabilities(),
      this.transport.getReceipts({ limit: 1 })
        .then((page) => ({ page, error: null as string | null }))
        .catch((error: Error) => ({ page: null, error: error.message })),
    ]);
    this.capabilities = new Map(capabilities.map((item) => [item.capabilityId, item]));
    const startupBrief = renderOneSurfaceStartupBrief(summarizeOneSurfaceReadiness({
      controlSession: this.controlSession,
      snapshot,
      conversation: session,
      memoryStatus,
      capabilities,
      receiptPage: receiptProbe.page,
      receiptProbeError: receiptProbe.error,
    }));
    startupBrief.push(await orchestraHealthLine(
      this.opts.env ?? process.env,
      this.opts.orchestraExecFileFn,
    ));
    for (const [index, line] of startupBrief.entries()) {
      println(index === 0 ? c.bold(line) : c.dim(line));
    }
    this.connected = true;
    this.lastEventAt = Date.now();
    await this.persistSession("open");
    await recordReceipt({
      kind: "session-open",
      status: "ready",
      sessionId: session.sessionId,
      provider: "excalibur-sidecar",
      detail: `shared loopback · ${session.providerSession.servedModel} · cursor ${session.eventCursor}`,
    }, this.stateOptions());
  }

  /** Detach from an idle shared conversation; abort explicitly if a turn is still live. */
  async close(): Promise<void> {
    if (this.currentRunId) await this.interruptCurrent().catch(() => {});
    else this.eventAbort?.abort();
    this.eventAbort = null;
    this.connected = false;
    await this.persistSession(this.session?.state === "active" ? "open" : "closed").catch(() => {});
    await this.trace?.flush();
  }

  async sendMessage(message: string): Promise<string | null> {
    const content = message.trim();
    if (!content) return null;
    if (!this.connected || !this.transport || !this.session) {
      throw new ExcaliburTransportError("RUNTIME_NOT_READY", "shared Excalibur sidecar is not connected");
    }
    if (this.pendingApproval) {
      println(c.yellow("(approval card pending · use [A] or [D]; typed prose cannot approve)"));
      return null;
    }
    if (this.awaitingReceipts.size > 0) {
      println(c.dim("(deterministic execution is awaiting its receipt; no command was resubmitted)"));
      return null;
    }
    if (this.currentRunId) throw new ExcaliburTransportError("TURN_IN_FLIGHT", "a conversation turn is already in flight");
    const clientTurnId = randomUUID();
    this.trace?.append("out", JSON.stringify({
      operation: "conversation.turn",
      sessionId: this.session.sessionId,
      clientTurnId,
      content,
    }));
    const accepted = await this.transport.submitTurn(this.session.sessionId, {
      content,
      clientTurnId,
    });
    this.currentRunId = accepted.runId;
    this.lastEventAt = Date.now();
    this.renderer.renderAgent(this.renderEvent("lifecycle", { phase: "start" }, accepted.runId));
    this.eventAbort = new AbortController();
    void this.pumpEvents(accepted.runId, this.eventAbort.signal);
    return accepted.runId;
  }

  async waitForFinal(timeoutMs: number, runId = this.currentRunId || undefined): Promise<RunCompletion> {
    if (!runId) return "error";
    const known = this.completions.get(runId);
    if (known) return known;
    return await new Promise<RunCompletion>((resolve) => {
      const waiters = this.completionWaiters.get(runId) ?? new Set();
      let timer: NodeJS.Timeout;
      const done = (value: Exclude<RunCompletion, "timeout">): void => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(value);
      };
      waiters.add(done);
      this.completionWaiters.set(runId, waiters);
      timer = setTimeout(() => {
        waiters.delete(done);
        resolve("timeout");
      }, Math.max(1, timeoutMs));
      timer.unref();
    });
  }

  async interruptCurrent(): Promise<RuntimeDisposition> {
    if (this.pendingApproval) {
      await this.decidePendingApproval("denied");
      return "denied";
    }
    const runId = this.currentRunId;
    if (!runId || !this.session || !this.transport) return "aborted";
    this.eventAbort?.abort();
    this.eventAbort = null;
    try {
      const receipt = await this.transport.abortConversation(this.session.sessionId);
      this.session = { ...this.session, state: receipt.state, updatedAt: receipt.occurredAt };
    } finally {
      this.finishRun(runId, "aborted");
      await this.persistSession("closed").catch(() => {});
    }
    return "aborted";
  }

  canHandleApprovalKey(key: string): boolean {
    if ((key === "r" || key === "R") && this.currentRunId) return true;
    return !this.approvalInFlight && Boolean(this.pendingApproval)
      && ["a", "A", "d", "D"].includes(key);
  }

  async handleApprovalKey(key: string): Promise<boolean> {
    if (key === "r" || key === "R") {
      if (!this.currentRunId) return false;
      const on = this.renderer.toggleFullOutput();
      println(c.dim(`(expand mode: ${on ? "on" : "off"})`));
      return true;
    }
    if (!this.canHandleApprovalKey(key)) return false;
    await this.decidePendingApproval(key === "a" || key === "A" ? "approved" : "denied");
    return true;
  }

  hasPendingApproval(): boolean { return Boolean(this.pendingApproval); }

  healthSnapshot(): LivenessSnapshot {
    return {
      state: this.reconnectAttempt !== null ? "reconnecting" : this.connected ? "ok" : "unhealthy",
      runQuietMs: Math.max(0, Date.now() - this.lastEventAt),
      gatewayTickMs: 0,
      inFlight: Boolean(this.currentRunId),
      reconnectAttempt: this.reconnectAttempt,
      reconnectDelayMs: this.reconnectAttempt === null
        ? null
        : (this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)[this.reconnectAttempt] ?? null,
    };
  }

  isInFlight(): boolean { return Boolean(this.currentRunId); }
  currentRun(): string | null { return this.currentRunId; }
  resumeKey(): string | null { return this.session?.sessionId || null; }
  setThinking(mode: ThinkingMode): ThinkingMode {
    this.thinkingMode = this.renderer.setThinking(mode);
    return this.thinkingMode;
  }
  getThinking(): ThinkingMode { return this.thinkingMode; }
  isExpanded(): boolean { return this.renderer.isFullOutput(); }
  expandLastTool(): boolean { return this.renderer.expandLast(); }
  currentModel(): string { return this.session?.providerSession.servedModel || "grok-4.5"; }
  async setModel(_model: string): Promise<boolean> { return false; }
  async setThinkingLevel(_level: string): Promise<boolean> { return false; }
  hasSession(): boolean { return Boolean(this.session); }

  async runControlCommand(command: string, _args: string[]): Promise<string[]> {
    if (!this.transport || !this.controlSession || !this.session) {
      throw new ExcaliburTransportError("RUNTIME_NOT_READY", "shared Excalibur control reads are not connected");
    }
    if (command === "orchestra") {
      if (_args[0] === "propose") {
        if (_args.length !== 3) {
          return ["Orchestra · usage: /orchestra propose <mission-id> <absolute-owner-private-details-json>"];
        }
        if (this.controlSession.effectsPosture !== "approval_bound") {
          return [
            "Orchestra · publication proposal locked",
            `  Excalibur effects posture is ${this.controlSession.effectsPosture}; no broker or executor was invoked`,
          ];
        }
        if (this.currentRunId || this.pendingApproval || this.approvalInFlight
            || this.awaitingReceipts.size > 0) {
          return [
            "Orchestra · publication proposal locked",
            "  finish the active turn, approval, or receipt before creating another exact proposal",
          ];
        }
        const requested = await requestOrchestraPublicationIntent(_args[1] as string, _args[2] as string, {
          env: this.opts.env ?? process.env,
          execFileFn: this.opts.orchestraExecFileFn,
        });
        if ("reason" in requested) {
          return [
            "Orchestra · publication proposal unavailable",
            `  ${requested.reason}`,
            "  no proposal, approval, or executor was invoked",
          ];
        }
        if (requested.publication.intent.payload.principalId
              !== this.controlSession.principal.principalId
            || requested.publication.intent.payload.sessionId !== this.session.sessionId) {
          return [
            "Orchestra · publication proposal unavailable",
            "  broker provenance does not bind the authenticated principal and active conversation",
            "  no proposal, approval, publisher verification, provider read, or executor was invoked",
          ];
        }
        const created = await this.transport.createProposal({
          conversationId: this.session.sessionId,
          intent: requested.publication.intent,
        });
        this.acceptCorrelatedProposal(created.proposal);
        this.acceptApproval(created.approval);
        if (created.receipt) {
          this.acceptExecutionReceipt(created.receipt, created.proposal.commandId);
        }
        return [
          `Orchestra · publication proposal ${created.replayed ? "replayed" : "created"}`,
          `  mission: ${requested.publication.intent.payload.missionId as string} @ ${requested.publication.intent.payload.missionDigest as string}`,
          `  publication gate: ${requested.publication.publicationGateDigest}`,
          `  intent digest: ${requested.publication.intentDigest}`,
          "  exact sidecar approval card is active; no executor runs before [A]",
        ];
      }
      if (["prepare", "advance"].includes(_args[0] || "")
          && this.controlSession.effectsPosture !== "approval_bound") {
        return [
          `Orchestra · ${_args[0]} locked`,
          `  Excalibur effects posture is ${this.controlSession.effectsPosture}; no broker was invoked`,
        ];
      }
      return await runOrchestraCommand(_args, {
        env: this.opts.env ?? process.env,
        execFileFn: this.opts.orchestraExecFileFn,
        principalId: this.controlSession.principal.principalId,
        sessionId: this.session.sessionId,
        onProgress: (line) => println(c.dim(line)),
      });
    }
    const capabilityId = EXCALIBUR_VIEW_COMMANDS[command as keyof typeof EXCALIBUR_VIEW_COMMANDS];
    if (capabilityId) return renderSnapshot(await this.transport.getSnapshot(), capabilityId);
    if (command === "receipts") return renderReceiptPage(await this.transport.getReceipts({ limit: 50 }));
    if (command === "controls") return renderCapabilities(await this.transport.getCapabilities());
    if (command === "memory") return renderSnapshot(await this.transport.getSnapshot(), "memory.status");

    const session = await this.transport.getControlSession();
    this.controlSession = session;
    const instance = session.contextKind === "tenant" ? session.activeInstance?.instanceId : "operator-local";
    if (command === "context") {
      return [
        `Context · ${instance}`,
        `  scope: ${session.contextKind} · effects: ${session.effectsPosture} · auth: ${session.authMethod}`,
      ];
    }
    if (command === "seat") {
      return [
        "Seat · Grok 4.5",
        `  provider: xai · requested: grok-4.5 · served: ${this.session.providerSession.servedModel}`,
        `  attestation: ${this.session.providerSession.attestationDigest}`,
      ];
    }
    if (command === "route") {
      return [
        "Route · excalibur-v1-grok-4.5-exact",
        "  transport: ACP · fallback: none · served-model attestation: required",
        `  protocol: ${session.digests?.protocol ?? EXCALIBUR_EXPECTED_DIGESTS.protocol}`,
        `  manifest: ${session.digests?.manifest ?? EXCALIBUR_EXPECTED_DIGESTS.manifest}`,
        `  routing: ${session.digests?.routing ?? EXCALIBUR_EXPECTED_DIGESTS.routing}`,
      ];
    }
    if (command === "status" || command === "might") {
      const memoryStatus = await this.transport.getMemoryStatus().catch(() => null);
      const [snapshot, capabilities, receiptProbe] = await Promise.all([
        this.transport.getSnapshot(),
        this.transport.getCapabilities(),
        this.transport.getReceipts({ limit: 1 })
          .then((page) => ({ page, error: null as string | null }))
          .catch((error: Error) => ({ page: null, error: error.message })),
      ]);
      const lines = renderOneSurfaceStartupBrief(summarizeOneSurfaceReadiness({
        controlSession: session,
        snapshot,
        conversation: this.session,
        capabilities,
        memoryStatus,
        receiptPage: receiptProbe.page,
        receiptProbeError: receiptProbe.error,
      })).map((line, index) => index === 0 ? line.replace("startup", "status") : line);
      if (this.reconciliationPending.size) {
        lines.push(`  reconciliation pending: ${this.reconciliationPending.size} indeterminate command(s) · inspect /receipts`);
      }
      lines.push(await orchestraHealthLine(
        this.opts.env ?? process.env,
        this.opts.orchestraExecFileFn,
      ));
      return lines;
    }
    throw new ExcaliburTransportError("BAD_CONTROL_COMMAND", `unsupported Excalibur command: /${command}`);
  }

  private acceptValidatedProposal(event: ExcaliburConversationEvent): void {
    if (!["validated_cloud_broker", "validated_operator_broker"].includes(
      String(event.payload.trust || ""),
    )) {
      println(c.dim("(model proposal received as untrusted text; it has no approval or execution authority)"));
      return;
    }
    const proposal = parseExcaliburProposal(event.payload.proposal);
    this.acceptCorrelatedProposal(proposal, event.runId);
  }

  private acceptCorrelatedProposal(proposal: ExcaliburProposal, eventRunId?: string): void {
    const capability = this.capabilities.get(proposal.actionId);
    const expectedInstance = this.controlSession?.contextKind === "tenant"
      ? this.controlSession.activeInstance?.instanceId
      : "operator";
    const lifetimeMs = Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt);
    if (!this.session || !this.controlSession || !capability || capability.kind !== "action"
        || expectedInstance !== proposal.instanceId
        || proposal.conversationId !== this.session.sessionId
        || (proposal.actionId === EXCALIBUR_DRAFT_PR_ACTION_ID
          && (proposal.payload.principalId !== this.controlSession.principal.principalId
            || proposal.payload.sessionId !== this.session.sessionId))
        || (eventRunId !== undefined && eventRunId !== proposal.commandId)
        || proposal.policyResult.decision !== "allow"
        || capability.availability.status === "unavailable"
        || proposal.approvalId.length === 0
        || lifetimeMs <= 0
        || capability.approvalPolicy.kind !== "single_human_exact_digest"
        || lifetimeMs > capability.approvalPolicy.expiresInSeconds * 1_000) {
      throw new ExcaliburTransportError(
        "PROPOSAL_CORRELATION_FAILED",
        "brokered proposal did not match this exact conversation and capability contract",
      );
    }
    this.proposals.set(proposal.proposalId, proposal);
    println(c.dim(`(validated proposal ${proposal.commandId} · awaiting exact server approval card)`));
  }

  private acceptApproval(approval: ExcaliburApproval, eventRunId?: string): void {
    const proposal = this.proposals.get(approval.proposalId);
    if (!proposal) {
      if (approval.decision === "pending") {
        throw new ExcaliburTransportError(
          "APPROVAL_CORRELATION_FAILED",
          "pending approval arrived without its validated proposal",
        );
      }
      return;
    }
    if (!this.controlSession || !this.session
        || approval.approvalId !== proposal.approvalId
        || approval.proposalDigest !== proposal.proposalDigest
        || approval.expiresAt !== proposal.expiresAt
        || approval.principalId !== this.controlSession.principal.principalId
        || approval.grantedScope.length !== 1
        || approval.grantedScope[0] !== proposal.actionId
        || (approval.decision === "pending" && proposal.actionId === EXCALIBUR_DRAFT_PR_ACTION_ID
          && !approval.confirmationNonce)
        || proposal.conversationId !== this.session.sessionId
        || (eventRunId !== undefined && eventRunId !== proposal.commandId)) {
      throw new ExcaliburTransportError(
        "APPROVAL_CORRELATION_FAILED",
        "approval did not bind the exact validated proposal and principal",
      );
    }

    if (approval.decision === "pending") {
      const expectedInstance = this.controlSession.contextKind === "tenant"
        ? this.controlSession.activeInstance?.instanceId : "operator";
      if (this.controlSession.effectsPosture !== "approval_bound"
          || expectedInstance !== proposal.instanceId
          || Date.parse(approval.expiresAt) <= Date.now()) {
        throw new ExcaliburTransportError(
          "APPROVAL_POSTURE_LOCKED",
          "approval card is expired or the tenant control session is not approval-bound",
        );
      }
      if (this.pendingApproval && this.pendingApproval.approval.approvalId !== approval.approvalId) {
        throw new ExcaliburTransportError("APPROVAL_COLLISION", "another exact approval card is already pending");
      }
      this.pendingApproval = { proposal, approval };
      const card = renderApprovalCard(proposal, approval);
      for (const [index, line] of card.entries()) {
        println(index === 0 || index === card.length - 1 ? c.yellow(line) : line);
      }
      return;
    }

    if (this.pendingApproval?.approval.approvalId === approval.approvalId) this.pendingApproval = null;
    if (approval.decision === "approved") {
      this.awaitingReceipts.add(approval.approvalId);
      println(c.dim(`(approval ${approval.approvalId} consumed · deterministic receipt pending)`));
    } else {
      this.awaitingReceipts.delete(approval.approvalId);
      this.proposals.delete(proposal.proposalId);
      println(c.dim(`(approval ${approval.decision})`));
    }
  }

  private acceptReceipt(event: ExcaliburConversationEvent): void {
    this.acceptExecutionReceipt(parseExcaliburExecutionReceipt(event.payload.receipt), event.runId);
  }

  private acceptExecutionReceipt(
    receipt: ReturnType<typeof parseExcaliburExecutionReceipt>,
    eventRunId: string,
  ): void {
    const proposal = this.proposals.get(receipt.proposalId);
    if (!proposal || !this.session
        || receipt.commandId !== proposal.commandId
        || receipt.approvalId !== proposal.approvalId
        || receipt.conversationId !== proposal.conversationId
        || receipt.instanceId !== proposal.instanceId
        || receipt.actionId !== proposal.actionId
        || receipt.idempotencyKey !== proposal.idempotencyKey
        || eventRunId !== proposal.commandId
        || receipt.conversationId !== this.session.sessionId) {
      throw new ExcaliburTransportError(
        "RECEIPT_CORRELATION_FAILED",
        "execution receipt did not bind the exact validated proposal",
      );
    }
    const release = ["succeeded", "failed", "expired", "indeterminate", "reconciled"].includes(receipt.outcome);
    if (release) this.awaitingReceipts.delete(receipt.approvalId);
    if (receipt.outcome === "indeterminate") {
      this.reconciliationPending.add(receipt.proposalId);
    } else if (["succeeded", "failed", "expired", "reconciled"].includes(receipt.outcome)) {
      this.reconciliationPending.delete(receipt.proposalId);
      this.proposals.delete(receipt.proposalId);
    }
    for (const line of renderReceipt(receipt)) println(c.dim(line));
  }

  private async decidePendingApproval(decision: "approved" | "denied"): Promise<void> {
    if (!this.pendingApproval || !this.transport || this.approvalInFlight) return;
    const pending = this.pendingApproval;
    if (Date.parse(pending.approval.expiresAt) <= Date.now()) {
      this.pendingApproval = null;
      this.proposals.delete(pending.proposal.proposalId);
      println(c.dim("(approval expired; no decision was submitted)"));
      return;
    }
    this.approvalInFlight = true;
    try {
      const resolved = await this.transport.decideApproval(pending.approval.approvalId, {
        decision,
        proposalDigest: pending.proposal.proposalDigest,
        ...(pending.proposal.actionId === EXCALIBUR_DRAFT_PR_ACTION_ID
          ? { confirmationNonce: pending.approval.confirmationNonce }
          : {}),
      });
      if (resolved.approval.decision !== decision) {
        throw new ExcaliburTransportError("APPROVAL_DECISION_MISMATCH", "server returned a different approval decision");
      }
      this.acceptApproval(resolved.approval);
      if (resolved.receipt) this.acceptExecutionReceipt(resolved.receipt, pending.proposal.commandId);
      if (resolved.executionUnconfirmed) {
        println(c.yellow("(execution outcome unconfirmed · reconciliation receipt required; command will not be replayed)"));
      }
      if (decision === "denied" && this.currentRunId === null) this.eventAbort?.abort();
    } finally {
      this.approvalInFlight = false;
    }
  }

  private async pumpEvents(runId: string, signal: AbortSignal): Promise<void> {
    if (!this.transport || !this.session) return this.finishRun(runId, "error");
    const delays = this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    let failure: Error | null = null;
    for (let attempt = 0; attempt < delays.length && !signal.aborted; attempt += 1) {
      this.reconnectAttempt = attempt === 0 ? null : attempt;
      try {
        await sleep(delays[attempt] ?? 0, signal);
        for await (const event of this.transport.streamEvents(this.session.sessionId, this.cursor, signal)) {
          if (signal.aborted) return;
          failure = null;
          this.reconnectAttempt = null;
          const completed = this.acceptEvent(event, runId);
          if (completed) return;
        }
        if (this.completions.has(runId) && !this.pendingApproval && this.awaitingReceipts.size === 0) return;
        failure = new ExcaliburTransportError("SSE_DISCONNECTED", "sidecar event stream ended before the turn completed");
      } catch (error) {
        if (signal.aborted) return;
        failure = error as Error;
      }
    }
    this.reconnectAttempt = null;
    if (signal.aborted || this.completions.has(runId)) return;
    this.renderer.renderAgent(this.renderEvent("error", {
      message: failure instanceof ExcaliburTransportError
        ? "shared Excalibur event stream was lost; the turn was not replayed as a new request"
        : "shared Excalibur event stream failed",
    }, runId));
    this.finishRun(runId, "error");
  }

  private acceptEvent(event: ExcaliburConversationEvent, expectedRunId: string): boolean {
    this.trace?.append("in", JSON.stringify(event));
    if (!this.session || event.sessionId !== this.session.sessionId) {
      throw new ExcaliburTransportError("SESSION_EVENT_MISMATCH", "sidecar emitted an event for another conversation");
    }
    if (event.sequence <= this.cursor) return false;
    if (event.sequence !== this.cursor + 1) {
      throw new ExcaliburTransportError(
        "EVENT_SEQUENCE_GAP",
        `sidecar event sequence gap: expected ${this.cursor + 1}, received ${event.sequence}`,
      );
    }
    this.cursor = event.sequence;
    this.lastEventAt = Date.now();
    this.session = { ...this.session, eventCursor: this.cursor, updatedAt: event.timestamp };

    // Broker lifecycle events intentionally use commandId as runId. They may
    // therefore differ from the originating model turn, but are accepted only
    // after their full proposal/approval/receipt correlation validates below.
    const brokerLifecycle = event.type === "proposal.created"
      || event.type === "approval.updated"
      || event.type === "execution.receipt";
    // A concurrent desktop chat turn is never adopted by this CLI request.
    if (event.runId !== expectedRunId && !brokerLifecycle) return false;
    switch (event.type) {
      case "assistant.delta": {
        const text = textField(event.payload, "text", "delta");
        if (text) this.renderer.renderAgent(this.renderEvent("assistant", { phase: "delta", delta: text }, event.runId));
        return false;
      }
      case "assistant.final": {
        const text = textField(event.payload, "text", "content");
        this.renderer.renderAgent(this.renderEvent("assistant", { phase: "final", text }, event.runId));
        this.finishRun(expectedRunId, "final");
        return !this.pendingApproval && this.awaitingReceipts.size === 0;
      }
      case "proposal.created":
        this.acceptValidatedProposal(event);
        return false;
      case "approval.updated": {
        this.acceptApproval(parseExcaliburApproval(event.payload.approval), event.runId);
        return this.completions.has(expectedRunId)
          && !this.pendingApproval && this.awaitingReceipts.size === 0;
      }
      case "execution.receipt":
        this.acceptReceipt(event);
        return this.completions.has(expectedRunId)
          && !this.pendingApproval && this.awaitingReceipts.size === 0;
      case "conversation.closed":
        this.session = { ...this.session, state: "closed" };
        this.finishRun(event.runId, "aborted");
        return true;
      case "error": {
        const code = textField(event.payload, "code") || "turn-failed";
        this.renderer.renderAgent(this.renderEvent("error", { message: `Excalibur sidecar: ${code}` }, event.runId));
        this.finishRun(event.runId, "error");
        return true;
      }
      default:
        return false;
    }
  }

  private finishRun(runId: string, outcome: Exclude<RunCompletion, "timeout">): void {
    if (this.completions.has(runId)) return;
    this.renderer.renderAgent(this.renderEvent("lifecycle", { phase: "end" }, runId));
    this.completions.set(runId, outcome);
    if (this.currentRunId === runId) this.currentRunId = null;
    this.reconnectAttempt = null;
    const waiters = this.completionWaiters.get(runId);
    if (waiters) {
      for (const waiter of waiters) waiter(outcome);
      this.completionWaiters.delete(runId);
    }
    void this.persistSession(this.session?.state === "active" ? "open" : "closed");
  }

  private renderEvent(stream: AgentEventPayload["stream"], data: unknown, runId: string): AgentEventPayload {
    return {
      runId,
      seq: this.cursor,
      stream,
      ts: Date.now(),
      data,
      sessionKey: this.session?.sessionId,
    };
  }

  private stateOptions(): ScopedStateOptions {
    return { scope: this.opts.scope, env: this.opts.env };
  }

  private async persistSession(status: ExcaliburSessionRecord["status"]): Promise<void> {
    if (!this.session) return;
    const state = await loadExcaliburState(this.stateOptions());
    const prior = state.sessions.find((item) => item.sessionId === this.session!.sessionId);
    const now = new Date().toISOString();
    await upsertSession({
      // The local record intentionally uses the canonical sidecar id. Desktop
      // and terminal therefore resume the same scoped conversation identity.
      sessionId: this.session.sessionId,
      provider: "excalibur-sidecar",
      nativeSessionId: this.session.sessionId,
      model: this.session.providerSession.servedModel,
      contextId: this.opts.contextId,
      startedAt: prior?.startedAt || this.session.createdAt || now,
      updatedAt: now,
      status,
    }, this.stateOptions());
  }
}

function sameScope(a: ExcaliburConversationScope, b: ExcaliburConversationScope): boolean {
  return a.kind === b.kind && (a.kind === "operator" || (b.kind === "tenant" && a.instanceId === b.instanceId));
}

export const __testing = { selectedScope };
