// Tests for the launcher effort taxonomy — the fix for "Ultra Code runs max thinking".
import assert from "node:assert/strict";
import { test } from "node:test";
import { effortChoices, effortIndexFor, effortValueForEnv, nextEffortValueForEnv, DEFAULT_EFFORT, ALL_EFFORTS, } from "../launcher/effort.js";
test("Ultra Code maps to ultracode (not max) and Max is a separate option", () => {
    const claude = effortChoices("local-claude");
    const ultra = claude.find((c) => c.label === "Ultra Code");
    assert.ok(ultra, "local Claude offers Ultra Code");
    assert.equal(ultra.value, "ultracode");
    const max = claude.find((c) => c.label === "Max");
    assert.equal(max?.value, "max");
    // The two must be distinct values — conflating them was the reported bug.
    assert.notEqual(ultra.value, max.value);
});
test("cloud effort exposes off..max and never ultracode", () => {
    const cloud = effortChoices("tunnel").map((c) => c.value);
    assert.deepEqual(cloud, ["off", "low", "medium", "high", "xhigh", "max"]);
    assert.ok(!cloud.includes("ultracode"));
    assert.deepEqual(effortChoices("direct"), effortChoices("tunnel"));
});
test("codex effort is minimal..xhigh (no max/ultracode)", () => {
    const codex = effortChoices("local-codex").map((c) => c.value);
    assert.deepEqual(codex, ["minimal", "low", "medium", "high", "xhigh"]);
});
test("default effort is medium and exists in every environment", () => {
    assert.equal(DEFAULT_EFFORT, "medium");
    for (const env of ["local-claude", "local-codex", "tunnel", "direct"]) {
        assert.ok(effortChoices(env).some((c) => c.value === "medium"), `${env} has medium`);
    }
});
test("effortIndexFor preserves the level across envs, else falls back to medium", () => {
    const xhighIdx = effortIndexFor("tunnel", "xhigh");
    assert.equal(effortChoices("tunnel")[xhighIdx].value, "xhigh");
    // ultracode -> not in cloud/codex -> medium
    assert.equal(effortChoices("tunnel")[effortIndexFor("tunnel", "ultracode")].value, "medium");
    assert.equal(effortChoices("local-codex")[effortIndexFor("local-codex", "ultracode")].value, "medium");
    // off -> not in codex -> medium
    assert.equal(effortChoices("local-codex")[effortIndexFor("local-codex", "off")].value, "medium");
});
test("unsupported saved efforts remain recoverable when switching to a supporting env", () => {
    assert.equal(effortValueForEnv("tunnel", "ultracode"), "medium");
    assert.equal(effortValueForEnv("local-claude", "ultracode"), "ultracode");
});
test("effort changes advance from the displayed fallback without mutating env-specific values early", () => {
    assert.equal(nextEffortValueForEnv("tunnel", "ultracode", 1), "high");
    assert.equal(nextEffortValueForEnv("local-claude", "ultracode", -1), "max");
});
test("ALL_EFFORTS covers every value used across environments", () => {
    for (const env of ["local-claude", "local-codex", "tunnel", "direct"]) {
        for (const choice of effortChoices(env)) {
            assert.ok(ALL_EFFORTS.includes(choice.value), `${choice.value} in ALL_EFFORTS`);
        }
    }
});
