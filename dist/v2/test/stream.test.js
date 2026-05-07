// Tests for the stream renderer's tool-failure detail rendering
// (V1.1 — Item 4, SPEC §13 "Renderer: tool failure shows error details").
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "../render/stream.js";
function captureStdout() {
    const orig = process.stdout.write.bind(process.stdout);
    const lines = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((data) => {
        const str = typeof data === "string" ? data : data.toString();
        for (const line of str.split("\n")) {
            if (line.length > 0)
                lines.push(line);
        }
        return true;
    });
    return {
        lines,
        restore: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            process.stdout.write = orig;
        },
    };
}
function failedToolEvent(extra) {
    return {
        runId: "r1",
        seq: 5,
        stream: "tool",
        ts: 0,
        data: { phase: "failed", name: "Bash", ...extra },
    };
}
test("Renderer: tool failure header always renders", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({}));
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    assert.match(all, /Bash failed/);
});
test("Renderer: tool failure shows exit code, error, stderr, and duration", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({
            error: "command failed: ls /nonexistent",
            stderr: "ls: /nonexistent: No such file or directory",
            exitCode: 2,
            durationMs: 234,
        }));
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    // Header surfaces exit code + duration.
    assert.match(all, /Bash failed/);
    assert.match(all, /exit 2/);
    assert.match(all, /0\.2s/);
    // Body surfaces error message and stderr summary.
    assert.match(all, /command failed: ls \/nonexistent/);
    assert.match(all, /No such file/);
});
test("Renderer: tool failure prefers `error` over `errorMessage` when both present", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({
            error: "primary-error-text",
            errorMessage: "fallback-text",
        }));
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    assert.match(all, /primary-error-text/);
    assert.doesNotMatch(all, /fallback-text/);
});
test("Renderer: tool failure falls back to errorMessage when error is absent", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({ errorMessage: "fallback-only-text" }));
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    assert.match(all, /fallback-only-text/);
});
test("Renderer: tool failure with no detail fields renders only the header", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({}));
    }
    finally {
        cap.restore();
    }
    // Header line only — no error: / stderr: / exit lines.
    const errorLines = cap.lines.filter((l) => /error:|stderr:|exit /.test(l));
    assert.equal(errorLines.length, 0);
});
// V1.1 — Item 4 (Codex Anvil P1): real-world openclaw shape
test("Renderer: tool failure detected via phase:'result' + isError:true (real openclaw shape)", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent({
            runId: "r1", seq: 1, stream: "tool", ts: 0,
            data: {
                phase: "result",
                name: "Read",
                isError: true,
                result: "ENOENT: no such file or directory",
            },
        });
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    // Failure header fires.
    assert.match(all, /Read failed/);
    // Error text sourced from `result` (since `error`/`errorMessage` absent).
    assert.match(all, /ENOENT/);
    // The done-success line MUST NOT appear.
    assert.doesNotMatch(all, /press \[r\] to expand/);
});
test("Renderer: tool result with isError:false renders the success path", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent({
            runId: "r1", seq: 1, stream: "tool", ts: 0,
            data: { phase: "result", name: "Read", isError: false, result: "file contents" },
        });
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("\n");
    // Success path fires.
    assert.match(all, /press \[r\] to expand/);
    // Failure header MUST NOT appear.
    assert.doesNotMatch(all, /Read failed/);
});
test("Renderer: assistant text is labeled once per response", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderChatDelta({ state: "delta", delta: "hel" });
        r.renderChatDelta({ state: "delta", delta: "lo" });
        r.renderChatFinal({ state: "final" });
    }
    finally {
        cap.restore();
    }
    const all = cap.lines.join("");
    assert.equal((all.match(/agent> /g) ?? []).length, 1);
    assert.match(all, /agent> hello/);
});
// V1.1 — Item 5: SPEC §13 "REPL: [r] toggles tool expansion for the session"
test("Renderer: toggleFullOutput flips the per-session expand flag", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    // Default is OFF.
    assert.equal(r.isFullOutput(), false);
    // First [r] press → ON.
    const first = r.toggleFullOutput();
    assert.equal(first, true);
    assert.equal(r.isFullOutput(), true);
    // Second [r] press → OFF.
    const second = r.toggleFullOutput();
    assert.equal(second, false);
    assert.equal(r.isFullOutput(), false);
});
test("Renderer: toggleFullOutput affects subsequent renderTool 'update' phase", () => {
    const r = new StreamRenderer({ ...DEFAULT_RENDERER_OPTIONS, showFullToolOutput: false });
    // Phase 'update' with partialResult: nothing renders by default.
    let cap = captureStdout();
    try {
        r.renderAgent({
            runId: "r1", seq: 1, stream: "tool", ts: 0,
            data: { phase: "update", name: "Bash", partialResult: "intermediate-stdout-line" },
        });
    }
    finally {
        cap.restore();
    }
    assert.equal(cap.lines.filter((l) => /intermediate-stdout-line/.test(l)).length, 0, "partialResult should be suppressed when showFullToolOutput=false");
    // Toggle to ON, then re-render: now partialResult appears.
    r.toggleFullOutput();
    cap = captureStdout();
    try {
        r.renderAgent({
            runId: "r1", seq: 2, stream: "tool", ts: 0,
            data: { phase: "update", name: "Bash", partialResult: "intermediate-stdout-line" },
        });
    }
    finally {
        cap.restore();
    }
    assert.match(cap.lines.join("\n"), /intermediate-stdout-line/, "partialResult should be visible after toggleFullOutput=true");
});
test("Renderer: tool failure caps multi-line error at 4 lines + ellipsis", () => {
    const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
    const cap = captureStdout();
    try {
        r.renderAgent(failedToolEvent({
            error: "line1\nline2\nline3\nline4\nline5\nline6",
        }));
    }
    finally {
        cap.restore();
    }
    // Header + 4 error lines + ellipsis. Line 5 and 6 never appear directly.
    const all = cap.lines.join("\n");
    assert.match(all, /line4/);
    assert.doesNotMatch(all, /\bline5\b/);
    assert.doesNotMatch(all, /\bline6\b/);
    assert.match(all, /more error lines/);
});
