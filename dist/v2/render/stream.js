// Per-stream renderers for AgentEventPayload — SPEC §6.3.
// Pure functions: input event payload → output strings. No global state
// here so tests can snapshot deterministically.
import { c, println, termWidth, truncate } from "./ansi.js";
export const DEFAULT_RENDERER_OPTIONS = {
    showThinking: true,
    showFullToolOutput: false,
    toolLineCap: 16,
    toolByteCap: 4 * 1024,
};
export class StreamRenderer {
    opts;
    currentAssistantHasContent = false;
    constructor(opts = DEFAULT_RENDERER_OPTIONS) {
        this.opts = opts;
    }
    /**
     * Flip the per-session full-tool-output flag (V1.1 — Item 5).
     * Returns the new value so callers can render a status line.
     * Bound to the [r] keystroke in the REPL.
     */
    toggleFullOutput() {
        this.opts = { ...this.opts, showFullToolOutput: !this.opts.showFullToolOutput };
        return this.opts.showFullToolOutput;
    }
    /** Read-only view of the current full-output flag. V1.1 — Item 5. */
    isFullOutput() {
        return this.opts.showFullToolOutput;
    }
    renderAgent(p) {
        switch (p.stream) {
            case "lifecycle":
                this.renderLifecycle(p);
                break;
            case "assistant":
                this.renderAssistant(p);
                break;
            case "thinking":
                if (this.opts.showThinking)
                    this.renderThinking(p);
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
    renderChatDelta(payload) {
        const text = extractChatText(payload);
        if (text.length === 0)
            return;
        if (!this.currentAssistantHasContent) {
            this.renderAssistantLabel();
            this.currentAssistantHasContent = true;
        }
        process.stdout.write(text);
    }
    renderChatFinal(payload) {
        const text = extractChatText(payload);
        const errorMessage = payload?.errorMessage;
        const state = payload?.state;
        if (text.length > 0 && !this.currentAssistantHasContent) {
            // Batch backend delivered final-only; render whole text.
            this.renderAssistantLabel();
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
    renderChatSideResult(payload) {
        const title = payload?.title ?? "side result";
        println(c.dim(`  ↳ ${title}`));
    }
    renderShutdown(reason, restartExpectedMs) {
        const restartPart = restartExpectedMs
            ? ` (restart expected in ${Math.round(restartExpectedMs / 1000)}s)`
            : "";
        println(c.yellow(`Gateway shutting down: ${reason}${restartPart}`));
    }
    renderUnknownEvent(event) {
        // Don't print unknown events — silent. Logged elsewhere.
        void event;
    }
    // --- per-stream renderers ---
    renderLifecycle(p) {
        const data = p.data;
        const phase = data?.phase ?? "unknown";
        if (phase === "start" || phase === "started") {
            println(c.dim(`[run started · ${data?.runId ?? p.runId}]`));
        }
        else if (phase === "end" || phase === "ended" || phase === "complete") {
            println(c.dim(`[run ended]`));
        }
        // Other phases ignored.
    }
    renderAssistant(p) {
        const data = p.data;
        if (!data)
            return;
        if (data.phase === "delta" || data.delta != null) {
            const text = data.delta ?? data.text ?? "";
            if (text.length === 0)
                return;
            if (!this.currentAssistantHasContent)
                this.renderAssistantLabel();
            this.currentAssistantHasContent = true;
            process.stdout.write(text);
            return;
        }
        if (data.phase === "end" || data.phase === "final") {
            const text = data.text ?? "";
            if (text.length > 0 && !this.currentAssistantHasContent) {
                this.renderAssistantLabel();
                process.stdout.write(text);
            }
            println();
            this.currentAssistantHasContent = false;
        }
    }
    renderAssistantLabel() {
        process.stdout.write(c.magenta("agent> "));
    }
    renderThinking(p) {
        const data = p.data;
        if (!data)
            return;
        const text = data.delta ?? data.text ?? "";
        if (text.length === 0)
            return;
        process.stdout.write(c.dim(c.italic(text)));
    }
    renderTool(p) {
        const data = p.data;
        if (!data)
            return;
        const phase = data.phase ?? "update";
        const name = data.name ?? data.title ?? "tool";
        // V1.1 — Item 4 (Codex Anvil P1): some openclaw versions emit
        // failed tool events as `phase: "result", isError: true` rather
        // than `phase: "failed"`. Detect both shapes here so the error
        // detail block fires on real-world events.
        const isFailureEvent = phase === "failed" ||
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
                for (const line of lines)
                    println(c.cyan(`│ ${truncate(line, termWidth() - 2)}`));
            }
            return;
        }
        if (isFailureEvent) {
            // V1.1 — Item 4: surface failure detail so the user can act.
            // Order: exit code · error message · stderr · duration. Each is
            // optional; the header always renders.
            const parts = [];
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
    renderItem(p) {
        const data = p.data;
        if (!data)
            return;
        const phase = data.phase ?? "update";
        if (phase === "start") {
            println(c.dim(`  · ${data.kind ?? ""} ${data.title ?? ""}`));
        }
        if (phase === "end" && data.status === "failed") {
            println(c.red(`  · failed: ${data.title ?? ""}`));
        }
    }
    renderCommandOutput(p) {
        const data = p.data;
        if (!data)
            return;
        const out = data.output ?? "";
        if (out.length === 0)
            return;
        const lines = out.split("\n");
        const cap = 32;
        const shown = lines.slice(0, cap);
        for (const line of shown)
            println(c.yellow(`  > ${truncate(line, termWidth() - 4)}`));
        if (lines.length > cap) {
            println(c.dim(`  > … (${lines.length - cap} more lines)`));
        }
    }
    renderPatch(p) {
        const data = p.data;
        if (!data?.path)
            return;
        const a = data.additions ?? 0;
        const d = data.deletions ?? 0;
        println(c.green(`  +${a}`) + c.red(`/-${d}`) + ` ${data.path}`);
    }
    renderPlan(p) {
        const data = p.data;
        if (!data)
            return;
        println(c.bold(`Plan: ${data.title ?? ""}`));
        for (const step of data.steps ?? []) {
            println(`  • ${step}`);
        }
    }
    renderCompaction(p) {
        const data = p.data;
        const tokens = data?.freedTokens ?? 0;
        println(c.dim(`  ↺ Context compacted (freed ${tokens} tokens)`));
    }
    renderError(p) {
        const data = p.data;
        if (!data)
            return;
        println(c.red(`Error: ${data.message ?? "unknown"}`));
        if (data.stack)
            println(c.red(data.stack));
    }
    renderUnknown(p) {
        println(c.dim(`[${p.stream}] (event ignored)`));
    }
    summarizeResult(result) {
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
export function extractChatText(payload) {
    if (!payload || typeof payload !== "object")
        return "";
    const p = payload;
    // 3. legacy fallback
    if (typeof p.text === "string")
        return p.text;
    if (typeof p.delta === "string")
        return p.delta;
    const message = p.message;
    if (typeof message === "string")
        return message;
    if (!message || typeof message !== "object")
        return "";
    const content = message.content;
    // 1. inline string
    if (typeof content === "string")
        return content;
    // 2. content blocks
    if (!Array.isArray(content))
        return "";
    let acc = "";
    for (const block of content) {
        if (!block || typeof block !== "object")
            continue;
        const b = block;
        if (b.type !== undefined && b.type !== "text")
            continue;
        if (typeof b.text === "string")
            acc += b.text;
    }
    return acc;
}
function summarizeArgs(args) {
    if (args == null)
        return "";
    if (typeof args === "string")
        return truncate(args, 80);
    try {
        return truncate(JSON.stringify(args), 80);
    }
    catch {
        return "<unserializable>";
    }
}
// Approval-event payload typing helper.
export function approvalDataFrom(payload) {
    if (!payload || typeof payload !== "object")
        return null;
    const data = payload.data;
    if (!data || typeof data !== "object")
        return null;
    return data;
}
