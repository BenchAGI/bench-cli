// Per-stream renderers for AgentEventPayload — SPEC §6.3.
// Pure functions: input event payload → output strings. No global state
// here so tests can snapshot deterministically.

import type { AgentEventPayload, ApprovalEventData } from "../protocol/types.js";
import { c, println, termWidth, truncate } from "./ansi.js";

export type RendererOptions = {
  showThinking: boolean;
  showFullToolOutput: boolean;
  toolLineCap: number;
  toolByteCap: number;
};

export const DEFAULT_RENDERER_OPTIONS: RendererOptions = {
  showThinking: true,
  showFullToolOutput: false,
  toolLineCap: 16,
  toolByteCap: 4 * 1024,
};

export class StreamRenderer {
  private currentAssistantHasContent = false;

  constructor(private opts: RendererOptions = DEFAULT_RENDERER_OPTIONS) {}

  /**
   * Flip the per-session full-tool-output flag (V1.1 — Item 5).
   * Returns the new value so callers can render a status line.
   * Bound to the [r] keystroke in the REPL.
   */
  toggleFullOutput(): boolean {
    this.opts = { ...this.opts, showFullToolOutput: !this.opts.showFullToolOutput };
    return this.opts.showFullToolOutput;
  }

  /** Read-only view of the current full-output flag. V1.1 — Item 5. */
  isFullOutput(): boolean {
    return this.opts.showFullToolOutput;
  }

  renderAgent(p: AgentEventPayload): void {
    switch (p.stream) {
      case "lifecycle":
        this.renderLifecycle(p);
        break;
      case "assistant":
        this.renderAssistant(p);
        break;
      case "thinking":
        if (this.opts.showThinking) this.renderThinking(p);
        break;
      case "tool":
        this.renderTool(p);
        break;
      case "item":
        this.renderItem(p);
        break;
      case "command_output":
        this.renderCommandOutput(p);
        break;
      case "patch":
        this.renderPatch(p);
        break;
      case "plan":
        this.renderPlan(p);
        break;
      case "approval":
        // Approval is handled by the approval state machine, not here.
        break;
      case "compaction":
        this.renderCompaction(p);
        break;
      case "error":
        this.renderError(p);
        break;
      default:
        // Unknown stream — render the event safely.
        this.renderUnknown(p);
    }
  }

  renderChatDelta(payload: unknown): void {
    const text = extractChatText(payload);
    if (text.length === 0) return;
    if (!this.currentAssistantHasContent) {
      this.currentAssistantHasContent = true;
    }
    process.stdout.write(text);
  }

  renderChatFinal(payload: unknown): void {
    const text = extractChatText(payload);
    const errorMessage = (payload as { errorMessage?: string })?.errorMessage;
    const state = (payload as { state?: string })?.state;
    if (text.length > 0 && !this.currentAssistantHasContent) {
      // Batch backend delivered final-only; render whole text.
      process.stdout.write(text);
    }
    if (state === "error" && errorMessage) {
      println();
      println(c.red(`error: ${errorMessage}`));
    }
    if (state === "aborted") {
      println();
      println(c.yellow("(aborted)"));
    }
    if (this.currentAssistantHasContent || text.length > 0 || errorMessage) {
      println();
      this.currentAssistantHasContent = false;
    }
  }

  renderChatSideResult(payload: unknown): void {
    const title = (payload as { title?: string })?.title ?? "side result";
    println(c.dim(`  ↳ ${title}`));
  }

  renderShutdown(reason: string, restartExpectedMs?: number): void {
    const restartPart = restartExpectedMs
      ? ` (restart expected in ${Math.round(restartExpectedMs / 1000)}s)`
      : "";
    println(c.yellow(`Gateway shutting down: ${reason}${restartPart}`));
  }

  renderUnknownEvent(event: string): void {
    // Don't print unknown events — silent. Logged elsewhere.
    void event;
  }

  // --- per-stream renderers ---

  private renderLifecycle(p: AgentEventPayload): void {
    const data = p.data as { phase?: string; runId?: string } | undefined;
    const phase = data?.phase ?? "unknown";
    if (phase === "start" || phase === "started") {
      println(c.dim(`[run started · ${data?.runId ?? p.runId}]`));
    } else if (phase === "end" || phase === "ended" || phase === "complete") {
      println(c.dim(`[run ended]`));
    }
    // Other phases ignored.
  }

