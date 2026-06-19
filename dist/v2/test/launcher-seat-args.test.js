// Tests for how the local seats translate the picker effort into launch flags.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeEffortArgs, buildCodexLaunchArgs, writeClaudeLaunchSettings } from "../launcher/seat.js";
test("claude --effort flag carries the 5 flag-supported levels", () => {
    assert.deepEqual(claudeEffortArgs("low"), ["--effort", "low"]);
    assert.deepEqual(claudeEffortArgs("medium"), ["--effort", "medium"]);
    assert.deepEqual(claudeEffortArgs("max"), ["--effort", "max"]);
    assert.deepEqual(claudeEffortArgs("xhigh"), ["--effort", "xhigh"]);
});
test("claude ultracode maps to xhigh effort plus session settings", () => {
    // The flag rejects literal "ultracode"; Claude Code enables it through
    // --settings while the effort flag carries the underlying xhigh level.
    assert.deepEqual(claudeEffortArgs("ultracode"), ["--effort", "xhigh"]);
    const dir = mkdtempSync(join(tmpdir(), "benchagi-claude-settings-"));
    const baseSettings = join(dir, "settings.json");
    writeFileSync(baseSettings, JSON.stringify({
        outputStyle: "BenchAGI",
        hooks: { Stop: [] },
    }), "utf8");
    const launchSettings = writeClaudeLaunchSettings(baseSettings, "ultracode", "seat-1", dir);
    assert.ok(launchSettings);
    assert.notEqual(launchSettings, baseSettings);
    const merged = JSON.parse(readFileSync(launchSettings, "utf8"));
    assert.equal(merged.outputStyle, "BenchAGI");
    assert.deepEqual(merged.hooks, { Stop: [] });
    assert.equal(merged.ultracode, true);
});
test("claude non-ultracode launches reuse the normal settings file", () => {
    assert.equal(writeClaudeLaunchSettings("/tmp/settings.json", "xhigh", "seat-1"), "/tmp/settings.json");
});
function codexEffortArg(effort) {
    const args = buildCodexLaunchArgs("/tmp/codex-ws", { effort: effort });
    return args.find((a) => a.startsWith("model_reasoning_effort="));
}
test("codex clamps efforts to its valid minimal..xhigh set", () => {
    assert.equal(codexEffortArg("minimal"), 'model_reasoning_effort="minimal"');
    assert.equal(codexEffortArg("medium"), 'model_reasoning_effort="medium"');
    assert.equal(codexEffortArg("xhigh"), 'model_reasoning_effort="xhigh"');
    // out-of-range levels carried from another env clamp instead of erroring
    assert.equal(codexEffortArg("off"), 'model_reasoning_effort="minimal"');
    assert.equal(codexEffortArg("max"), 'model_reasoning_effort="xhigh"');
    assert.equal(codexEffortArg("ultracode"), 'model_reasoning_effort="xhigh"');
});
