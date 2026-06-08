// Tests for the stream renderer's tool-failure detail rendering
// (V1.1 — Item 4, SPEC §13 "Renderer: tool failure shows error details").

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "../render/stream.js";
import type { AgentEventPayload } from "../protocol/types.js";

type Capture = {
  lines: string[];
  raw: string[];
  restore: () => void;
};

function captureStdout(): Capture {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  const rawChunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as { write: unknown }).write = ((data: string | Uint8Array): boolean => {
    const str = typeof data === "string" ? data : data.toString();
    rawChunks.push(str);
    for (const line of str.split("\n")) {
      if (line.length > 0) lines.push(line);
    }
    return true;
  }) as never;
  return {
    lines,
    raw: rawChunks,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as { write: unknown }).write = orig as never;
    },
  };
}

function failedToolEvent(extra: Record<string, unknown>): AgentEventPayload {
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
  } finally {
    cap.restore();
  }
  const all = cap.lines.join("\n");
  assert.match(all, /Bash failed/);
});

test("Renderer: tool failure shows exit code, error, stderr, and duration", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderAgent(
      failedToolEvent({
        error: "command failed: ls /nonexistent",
        stderr: "ls: /nonexistent: No such file or directory",
        exitCode: 2,
        durationMs: 234,
      }),
    );
  } finally {
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
    r.renderAgent(
      failedToolEvent({
        error: "primary-error-text",
        errorMessage: "fallback-text",
      }),
    );
  } finally {
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
    r.renderAgent(
      failedToolEvent({ errorMessage: "fallback-only-text" }),
    );
  } finally {
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
  } finally {
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
  } finally { cap.restore(); }
  const all = cap.lines.join("\n");
  // Failure header fires.
  assert.match(all, /Read failed/);
  // Error text sourced from `result` (since `error`/`errorMessage` absent).
  assert.match(all, /ENOENT/);
  // The done-success line MUST NOT appear.
  assert.doesNotMatch(all, /press \[r\] to expand/);
});

test("Renderer: tool success renders ONE tight summary line by default (collapsed)", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS); // showFullToolOutput=false
  const cap = captureStdout();
  try {
    r.renderAgent({
      runId: "r1", seq: 1, stream: "tool", ts: 0,
      data: { phase: "start", name: "Read" },
    });
    r.renderAgent({
      runId: "r1", seq: 2, stream: "tool", ts: 0,
      data: { phase: "result", name: "Read", isError: false, result: "file contents" },
    });
  } finally { cap.restore(); }
  const all = cap.lines.join("\n");
  assert.match(all, /⚙ Read · file contents/); // tight one-liner
  assert.doesNotMatch(all, /┌─/); // no in-progress box when collapsed
  assert.doesNotMatch(all, /press \[r\] to expand/); // box only in expanded mode
  assert.doesNotMatch(all, /Read failed/);
});

test("Renderer: expanded mode shows the full tool box with the [r] hint", () => {
  const r = new StreamRenderer({ ...DEFAULT_RENDERER_OPTIONS, showFullToolOutput: true });
  const cap = captureStdout();
  try {
    r.renderAgent({
      runId: "r1", seq: 1, stream: "tool", ts: 0,
      data: { phase: "result", name: "Read", isError: false, result: "file contents" },
    });
  } finally { cap.restore(); }
  const all = cap.lines.join("\n");
  assert.match(all, /press \[r\] to expand/);
  assert.doesNotMatch(all, /Read failed/);
});

test("Renderer: assistant text is labeled once per response", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderChatDelta({ state: "delta", delta: "hel" });
    r.renderChatDelta({ state: "delta", delta: "lo" });
    r.renderChatFinal({ state: "final" });
  } finally { cap.restore(); }
  const all = cap.lines.join("");
  assert.equal((all.match(/agent> /g) ?? []).length, 1);
  assert.match(all, /agent> hello/);
});

