// LogStore: line-buffering of the renderer's partial/ANSI output stream.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogStore } from "../tui/log-store.js";

test("partial writes accumulate in pending until a newline commits them", () => {
  const s = new LogStore();
  s.write("hello");
  assert.deepEqual(s.snapshot(), { lines: [], pending: "hello" });
  s.write(" world\n");
  assert.deepEqual(s.snapshot(), { lines: ["hello world"], pending: "" });
});

test("a chunk with multiple newlines commits all complete lines, keeps the tail", () => {
  const s = new LogStore();
  s.write("a\nb\nc");
  assert.deepEqual(s.snapshot(), { lines: ["a", "b"], pending: "c" });
});

test("CRLF is normalized and lone CR is dropped", () => {
  const s = new LogStore();
  s.write("x\r\ny");
  assert.deepEqual(s.snapshot(), { lines: ["x"], pending: "y" });
  const s2 = new LogStore();
  s2.write("a\rb");
  assert.equal(s2.snapshot().pending, "ab");
});

test("pushLine commits a discrete line", () => {
  const s = new LogStore();
  s.pushLine("one");
  s.pushLine("two\n");
  assert.deepEqual(s.snapshot().lines, ["one", "two"]);
});

test("clear empties lines and pending", () => {
  const s = new LogStore();
  s.write("keep\npending");
  s.clear();
  assert.deepEqual(s.snapshot(), { lines: [], pending: "" });
});

test("subscribe fires on change and version increments", () => {
  const s = new LogStore();
  let hits = 0;
  const v0 = s.getVersion();
  const unsub = s.subscribe(() => hits++);
  s.write("a\n");
  s.write("b\n");
  assert.equal(hits, 2);
  assert.ok(s.getVersion() > v0);
  unsub();
  s.write("c\n");
  assert.equal(hits, 2); // no more callbacks after unsubscribe
});

test("line buffer is capped", () => {
  const s = new LogStore(3);
  for (let i = 0; i < 10; i++) s.write(`L${i}\n`);
  const { lines } = s.snapshot();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, ["L7", "L8", "L9"]);
});
