// Pure input-editor reducer: insertion, cursor, history, multiline, and the approval-key race.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initInput, reduceInput, type InputState, type KeyLike } from "../tui/input-model.js";

type Ctx = Parameters<typeof reduceInput>[3];

function type(state: InputState, text: string, ctx?: Ctx): InputState {
  let s = state;
  for (const ch of text) s = reduceInput(s, ch, {}, ctx).state;
  return s;
}
function press(state: InputState, key: KeyLike, input = "", ctx?: Ctx) {
  return reduceInput(state, input, key, ctx);
}

test("printable characters insert at the cursor", () => {
  const s = type(initInput(), "hello");
  assert.equal(s.buffer, "hello");
  assert.equal(s.cursor, 5);
});

test("backspace deletes before the cursor", () => {
  let s = type(initInput(), "hello");
  s = press(s, { backspace: true }).state;
  assert.equal(s.buffer, "hell");
  assert.equal(s.cursor, 4);
});

test("left arrow + insert edits mid-line", () => {
  let s = type(initInput(), "helo");
  s = press(s, { leftArrow: true }).state; // cursor between l and o
  s = type(s, "l");
  assert.equal(s.buffer, "hello");
});

test("ctrl+u clears, ctrl+a home, ctrl+e end, ctrl+k kill-to-end", () => {
  let s = type(initInput(), "abcdef");
  s = press(s, { ctrl: true }, "a").state;
  assert.equal(s.cursor, 0);
  s = press(s, { ctrl: true }, "e").state;
  assert.equal(s.cursor, 6);
  s = press(s, { ctrl: true }, "a").state;
  s = press(s, { ctrl: true }, "k").state; // kill from home → empties
  assert.equal(s.buffer, "");
  s = type(s, "xyz");
  s = press(s, { ctrl: true }, "u").state;
  assert.equal(s.buffer, "");
});

test("Enter submits a non-empty line and records history", () => {
  const s0 = type(initInput(), "hi there");
  const { state, action } = press(s0, { return: true });
  assert.deepEqual(action, { type: "submit", line: "hi there" });
  assert.equal(state.buffer, "");
  assert.deepEqual(state.history, ["hi there"]);
});

test("Enter on an empty/whitespace line does nothing", () => {
  const { state, action } = press(initInput(), { return: true });
  assert.equal(action.type, "none");
  assert.deepEqual(state.history, []);
});

test("trailing backslash + Enter continues onto a new line (no submit)", () => {
  let s = type(initInput(), "line1\\");
  const r = press(s, { return: true });
  assert.equal(r.action.type, "none");
  assert.equal(r.state.buffer, "line1\n");
});

test("history nav preserves the live draft", () => {
  let s = initInput();
  s = press(type(s, "first"), { return: true }).state;
  s = press(type(s, "second"), { return: true }).state;
  s = type(s, "draft-in-progress");
  s = press(s, { upArrow: true }).state;
  assert.equal(s.buffer, "second");
  s = press(s, { upArrow: true }).state;
  assert.equal(s.buffer, "first");
  s = press(s, { downArrow: true }).state;
  assert.equal(s.buffer, "second");
  s = press(s, { downArrow: true }).state; // past newest → restore draft
  assert.equal(s.buffer, "draft-in-progress");
});

test("history dedups consecutive identical submits", () => {
  let s = initInput();
  s = press(type(s, "same"), { return: true }).state;
  s = press(type(s, "same"), { return: true }).state;
  assert.deepEqual(s.history, ["same"]);
});

test("approval gate: a/d/r act on a pending approval only when the buffer is empty", () => {
  const ctx = { approvalActive: true };
  // empty buffer → 'a' is an approval action, not text
  const r = reduceInput(initInput(), "a", {}, ctx);
  assert.deepEqual(r.action, { type: "approval", key: "a" });
  assert.equal(r.state.buffer, "");
  // 'd' and 'r' too, case-insensitive
  assert.equal(reduceInput(initInput(), "D", {}, ctx).action.type, "approval");
  assert.equal(reduceInput(initInput(), "r", {}, ctx).action.type, "approval");
});

test("approval gate: once you've started typing, a/d/r are literal (the race fix)", () => {
  const ctx = { approvalActive: true };
  let s = type(initInput(), "are we"); // user typing a message
  assert.equal(s.buffer, "are we");
  // a subsequent 'a' must be text, never an approval
  const r = reduceInput(s, "a", {}, ctx);
  assert.equal(r.action.type, "none");
  assert.equal(r.state.buffer, "are wea");
});

test("approval gate is inert when no approval is pending", () => {
  const r = reduceInput(initInput(), "a", {}, { approvalActive: false });
  assert.equal(r.action.type, "none");
  assert.equal(r.state.buffer, "a");
});

test("tab autocompletes a unique slash command", () => {
  const s = type(initInput(), "/th");
  const r = press(s, { tab: true });
  assert.equal(r.state.buffer, "/thinking ");
});

test("tab is a no-op when the slash prefix is ambiguous", () => {
  const s = type(initInput(), "/s"); // status + switch
  const r = press(s, { tab: true });
  assert.equal(r.state.buffer, "/s");
});