  private renderAssistant(p: AgentEventPayload): void {
    const data = p.data as { phase?: string; text?: string; delta?: string } | undefined;
    if (!data) return;
    if (data.phase === "delta" || data.delta != null) {
      const text = data.delta ?? data.text ?? "";
      if (text.length === 0) return;
      this.currentAssistantHasContent = true;
      process.stdout.write(text);
      return;
    }
    if (data.phase === "end" || data.phase === "final") {
      const text = data.text ?? "";
      if (text.length > 0 && !this.currentAssistantHasContent) {
        process.stdout.write(text);
      }
      println();
      this.currentAssistantHasContent = false;
    }
  }

  private renderThinking(p: AgentEventPayload): void {
    const data = p.data as { phase?: string; text?: string; delta?: string } | undefined;
    if (!data) return;
    const text = data.delta ?? data.text ?? "";
    if (text.length === 0) return;
    process.stdout.write(c.dim(c.italic(text)));
  }

  private renderTool(p: AgentEventPayload): void {
    const data = p.data as {
      phase?: string;
      name?: string;
      title?: string;
      args?: unknown;
      result?: string;
      partialResult?: string;
      durationMs?: number;
      itemId?: string;
      toolCallId?: string;
      // Failure-detail fields (V1.1 — Item 4).
      error?: string;
      errorMessage?: string;
      stderr?: string;
      exitCode?: number;
      status?: string;
      isError?: boolean;
    } | undefined;
    if (!data) return;
    const phase = data.phase ?? "update";
    const name = data.name ?? data.title ?? "tool";

    // V1.1 — Item 4 (Codex Anvil P1): some openclaw versions emit
    // failed tool events as `phase: "result", isError: true` rather
    // than `phase: "failed"`. Detect both shapes here so the error
    // detail block fires on real-world events.
    const isFailureEvent =
      phase === "failed" ||
      phase === "error" ||
      data.status === "failed" ||
      ((phase === "result" || phase === "end" || phase === "complete" || phase === "completed")
        && data.isError === true);

    if (phase === "start" || phase === "started") {
      const argsSummary = summarizeArgs(data.args);
      println(c.cyan(`┌─ ${name} ${"─".repeat(Math.max(2, termWidth() - name.length - 6))}`));
      if (argsSummary) {
        println(c.cyan(`│ ${c.dim("args:")} ${argsSummary}`));
      }
      return;
    }

    if (phase === "update" || phase === "delta") {
      // Suppress mid-tool noise unless full mode.
      if (this.opts.showFullToolOutput && data.partialResult) {
        const lines = data.partialResult.split("\n").slice(0, 3);
        for (const line of lines) println(c.cyan(`│ ${truncate(line, termWidth() - 2)}`));
      }
      return;
    }

    if (isFailureEvent) {
      // V1.1 — Item 4: surface failure detail so the user can act.
      // Order: exit code · error message · stderr · duration. Each is
      // optional; the header always renders.
      const parts: string[] = [];
      if (typeof data.exitCode === "number") {
        parts.push(`exit ${data.exitCode}`);
      }
      const dur = typeof data.durationMs === "number"
        ? ` ${(data.durationMs / 1000).toFixed(1)}s`
        : "";
      const headerSuffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
      println(c.red(`└─ ${name} failed${headerSuffix}${dur}`));

      // Error text source-selection: prefer explicit `error`/
      // `errorMessage`. If neither is set but this is the
      // `result + isError` shape, use `result` as the error body.
      const errMsg = data.error ?? data.errorMessage
        ?? (data.isError === true ? data.result : undefined);
      if (typeof errMsg === "string" && errMsg.length > 0) {
        const lines = errMsg.split("\n").slice(0, 4);
        for (const line of lines) {
          println(c.red(`   ${c.dim("error:")} ${truncate(line, termWidth() - 11)}`));
        }
        if (errMsg.split("\n").length > 4) {
          println(c.dim(`   … (more error lines)`));
        }
      }

      const stderr = data.stderr;
      if (typeof stderr === "string" && stderr.length > 0) {
        const summary = this.summarizeResult(stderr);
        println(c.red(`   ${c.dim("stderr:")} ${summary}`));
      }
      return;
    }

    if (phase === "end" || phase === "complete" || phase === "completed" || phase === "result") {
      const result = data.result ?? "";
      if (result.length > 0) {
        const summary = this.summarizeResult(result);
        println(c.cyan(`│ ${c.dim("result:")} ${summary}`));
      }
      const dur = data.durationMs != null ? ` ${(data.durationMs / 1000).toFixed(1)}s` : "";
      println(c.cyan(`└─ ${c.dim(`done${dur} · press [r] to expand`)}`));
      return;
    }
  }

