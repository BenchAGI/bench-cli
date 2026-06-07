// The renderer routes through the ansi log sink (so the ink TUI captures output instead of stdout),
// and the thinking polish honors on/off/collapsed.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setLogSink } from "../render/ansi.js";
import { StreamRenderer, DEFAULT_RENDERER_OPTIONS } from "../render/stream.js";
import type { AgentEventPayload } from "../protocol/types.js";

function thinking(text: string): AgentEventPayload {
  return { runId: "run1", seq: 1, stream: "thinking", ts: 0, data: { delta: text } };
}

function withSink(fn: (r: StreamRenderer) => void, opts = DEFAULT_RENDERER_OPTIONS): string {
  let buf = "";
  setLogSink((chunk) => {
    buf += chunk;
  });
  try {
    fn(new StreamRenderer({ ...opts }));
  } finally {
    setLogSink(null);
  }
  return buf;
}

test("assistant deltas are captured by the sink, not written to stdout", () => {
  const buf = withSink((r) => {
    r.renderChatDelta({ deltaText: "hello world" });
    r.renderChatFinal({ state: "final" });
  });
  assert.match(buf, /agent>/);
  assert.match(buf, /hello world/);
});

test("thinking 'on' streams under a 💭 gutter", () => {
  const buf = withSink((r) => {
    r.renderAgent(thinking("pondering the roof"));
  });
  assert.match(buf, /💭/);
  assert.match(buf, /pondering the roof/);
});

test("thinking 'off' suppresses reasoning entirely", () => {
  const buf = withSink((r) => {
    r.setThinking("off");
    r.renderAgent(thinking("secret reasoning"));
  });
  assert.equal(buf, "");
});

test("thinking 'collapsed' shows one marker per run, never the text", () => {
  const buf = withSink((r) => {
    r.setThinking("collapsed");
    r.renderAgent(thinking("step one"));
    r.renderAgent(thinking("step two"));
  });
  assert.match(buf, /💭 thinking…/);
  assert.doesNotMatch(buf, /step one/);
  assert.doesNotMatch(buf, /step two/);
  assert.equal(buf.match(/💭/g)?.length, 1); // exactly one marker
});

test("setThinking returns the new mode and getThinking reflects it", () => {
  const r = new StreamRenderer({ ...DEFAULT_RENDERER_OPTIONS });
  assert.equal(r.getThinking(), "on"); // showThinking defaults true
  assert.equal(r.setThinking("collapsed"), "collapsed");
  assert.equal(r.getThinking(), "collapsed");
});

test("a thinking block closes cleanly before assistant text", () => {
  const buf = withSink((r) => {
    r.renderAgent(thinking("reasoning"));
    r.renderChatDelta({ deltaText: "the answer" });
    r.renderChatFinal({ state: "final" });
  });
  // reasoning then a newline (block close) then the assistant label + answer
  assert.match(buf, /reasoning\n/);
  assert.match(buf, /agent>.*the answer/s);
});
