// Inline highlighter. Tests run in a non-TTY context (useAnsi=false), so we assert the
// color-independent behavior: markdown markers are stripped, plain content is preserved, and
// existing ANSI/escape sequences are never corrupted. (Color codes only appear on a real TTY.)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { highlight, highlightCode, annotateCodeBlocks } from "../render/highlight.js";

test("strips inline code backticks", () => {
  assert.equal(highlight("run `npm test` now"), "run npm test now");
});

test("strips bold asterisks", () => {
  assert.equal(highlight("this is **important** ok"), "this is important ok");
});

test("leaves URLs, dates, and money textually intact", () => {
  assert.equal(highlight("see https://benchagi.com/x for more"), "see https://benchagi.com/x for more");
  assert.equal(highlight("due 2026-06-07 sharp"), "due 2026-06-07 sharp");
  assert.equal(highlight("saved $1,234.50 total"), "saved $1,234.50 total");
});

test("plain text is unchanged", () => {
  const s = "nothing special here, just words.";
  assert.equal(highlight(s), s);
});

test("empty string passes through", () => {
  assert.equal(highlight(""), "");
});

test("does not corrupt an existing ANSI prefix (e.g. the Aurelius> label)", () => {
  const prefixed = "\x1b[38;2;255;45;85mAurelius> \x1b[39msee `the docs`";
  const out = highlight(prefixed);
  // the escape codes survive verbatim; the backticked text is de-marked
  assert.ok(out.includes("\x1b[38;2;255;45;85mAurelius> \x1b[39m"), "prefix escapes preserved");
  assert.ok(out.includes("see the docs"), "code markers stripped in the text run");
  assert.ok(!out.includes("`"), "no stray backticks");
});

test("first-match-wins: a date inside a URL is not separately recolored", () => {
  // the URL is matched whole; its internal digits/date are not re-processed
  const out = highlight("ref https://x.com/2026-06-07/report");
  assert.ok(out.includes("https://x.com/2026-06-07/report"), "URL kept whole");
});

test("multiple decorations on one line all strip cleanly", () => {
  assert.equal(
    highlight("**Note**: see `cfg.json` by 2026-06-07 — costs $50"),
    "Note: see cfg.json by 2026-06-07 — costs $50",
  );
});

test("annotateCodeBlocks classifies fences, code, and prose", () => {
  const kinds = annotateCodeBlocks(["Here you go:", "```js", "const x = 1;", "console.log(x);", "```", "done"]);
  assert.deepEqual(
    kinds.map((k) => k.kind),
    ["text", "open", "code", "code", "close", "text"],
  );
  assert.equal(kinds[1]!.lang, "js");
});

test("annotateCodeBlocks tracks an unterminated block (window scrolled mid-block)", () => {
  const kinds = annotateCodeBlocks(["```py", "print(1)", "print(2)"]);
  assert.deepEqual(kinds.map((k) => k.kind), ["open", "code", "code"]);
});

test("highlightCode leaves plain code text intact when color is off", () => {
  // non-TTY in tests → no color codes; code passes through unmangled (no markers to strip)
  assert.equal(highlightCode('const x = "hi"; // note'), 'const x = "hi"; // note');
});
