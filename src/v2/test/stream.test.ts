// Tests for the stream renderer's tool-failure detail rendering
// (V1.1 — Item 4, SPEC §13 "Renderer: tool failure shows error details").

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "../render/stream.js";
import type { AgentEventPayload } from "../protocol/types.js";

type Capture = {
  lines: string[];
  restore: () => void;
};

function captureStdout(): Capture {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as { write: unknown }).write = ((data: string | Uint8Array): boolean => {
    const str = typeof data === "string" ? data : data.toString();
    for (const line of str.split("\n")) {
      if (line.length > 0) lines.push(line);
    }
    return true;
  }) as never;
  return {
    lines,
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
