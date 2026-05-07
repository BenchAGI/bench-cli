// Tests for capability probe (ADR-005 / SPEC §7).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyByModel, resolveLivenessThreshold } from "../probe/capability.js";
test("pi/* → stream", () => {
    assert.equal(classifyByModel("pi/aurelius-default"), "stream");
});
test("anthropic-direct/* → stream", () => {
    assert.equal(classifyByModel("anthropic-direct/claude-opus-4-7"), "stream");
});
test("openai-direct/* → stream", () => {
    assert.equal(classifyByModel("openai-direct/gpt-5"), "stream");
});
test("claude-cli/* → batch", () => {
    assert.equal(classifyByModel("claude-cli/claude-opus-4-7"), "batch");
});
test("openai-codex/* → batch", () => {
    assert.equal(classifyByModel("openai-codex/gpt-5.4"), "batch");
});
test("unknown prefix → unknown", () => {
    assert.equal(classifyByModel("mystery-llm/v9"), "unknown");
    assert.equal(classifyByModel(""), "unknown");
    assert.equal(classifyByModel(null), "unknown");
});
test("override 'always' → 0", () => {
    assert.equal(resolveLivenessThreshold("stream", "always", 30_000), 0);
});
test("override 'off' → infinity", () => {
    assert.equal(resolveLivenessThreshold("stream", "off", 30_000), Number.POSITIVE_INFINITY);
});
test("override 'batch' → 0", () => {
    assert.equal(resolveLivenessThreshold("stream", "batch", 30_000), 0);
});
test("override 'stream' on batch hint still threshold", () => {
    assert.equal(resolveLivenessThreshold("batch", "stream", 30_000), 90_000);
});
test("auto + batch hint → immediate", () => {
    assert.equal(resolveLivenessThreshold("batch", "auto", 30_000), 0);
});
test("auto + stream hint → 3× tickInterval (min 5s)", () => {
    assert.equal(resolveLivenessThreshold("stream", "auto", 30_000), 90_000);
    // Tick interval below 5s → floor at 5s.
    assert.equal(resolveLivenessThreshold("stream", "auto", 1_000), 5_000);
});
test("auto + unknown hint → 3× tickInterval", () => {
    assert.equal(resolveLivenessThreshold("unknown", "auto", 30_000), 90_000);
});
