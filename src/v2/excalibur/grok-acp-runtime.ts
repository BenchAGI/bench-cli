import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type { AgentEventPayload } from "../protocol/types.js";
import { CLI_VERSION } from "../commands/version.js";
import { c, eprintln, println } from "../render/ansi.js";
import type { LivenessSnapshot } from "../render/liveness.js";
import { DEFAULT_RENDERER_OPTIONS, StreamRenderer, type ThinkingMode } from "../render/stream.js";
import type { ConversationRuntime, RunCompletion, RuntimeDisposition } from "../runtime/conversation-runtime.js";
import type { StateScope } from "../state/scope.js";
import {
  loadExcaliburState,
  recordReceipt,
  upsertSession,
  type ExcaliburSessionRecord,
  type ScopedStateOptions,
} from "./scoped-state.js";
import { managedGrokEnvironment, prepareManagedGrok, type GrokManagedPaths } from "./grok-managed.js";

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type GrokAcpRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  model?: string;
  scope?: StateScope;
  resumeSessionId?: string;
  excaliburSessionId?: string;
  contextId?: string;
  showFullToolOutput?: boolean;
  showThinking?: boolean;
  tui?: boolean;
};

const ACP_PROTOCOL_VERSION = 1;

function contentText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = value as { type?: string; text?: unknown };
  return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isCancelledStopReason(value: unknown): boolean {
  return typeof value === "string" && /cancel/i.test(value);
}

