// Eagle working-words: deterministic per run, rotates on a timer.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WORKING_WORDS, WORD_ROTATE_MS, pickWord, wordForElapsed, } from "../render/working-words.js";
test("pickWord is deterministic for the same (runId, tick)", () => {
    assert.equal(pickWord("run-abc", 0), pickWord("run-abc", 0));
    assert.equal(pickWord("run-abc", 3), pickWord("run-abc", 3));
});
test("pickWord always returns a known eagle word", () => {
    for (const runId of ["a", "run-1", "ZZZ", "🦅", ""]) {
        for (let tick = 0; tick < 20; tick++) {
            assert.ok(WORKING_WORDS.includes(pickWord(runId, tick)), `${runId}@${tick}`);
        }
    }
});
test("pickWord rotates through the list with tick", () => {
    const base = pickWord("steady", 0);
    const next = pickWord("steady", 1);
    assert.notEqual(base, next); // adjacent ticks advance by one slot
    // wraps cleanly after a full cycle
    assert.equal(pickWord("steady", 0), pickWord("steady", WORKING_WORDS.length));
});
test("different runs generally get different starting words", () => {
    const starts = new Set(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((r) => pickWord(r, 0)));
    assert.ok(starts.size >= 3, "expected variety across runs");
});
test("wordForElapsed rotates every WORD_ROTATE_MS", () => {
    const r = "elapsed-run";
    assert.equal(wordForElapsed(r, 0), pickWord(r, 0));
    assert.equal(wordForElapsed(r, WORD_ROTATE_MS - 1), pickWord(r, 0));
    assert.equal(wordForElapsed(r, WORD_ROTATE_MS), pickWord(r, 1));
    assert.equal(wordForElapsed(r, WORD_ROTATE_MS * 2 + 5), pickWord(r, 2));
});
test("wordForElapsed clamps negative elapsed to tick 0", () => {
    assert.equal(wordForElapsed("x", -5000), pickWord("x", 0));
});