test("Renderer: cumulative chat snapshots append only the new suffix", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderChatDelta({ state: "delta", message: { content: [{ type: "text", text: "hel" }] } });
    r.renderChatDelta({ state: "delta", message: { content: [{ type: "text", text: "hello" }] } });
    r.renderChatDelta({ state: "delta", message: { content: [{ type: "text", text: "hello there" }] } });
    r.renderChatFinal({ state: "final", message: { content: [{ type: "text", text: "hello there" }] } });
  } finally { cap.restore(); }
  const all = cap.lines.join("");
  assert.equal((all.match(/agent> /g) ?? []).length, 1);
  assert.match(all, /agent> hello there/);
  assert.doesNotMatch(all, /helhello/);
  assert.doesNotMatch(all, /hellohello/);
});

test("Renderer: agent assistant snapshot plus chat snapshot does not double-render", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderAgent({
      runId: "r1", seq: 1, stream: "assistant", ts: 0,
      data: { phase: "delta", text: "hello", delta: "hello" },
    });
    r.renderChatDelta({ state: "delta", message: { content: [{ type: "text", text: "hello" }] } });
    r.renderChatFinal({ state: "final", message: { content: [{ type: "text", text: "hello" }] } });
  } finally { cap.restore(); }
  const all = cap.lines.join("");
  assert.equal((all.match(/agent> /g) ?? []).length, 1);
  assert.match(all, /agent> hello/);
  assert.doesNotMatch(all, /hellohello/);
});

test("Renderer: lifecycle end finishes the assistant line (no run marker)", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderChatDelta({ state: "delta", message: { content: [{ type: "text", text: "done" }] } });
    r.renderAgent({
      runId: "r1", seq: 2, stream: "lifecycle", ts: 0,
      data: { phase: "end" },
    });
    r.renderChatFinal({ state: "final", message: { content: [{ type: "text", text: "done" }] } });
  } finally { cap.restore(); }
  const all = cap.raw.join("");
  assert.match(all, /agent> done\n/); // line finished with a newline on lifecycle end — not mushed
  assert.doesNotMatch(all, /\[run ended\]/); // marker removed
  assert.doesNotMatch(all, /donedone/);
});

test("Renderer: text-only assistant event renders before lifecycle end without final duplicate", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderAgent({
      runId: "r1", seq: 1, stream: "assistant", ts: 0,
      data: { text: "final answer" },
    });
    r.renderAgent({
      runId: "r1", seq: 2, stream: "lifecycle", ts: 0,
      data: { phase: "end" },
    });
    r.renderChatFinal({
      state: "final",
      message: { content: [{ type: "text", text: "final answer" }] },
    });
  } finally { cap.restore(); }
  const all = cap.raw.join("");
  assert.match(all, /agent> final answer\n/); // finished line, no run marker
  assert.equal((all.match(/final answer/g) ?? []).length, 1);
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
  } finally { cap.restore(); }
  assert.equal(
    cap.lines.filter((l) => /intermediate-stdout-line/.test(l)).length,
    0,
    "partialResult should be suppressed when showFullToolOutput=false",
  );

  // Toggle to ON, then re-render: now partialResult appears.
  r.toggleFullOutput();
  cap = captureStdout();
  try {
    r.renderAgent({
      runId: "r1", seq: 2, stream: "tool", ts: 0,
      data: { phase: "update", name: "Bash", partialResult: "intermediate-stdout-line" },
    });
  } finally { cap.restore(); }
  assert.match(
    cap.lines.join("\n"),
    /intermediate-stdout-line/,
    "partialResult should be visible after toggleFullOutput=true",
  );
});

test("Renderer: tool failure caps multi-line error at 4 lines + ellipsis", () => {
  const r = new StreamRenderer(DEFAULT_RENDERER_OPTIONS);
  const cap = captureStdout();
  try {
    r.renderAgent(
      failedToolEvent({
        error: "line1\nline2\nline3\nline4\nline5\nline6",
      }),
    );
  } finally {
    cap.restore();
  }
  // Header + 4 error lines + ellipsis. Line 5 and 6 never appear directly.
  const all = cap.lines.join("\n");
  assert.match(all, /line4/);
  assert.doesNotMatch(all, /\bline5\b/);
  assert.doesNotMatch(all, /\bline6\b/);
  assert.match(all, /more error lines/);
});
