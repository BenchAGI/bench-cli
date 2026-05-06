// Tests for the approval state machine (V1.1 — Item 3, SPEC §13).
// Covers approve, deny, Ctrl-C-default-deny, peer-resolved, and the
// case-insensitivity of the [A]/[D] keys.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApprovalState, type ApprovalAction } from "../render/approval.js";

function makeState() {
  const resolved: ApprovalAction[] = [];
  const state = new ApprovalState(async (action) => {
    resolved.push(action);
  });
  return { state, resolved };
}

function requestExecApproval(
  state: ApprovalState,
  approvalId: string,
): void {
  state.onAgentApproval({
    phase: "requested",
    approvalId,
    kind: "exec",
    title: "Run shell command",
    command: "ls",
    reason: "list current dir",
  } as never);
}

test("Approval: approve — [A] resolves with kind=exec, decision=approve", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap1");
  assert.equal(state.isPending(), true);

  const consumed = await state.handleKey("a");

  assert.equal(consumed, true);
  assert.equal(state.isPending(), false);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.kind, "exec");
  assert.equal(resolved[0]?.approvalId, "ap1");
  assert.equal(resolved[0]?.decision, "approve");
});

test("Approval: deny — [D] resolves with decision=deny", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap2");

  const consumed = await state.handleKey("d");

  assert.equal(consumed, true);
  assert.equal(state.isPending(), false);
  assert.equal(resolved[0]?.decision, "deny");
});

test("Approval: Ctrl-C-default-deny — denyOnInterrupt resolves pending as deny", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap3");

  await state.denyOnInterrupt();

  assert.equal(state.isPending(), false);
  assert.equal(resolved[0]?.decision, "deny");
  assert.equal(resolved[0]?.approvalId, "ap3");
});

test("Approval: keys are case-insensitive ('A' == 'a', 'D' == 'd')", async () => {
  const { state: s1, resolved: r1 } = makeState();
  requestExecApproval(s1, "ap-upper-a");
  await s1.handleKey("A");
  assert.equal(r1[0]?.decision, "approve");

  const { state: s2, resolved: r2 } = makeState();
  requestExecApproval(s2, "ap-upper-d");
  await s2.handleKey("D");
  assert.equal(r2[0]?.decision, "deny");
});

test("Approval: handleKey returns false for non-approval keys", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap-other");

  const consumedSpace = await state.handleKey(" ");
  const consumedArrow = await state.handleKey("[A");
  const consumedEnter = await state.handleKey("\r");

  assert.equal(consumedSpace, false);
  assert.equal(consumedArrow, false);
  assert.equal(consumedEnter, false);
  // Pending stays untouched, no resolution yet.
  assert.equal(state.isPending(), true);
  assert.equal(resolved.length, 0);
});

test("Approval: handleKey is a no-op when no approval is pending", async () => {
  const { state, resolved } = makeState();
  // No request issued.
  const consumed = await state.handleKey("a");
  assert.equal(consumed, false);
  assert.equal(resolved.length, 0);
});

test("Approval: denyOnInterrupt is a no-op when no approval is pending", async () => {
  const { state, resolved } = makeState();
  await state.denyOnInterrupt();
  assert.equal(resolved.length, 0);
});

// V1.1 — Item 3: SPEC §13 "Approval: resolved by peer mid-pending"
test("Approval: peer resolution clears pending without local input", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap-peer");
  assert.equal(state.isPending(), true);

  // A different surface (slack, web, another CLI) approved this.
  // The gateway emits a top-level exec.approval.resolved with the same id.
  state.onTopLevelResolved({ approvalId: "ap-peer", status: "approved" });

  assert.equal(state.isPending(), false);
  // No local resolveCb was fired — peer already handled it.
  assert.equal(resolved.length, 0);
});

test("Approval: peer resolution with non-matching id leaves pending intact", async () => {
  const { state } = makeState();
  requestExecApproval(state, "ap-mine");

  state.onTopLevelResolved({ approvalId: "different-id", status: "approved" });

  // Still pending — the peer-resolved was for a different approval.
  assert.equal(state.isPending(), true);
});

// V1.1 — Item 3 (Codex Anvil P1): sync predicate
test("Approval: canConsumeKey is synchronous and matches handleKey's decision", () => {
  const { state } = makeState();
  // No pending — nothing is consumable.
  assert.equal(state.canConsumeKey("a"), false);
  assert.equal(state.canConsumeKey("d"), false);
  assert.equal(state.canConsumeKey("x"), false);

  requestExecApproval(state, "ap-sync");
  // Now [A]/[D] are consumable.
  assert.equal(state.canConsumeKey("a"), true);
  assert.equal(state.canConsumeKey("A"), true);
  assert.equal(state.canConsumeKey("d"), true);
  assert.equal(state.canConsumeKey("D"), true);
  // Other keys are not.
  assert.equal(state.canConsumeKey("x"), false);
  assert.equal(state.canConsumeKey(" "), false);
  assert.equal(state.canConsumeKey("\r"), false);

  // Predicate is observation-only — does not clear pending.
  assert.equal(state.isPending(), true);
});

test("Approval: agent-stream resolved phase clears pending if id matches", async () => {
  const { state, resolved } = makeState();
  requestExecApproval(state, "ap-stream");

  // The agent-stream resolve event carries phase + same id.
  state.onAgentApproval({
    phase: "resolved",
    approvalId: "ap-stream",
    kind: "exec",
    status: "approved",
    title: "",
  } as never);

  assert.equal(state.isPending(), false);
  // No local resolveCb fired (resolution was already done upstream).
  assert.equal(resolved.length, 0);
});
