import type { LivenessSnapshot } from "../render/liveness.js";
import type { ThinkingMode } from "../render/stream.js";

export type RuntimeDisposition = "denied" | "aborted";
export type RunCompletion = "final" | "aborted" | "error" | "timeout";

/**
 * Presentation-facing conversation contract. The Ink/readline surfaces depend
 * on this interface rather than a provider or transport implementation.
 *
 * ChatRunner implements it for OpenClaw. Excalibur implements it over the
 * desktop-owned loopback HTTP/SSE sidecar; direct provider ACP is diagnostic.
 */
export interface ConversationRuntime {
  connect(): Promise<void>;
  close(): Promise<void>;
  sendMessage(message: string): Promise<string | null>;
  waitForFinal(timeoutMs: number, runId?: string): Promise<RunCompletion>;
  interruptCurrent(): Promise<RuntimeDisposition>;

  canHandleApprovalKey(key: string): boolean;
  handleApprovalKey(key: string): Promise<boolean>;
  hasPendingApproval(): boolean;

  healthSnapshot(): LivenessSnapshot;
  isInFlight(): boolean;
  currentRun(): string | null;
  resumeKey(): string | null;

  setThinking(mode: ThinkingMode): ThinkingMode;
  getThinking(): ThinkingMode;
  isExpanded(): boolean;
  expandLastTool(): boolean;

  currentModel(): string;
  setModel(model: string): Promise<boolean>;
  setThinkingLevel(level: string): Promise<boolean>;
  hasSession(): boolean;

  /** Excalibur-only aggregate control reads used by generated slash commands. */
  runControlCommand?(command: string, args: string[]): Promise<string[]>;
}
