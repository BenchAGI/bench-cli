// Tests for `benchagi doctor --report` severity mapping + cowork URL joining
// (Forge diagnostics intake, WS4).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { coworkUrl, markdownTableCell, severityFor } from "../commands/forge-report.js";
const check = (status) => ({ name: "x", status, detail: "d" });
test("any bad check maps to sev-2", () => {
    assert.equal(severityFor([check("ok"), check("warn"), check("bad")]), "sev-2");
});
test("warns only map to sev-3", () => {
    assert.equal(severityFor([check("ok"), check("warn")]), "sev-3");
});
test("all green maps to question (attach-only report)", () => {
    assert.equal(severityFor([check("ok"), check("ok")]), "question");
});
test("coworkUrl keeps an /api/v1 base as-is", () => {
    assert.equal(coworkUrl("https://benchagi.com/api/v1", "/cowork/forge/ticket"), "https://benchagi.com/api/v1/cowork/forge/ticket");
});
test("coworkUrl adds /api/v1 to a bare origin (trailing slash tolerated)", () => {
    assert.equal(coworkUrl("https://benchagi.com/", "/cowork/auth/refresh"), "https://benchagi.com/api/v1/cowork/auth/refresh");
});
test("markdownTableCell escapes backslashes and pipes before flattening newlines", () => {
    assert.equal(markdownTableCell("path\\|with\nnewline"), "path\\\\\\|with newline");
});
