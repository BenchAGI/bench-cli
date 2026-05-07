// Tests for short-name resolution (SPEC §8).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveShortName } from "../commands/agents.js";
const AGENTS = [
    { id: "kestrel-aurelius" },
    { id: "kestrel-coder" },
    { id: "bailey" },
    { id: "cole" },
    { id: "ember" },
    { id: "piper" },
    { id: "sage" },
];
test("exact id matches", () => {
    assert.equal(resolveShortName("kestrel-aurelius", AGENTS)?.id, "kestrel-aurelius");
});
test("trail-segment match for hyphenated id", () => {
    assert.equal(resolveShortName("aurelius", AGENTS)?.id, "kestrel-aurelius");
    assert.equal(resolveShortName("coder", AGENTS)?.id, "kestrel-coder");
});
test("case-insensitive match", () => {
    assert.equal(resolveShortName("Bailey", AGENTS)?.id, "bailey");
    assert.equal(resolveShortName("AURELIUS", AGENTS)?.id, "kestrel-aurelius");
});
test("unknown short name returns null", () => {
    assert.equal(resolveShortName("nonsense", AGENTS), null);
});
test("ambiguous trail wins by exact-id check first", () => {
    // If trailing match would conflict, exact-id wins.
    const result = resolveShortName("ember", [
        { id: "kestrel-ember" },
        { id: "ember" },
    ]);
    assert.equal(result?.id, "ember");
});