export class GrokAcpRuntime implements ConversationRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private paths: GrokManagedPaths | null = null;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private nextRequestId = 1;
  private connected = false;
  private closing = false;
  private sessionId: string | null = null;
  private readonly excaliburSessionId: string;
  private currentRunId: string | null = null;
  private completions = new Map<string, Exclude<RunCompletion, "timeout">>();
  private completionWaiters = new Map<string, Set<(value: Exclude<RunCompletion, "timeout">) => void>>();
  private renderer: StreamRenderer;
  private thinkingMode: ThinkingMode;
  private lastEventAt = Date.now();
  private stderrTail = "";
  private sessionCapabilities: Record<string, unknown> = {};

  constructor(private readonly opts: GrokAcpRuntimeOptions = {}) {
    this.excaliburSessionId = opts.excaliburSessionId || randomUUID();
    this.thinkingMode = opts.showThinking === false ? "off" : "on";
    this.renderer = new StreamRenderer({
      ...DEFAULT_RENDERER_OPTIONS,
      showFullToolOutput: Boolean(opts.showFullToolOutput),
      showThinking: opts.showThinking !== false,
      assistantLabel: "Grok",
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.paths = await prepareManagedGrok({ env: this.opts.env, model: this.opts.model, scope: this.opts.scope });
    const child = spawn(
      this.paths.binary,
      ["agent", "--model", this.paths.model, "--no-leader", "stdio"],
      {
        cwd: this.paths.workspace,
        env: managedGrokEnvironment(this.opts.env ?? process.env, this.paths),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      if (!this.closing) {
        const detail = this.stderrTail.trim();
        this.handleExit(new Error(
          `legacy direct Grok ACP exited (${signal || code || 0})${detail ? `: ${detail.slice(-1_000)}` : ""}`,
        ));
      }
    });

    const initialized = await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "excalibur", version: CLI_VERSION },
    }) as { agentCapabilities?: { sessionCapabilities?: Record<string, unknown> } };
    this.sessionCapabilities = initialized?.agentCapabilities?.sessionCapabilities || {};

    if (this.opts.resumeSessionId) {
      await this.request("session/load", {
        sessionId: this.opts.resumeSessionId,
        cwd: this.paths.workspace,
        mcpServers: [],
      });
      this.sessionId = this.opts.resumeSessionId;
    } else {
      const created = await this.request("session/new", {
        cwd: this.paths.workspace,
        mcpServers: [],
        _meta: {
          "excalibur.dev/role": "managed-read-only-conductor",
          "excalibur.dev/context": this.opts.contextId || "operator-local",
        },
      }) as { sessionId?: unknown };
      if (typeof created?.sessionId !== "string" || !created.sessionId.trim()) {
        throw Object.assign(new Error("legacy direct Grok ACP returned no session id"), { exitCode: 6 });
      }
      this.sessionId = created.sessionId;
    }
    this.connected = true;
    await this.persistSession("open");
    await recordReceipt({
      kind: "session-open",
      status: "ready",
      sessionId: this.excaliburSessionId,
      provider: "grok-acp",
      detail: `legacy direct ACP diagnostic · ${this.paths.model}`,
    }, this.stateOptions());
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.child && this.sessionId) {
        if (this.currentRunId) this.notify("session/cancel", { sessionId: this.sessionId });
        if (this.sessionCapabilities.close != null) {
          await Promise.race([
            this.request("session/close", { sessionId: this.sessionId }),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_000);
              timer.unref();
            }),
          ]).catch(() => {});
        }
      }
    } finally {
      this.connected = false;
      this.lines?.close();
      this.lines = null;
      if (this.child && !this.child.killed) this.child.kill("SIGTERM");
      this.child = null;
      this.rejectPending(new Error("legacy direct Grok ACP closed"));
      if (this.sessionId) {
        await this.persistSession("closed").catch(() => {});
        await recordReceipt({
          kind: "session-close",
          status: "closed",
          sessionId: this.excaliburSessionId,
          provider: "grok-acp",
        }, this.stateOptions()).catch(() => {});
      }
    }
  }

  async sendMessage(message: string): Promise<string | null> {
    const text = message.trim();
    if (!text) return null;
    if (!this.connected || !this.sessionId) throw new Error("legacy direct Grok ACP is not connected");
    if (this.currentRunId) throw new Error("a Grok turn is already in flight");
    const runId = randomUUID();
    this.currentRunId = runId;
    this.lastEventAt = Date.now();
    this.renderer.renderAgent(this.event("lifecycle", { phase: "start" }, runId));
    void this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
      messageId: runId,
    }).then((result) => {
      const stopReason = (result as { stopReason?: unknown })?.stopReason;
      this.finishRun(runId, isCancelledStopReason(stopReason) ? "aborted" : "final");
    }).catch((error) => {
      this.renderer.renderAgent(this.event("error", { message: (error as Error).message }, runId));
      this.finishRun(runId, "error");
    });
    return runId;
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
    });
  }

  async interruptCurrent(): Promise<RuntimeDisposition> {
    if (!this.sessionId || !this.currentRunId) return "aborted";
    const runId = this.currentRunId;
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.finishRun(runId, "aborted");
    return "aborted";
  }

  canHandleApprovalKey(_key: string): boolean { return false; }
  async handleApprovalKey(_key: string): Promise<boolean> { return false; }
  hasPendingApproval(): boolean { return false; }

  healthSnapshot(): LivenessSnapshot {
    return {
      state: this.connected ? "ok" : "unhealthy",
      runQuietMs: Math.max(0, Date.now() - this.lastEventAt),
      gatewayTickMs: 0,
      inFlight: Boolean(this.currentRunId),
      reconnectAttempt: null,
      reconnectDelayMs: null,
    };
  }

  isInFlight(): boolean { return Boolean(this.currentRunId); }
  currentRun(): string | null { return this.currentRunId; }
  resumeKey(): string | null { return this.excaliburSessionId; }
  setThinking(mode: ThinkingMode): ThinkingMode {
    this.thinkingMode = this.renderer.setThinking(mode);
    return this.thinkingMode;
  }
  getThinking(): ThinkingMode { return this.thinkingMode; }
  isExpanded(): boolean { return this.renderer.isFullOutput(); }
  expandLastTool(): boolean { return this.renderer.expandLast(); }
  currentModel(): string { return this.paths?.model || this.opts.model || "grok-4.5"; }
  async setModel(_model: string): Promise<boolean> { return false; }
  async setThinkingLevel(_level: string): Promise<boolean> { return false; }
  hasSession(): boolean { return Boolean(this.sessionId); }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("legacy direct Grok ACP stream is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      eprintln(c.dim("(legacy direct Grok ACP emitted a non-protocol line; ignored)"));
      return;
    }
    this.lastEventAt = Date.now();
    if (message.method && message.id !== undefined) {
      this.handleInboundRequest(message);
      return;
    }
    if (message.method) {
      if (message.method === "session/update") this.handleSessionUpdate(message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `ACP error ${message.error.code || "unknown"}`));
      else pending.resolve(message.result);
    }
  }

  private handleInboundRequest(message: JsonRpcMessage): void {
    if (message.method === "session/request_permission") {
      const params = message.params as { toolCall?: { title?: unknown } } | undefined;
      const title = typeof params?.toolCall?.title === "string" ? params.toolCall.title : "effect";
      println(c.dim(`(locked: denied Grok ${title})`));
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Excalibur does not expose ${message.method || "this method"}` },
    });
  }

  private handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const notification = params as { sessionId?: unknown; update?: Record<string, unknown> };
    if (this.sessionId && notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    if (!update || typeof update.sessionUpdate !== "string") return;
    const runId = this.currentRunId || "history";
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (text) this.renderer.renderAgent(this.event("assistant", { phase: "delta", delta: text }, runId));
        return;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (text) this.renderer.renderAgent(this.event("thinking", { phase: "delta", delta: text }, runId));
        return;
      }
      case "tool_call": {
        this.renderer.renderAgent(this.event("tool", {
          phase: "start",
          name: printable(update.title) || "tool",
          toolCallId: update.toolCallId,
          args: update.rawInput,
        }, runId));
        return;
      }
      case "tool_call_update": {
        const status = update.status;
        const phase = status === "failed" ? "failed" : status === "completed" ? "result" : "update";
        this.renderer.renderAgent(this.event("tool", {
          phase,
          name: printable(update.title) || printable(update.toolCallId) || "tool",
          toolCallId: update.toolCallId,
          result: printable(update.rawOutput) || printable(update.content),
          isError: status === "failed",
          status,
        }, runId));
        return;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        this.renderer.renderAgent(this.event("plan", {
          title: "Grok",
          steps: entries.map((entry) => {
            const item = entry as { content?: unknown; status?: unknown };
            return `${printable(item.content)}${item.status ? ` [${printable(item.status)}]` : ""}`;
          }).filter(Boolean),
        }, runId));
        return;
      }
      default:
        return;
    }
  }

  private event(stream: AgentEventPayload["stream"], data: unknown, runId: string): AgentEventPayload {
    return { runId, seq: 0, stream, ts: Date.now(), data, sessionKey: this.sessionId || undefined };
  }

  private finishRun(runId: string, outcome: Exclude<RunCompletion, "timeout">): void {
    if (this.completions.has(runId)) return;
    this.renderer.renderAgent(this.event("lifecycle", { phase: "end" }, runId));
    this.completions.set(runId, outcome);
    if (this.currentRunId === runId) this.currentRunId = null;
    const waiters = this.completionWaiters.get(runId);
    if (waiters) {
      for (const waiter of waiters) waiter(outcome);
      this.completionWaiters.delete(runId);
    }
    void this.persistSession("open");
  }

  private handleExit(error: Error): void {
    this.connected = false;
    this.rejectPending(error);
    if (this.currentRunId) this.finishRun(this.currentRunId, "error");
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private stateOptions(): ScopedStateOptions {
    return { scope: this.paths?.scope || this.opts.scope, env: this.opts.env };
  }

  private async persistSession(status: ExcaliburSessionRecord["status"]): Promise<void> {
    if (!this.sessionId || !this.paths) return;
    const state = await loadExcaliburState(this.stateOptions());
    const prior = state.sessions.find((item) => item.sessionId === this.excaliburSessionId);
    const now = new Date().toISOString();
    await upsertSession({
      sessionId: this.excaliburSessionId,
      provider: "grok-acp",
      nativeSessionId: this.sessionId,
      model: this.paths.model,
      contextId: this.opts.contextId || state.selectedContext,
      startedAt: prior?.startedAt || now,
      updatedAt: now,
      status,
    }, this.stateOptions());
  }
}
