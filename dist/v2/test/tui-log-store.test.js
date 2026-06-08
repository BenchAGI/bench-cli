// LogStore: line-buffering of the renderer's partial/ANSI output stream.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogStore } from "../tui/log-store.js";
test("partial writes accumulate in pending until a newline commits them", () => {
    const s = new LogStore();
    s.write("hello");
    assert.deepEqual(s.snapshot().lines, []);
    assert.equal(s.snapshot().pending, "hello");
    s.write(" world\n");
    assert.deepEqual(s.snapshot().lines, ["hello world"]);
    assert.equal(s.snapshot().pending, "");
});
test("a chunk with multiple newlines commits all complete lines, keeps the tail", () => {
    const s = new LogStore();
    s.write("a\nb\nc");
    assert.deepEqual(s.snapshot().lines, ["a", "b"]);
    assert.equal(s.snapshot().pending, "c");
});
test("CRLF is normalized and lone CR is dropped", () => {
    const s = new LogStore();
    s.write("x\r\ny");
    assert.deepEqual(s.snapshot().lines, ["x"]);
    assert.equal(s.snapshot().pending, "y");
    const s2 = new LogStore();
    s2.write("a\rb");
    assert.equal(s2.snapshot().pending, "ab");
});
test("each commit hands React a NEW array identity (ink <Static> reference contract)", () => {
    const s = new LogStore();
    s.write("one\n");
    const a = s.snapshot().lines;
    s.write("two\n");
    const b = s.snapshot().lines;
    assert.notEqual(a, b, "lines reference must change on append so <Static> re-renders");
    assert.deepEqual(b, ["one", "two"]);
});
test("clear bumps generation so <Static> remounts empty", () => {
    const s = new LogStore();
    s.write("a\nb\n");
    const g0 = s.snapshot().generation;
    s.clear();
    assert.deepEqual(s.snapshot().lines, []);
    assert.ok(s.snapshot().generation > g0, "generation must advance on clear");
});
test("an over-long pending line is flushed so the live region stays bounded", () => {
    const s = new LogStore();
    s.write("x".repeat(9000)); // no newline, exceeds the pending flush threshold
    assert.ok(s.snapshot().pending.length < 9000, "pending should have been flushed");
    assert.equal(s.snapshot().lines.length, 1);
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
    assert.deepEqual(s.snapshot().lines, []);
    assert.equal(s.snapshot().pending, "");
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
test("line buffer is capped with half-trim hysteresis + bumps generation", () => {
    const s = new LogStore(10);
    for (let i = 0; i < 30; i++)
        s.write(`L${i}\n`);
    const { lines, generation } = s.snapshot();
    assert.ok(lines.length <= 10, `expected <= cap(10), got ${lines.length}`);
    assert.equal(lines[lines.length - 1], "L29", "most recent line retained");
    assert.ok(generation > 0, "cap-trim must bump generation to remount <Static>");
});
test("a full buffer does NOT remount on every single line (hysteresis)", () => {
    const s = new LogStore(10);
    for (let i = 0; i < 11; i++)
        s.write(`L${i}\n`); // cross the cap once → one trim
    const g1 = s.snapshot().generation;
    s.write("next\n"); // within the post-trim slack → must NOT trim/remount again
    assert.equal(s.snapshot().generation, g1, "no remount while under cap after a trim");
});
