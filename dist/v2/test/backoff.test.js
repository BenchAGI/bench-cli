// Tests for the reconnect backoff sequence (V1.1 — Item 1, SPEC §13
// "Reconnect: network drop backoff sequence"). The runbook specifies
// 1s, 2s, 5s, 10s, 30s with attempts beyond 5 capped at 30s.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BACKOFF_CAP_MS, BACKOFF_SEQUENCE_MS, nextBackoffMs } from "../transport/backoff.js";
test("backoff sequence is exactly 1s, 2s, 5s, 10s, 30s", () => {
    assert.deepEqual(BACKOFF_SEQUENCE_MS, [1_000, 2_000, 5_000, 10_000, 30_000]);
});
test("attempts 1..5 return the documented sequence", () => {
    assert.equal(nextBackoffMs(1), 1_000);
    assert.equal(nextBackoffMs(2), 2_000);
    assert.equal(nextBackoffMs(3), 5_000);
    assert.equal(nextBackoffMs(4), 10_000);
    assert.equal(nextBackoffMs(5), 30_000);
});
test("attempts beyond 5 cap at 30s", () => {
    assert.equal(nextBackoffMs(6), BACKOFF_CAP_MS);
    assert.equal(nextBackoffMs(10), BACKOFF_CAP_MS);
    assert.equal(nextBackoffMs(100), BACKOFF_CAP_MS);
});
test("cap matches the last sequence entry", () => {
    assert.equal(BACKOFF_CAP_MS, 30_000);
    assert.equal(BACKOFF_SEQUENCE_MS[BACKOFF_SEQUENCE_MS.length - 1], BACKOFF_CAP_MS);
});
test("non-positive or non-finite attempts return 0", () => {
    assert.equal(nextBackoffMs(0), 0);
    assert.equal(nextBackoffMs(-1), 0);
    assert.equal(nextBackoffMs(Number.NaN), 0);
    // Infinity is non-finite — treated as invalid input, not "very far
    // along the sequence." Caller should pass an integer attempt counter.
    assert.equal(nextBackoffMs(Number.POSITIVE_INFINITY), 0);
});
test("fractional attempts floor toward the lower index", () => {
    // 1.7 floors to 1 → first slot (1s), not 2nd.
    assert.equal(nextBackoffMs(1.7), 1_000);
    assert.equal(nextBackoffMs(2.9), 2_000);
});
