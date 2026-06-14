// Tests for how the local seats translate the picker effort into launch flags.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeEffortArgs, buildCodexLaunchArgs } from "../launcher/seat.js";
test("claude --effort flag carries the 5 flag-supported levels", () => {
    assert.deepEqual(claudeEffortArgs("low"), ["--effort", "low"]);
    assert.deepEqual(claudeEffortArgs("medium"), ["--effort", "medium"]);
    assert.deepEqual(claudeEffortArgs("max"), ["--effort", "max"]);
    assert.deepEqual(claudeEffortArgs("xhigh"), ["--effort", "xhigh"]);
});
test("claude ultracode is NOT passed as --effort (rides CLAUDE_CODE_EFFORT_LEVEL)", () => {
    // The flag rejects ultracode; passing it here would error. The seat sets the env
    // var instead, so the flag list must be empty.
    assert.deepEqual(claudeEffortArgs("ultracode"), []);
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