  private renderItem(p: AgentEventPayload): void {
    const data = p.data as { phase?: string; title?: string; status?: string; kind?: string } | undefined;
    if (!data) return;
    const phase = data.phase ?? "update";
    if (phase === "start") {
      println(c.dim(`  · ${data.kind ?? ""} ${data.title ?? ""}`));
    }
    if (phase === "end" && data.status === "failed") {
      println(c.red(`  · failed: ${data.title ?? ""}`));
    }
  }

  private renderCommandOutput(p: AgentEventPayload): void {
    const data = p.data as { phase?: string; output?: string; title?: string } | undefined;
    if (!data) return;
    const out = data.output ?? "";
    if (out.length === 0) return;
    const lines = out.split("\n");
    const cap = 32;
    const shown = lines.slice(0, cap);
    for (const line of shown) println(c.yellow(`  > ${truncate(line, termWidth() - 4)}`));
    if (lines.length > cap) {
      println(c.dim(`  > … (${lines.length - cap} more lines)`));
    }
  }

  private renderPatch(p: AgentEventPayload): void {
    const data = p.data as { path?: string; additions?: number; deletions?: number } | undefined;
    if (!data?.path) return;
    const a = data.additions ?? 0;
    const d = data.deletions ?? 0;
    println(c.green(`  +${a}`) + c.red(`/-${d}`) + ` ${data.path}`);
  }

  private renderPlan(p: AgentEventPayload): void {
    const data = p.data as { title?: string; steps?: string[] } | undefined;
    if (!data) return;
    println(c.bold(`Plan: ${data.title ?? ""}`));
    for (const step of data.steps ?? []) {
      println(`  • ${step}`);
    }
  }

  private renderCompaction(p: AgentEventPayload): void {
    const data = p.data as { freedTokens?: number } | undefined;
    const tokens = data?.freedTokens ?? 0;
    println(c.dim(`  ↺ Context compacted (freed ${tokens} tokens)`));
  }

  private renderError(p: AgentEventPayload): void {
    const data = p.data as { message?: string; stack?: string } | undefined;
    if (!data) return;
    println(c.red(`Error: ${data.message ?? "unknown"}`));
    if (data.stack) println(c.red(data.stack));
  }

  private renderUnknown(p: AgentEventPayload): void {
    println(c.dim(`[${p.stream}] (event ignored)`));
  }

  private summarizeResult(result: string): string {
    const lines = result.split("\n");
    if (result.length > this.opts.toolByteCap || lines.length > this.opts.toolLineCap) {
      return c.dim(`<${lines.length} lines, ${result.length} bytes — press [r] to expand>`);
    }
    return truncate(result, termWidth() - 12);
  }
}

// Extract assistant text from a `chat` event payload. Handles three shapes:
//   1. payload.message.content as a string
//   2. payload.message.content as [{type: "text", text: "..."}, ...]
//   3. legacy payload.text / payload.delta (some clients emit this directly)
// Mirrors openclaw/src/shared/chat-message-content.ts:extractFirstTextBlock.
export function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as {
    message?: { content?: unknown } | string;
    text?: string;
    delta?: string;
  };

  // 3. legacy fallback
  if (typeof p.text === "string") return p.text;
  if (typeof p.delta === "string") return p.delta;

  const message = p.message;
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";

  const content = (message as { content?: unknown }).content;
  // 1. inline string
  if (typeof content === "string") return content;
  // 2. content blocks
  if (!Array.isArray(content)) return "";
  let acc = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type !== undefined && b.type !== "text") continue;
    if (typeof b.text === "string") acc += b.text;
  }
  return acc;
}

function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return truncate(args, 80);
  try {
    return truncate(JSON.stringify(args), 80);
  } catch {
    return "<unserializable>";
  }
}

// Approval-event payload typing helper.
export function approvalDataFrom(payload: unknown): ApprovalEventData | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: ApprovalEventData }).data;
  if (!data || typeof data !== "object") return null;
  return data;
}
