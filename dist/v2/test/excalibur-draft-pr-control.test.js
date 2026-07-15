import assert from "node:assert/strict";
import { test } from "node:test";
import { renderApprovalCard, renderCapabilities, renderReceipt } from "../excalibur/control-render.js";
import { __testing, ExcaliburHttpTransport, EXCALIBUR_DRAFT_PR_ACTION_ID, EXCALIBUR_DRAFT_PR_EXECUTOR_ID, EXCALIBUR_SCHEMA_VERSION, parseExcaliburExecutionReceipt, parseExcaliburProposal, } from "../excalibur/http-transport.js";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const PROPOSAL_ID = "20000000-0000-4000-8000-000000000002";
const COMMAND_ID = "30000000-0000-4000-8000-000000000003";
const APPROVAL_ID = "40000000-0000-4000-8000-000000000004";
const RECEIPT_ID = "50000000-0000-4000-8000-000000000005";
const NOW = "2099-07-14T12:00:00.000Z";
const EXPIRES = "2099-07-14T12:10:00.000Z";
const NONCE = "A".repeat(43);
const target = {
    resourceType: "github_draft_pull_request",
    repository: "BenchAGI/bench-cli",
};
const payload = {
    worktreePath: "/private/work/excalibur-one-surface-cli",
    remoteName: "origin",
    baseRef: "main",
    baseSha: "1".repeat(40),
    headRef: "codex/might-surface",
    headSha: "2".repeat(40),
    patchDigest: "3".repeat(64),
    changedPathsDigest: "4".repeat(64),
    packetDigest: "5".repeat(64),
    missionId: "pattern-a:mission-might-surface",
    principalId: "local-operator",
    sessionId: CONVERSATION_ID,
    missionDigest: "6".repeat(64),
    publicationGateDigest: "7".repeat(64),
    title: "feat(excalibur): add MIGHT surface",
    body: "Exact-head bounded draft publication.",
    labels: ["excalibur"],
    draftOnly: true,
};
function proposal() {
    return {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        proposalId: PROPOSAL_ID,
        commandId: COMMAND_ID,
        conversationId: CONVERSATION_ID,
        instanceId: "operator",
        actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
        target,
        payload,
        payloadDigest: "6".repeat(64),
        proposalDigest: "7".repeat(64),
        resourceFingerprints: {
            executorDigest: "0".repeat(64),
            worktreeDigest: "1".repeat(64),
            remoteUrlDigest: "2".repeat(64),
            baseDigest: "3".repeat(64),
            headDigest: "4".repeat(64),
            patchDigest: payload.patchDigest,
            changedPathsDigest: payload.changedPathsDigest,
            packetDigest: payload.packetDigest,
            missionDigest: payload.missionDigest,
            publicationGateDigest: payload.publicationGateDigest,
            actionBindingDigest: "8".repeat(64),
            anvilReceiptDigest: "9".repeat(64),
            patternAAttestationDigest: "a".repeat(64),
            patternAResourceSetDigest: "d".repeat(64),
            publisherPrincipal: "LightDriverCS",
            publisherPrincipalId: 42,
            publisherConfigDigest: "b".repeat(64),
            publisherConfigRootDigest: "e".repeat(64),
            publisherIdentityAttestationDigest: "c".repeat(64),
            publisherCredentialHelperDigest: "f".repeat(64),
            openPrDigest: "0".repeat(64),
        },
        policyResult: {
            decision: "allow",
            policyDigest: "8".repeat(64),
            reasons: ["all_preapproval_gates_satisfied"],
        },
        idempotencyKey: "ik_draft_pr_test",
        approvalId: APPROVAL_ID,
        createdAt: NOW,
        expiresAt: EXPIRES,
    };
}
test("real mono-shaped draft proposal accepts typed publisher identity fingerprints", () => {
    const parsed = parseExcaliburProposal(proposal());
    assert.equal(parsed.resourceFingerprints.publisherPrincipal, "LightDriverCS");
    assert.equal(parsed.resourceFingerprints.publisherPrincipalId, 42);
    assert.throws(() => parseExcaliburProposal({
        ...proposal(),
        resourceFingerprints: { ...proposal().resourceFingerprints, publisherPrincipalId: 0 },
    }), /validated proposal failed contract validation/);
    assert.throws(() => parseExcaliburProposal({
        ...proposal(),
        resourceFingerprints: { ...proposal().resourceFingerprints, "bad-key": "x" },
    }), /validated proposal failed contract validation/);
});
function approval(decision = "pending") {
    return {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        approvalId: APPROVAL_ID,
        proposalId: PROPOSAL_ID,
        proposalDigest: "7".repeat(64),
        principalId: "local-operator",
        decision,
        grantedScope: [EXCALIBUR_DRAFT_PR_ACTION_ID],
        singleUse: true,
        confirmationNonce: NONCE,
        ...(decision === "approved" ? { decidedAt: "2099-07-14T12:01:00.000Z" } : {}),
        expiresAt: EXPIRES,
    };
}
function receipt(outcome = "succeeded") {
    return {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        receiptId: RECEIPT_ID,
        commandId: COMMAND_ID,
        proposalId: PROPOSAL_ID,
        approvalId: APPROVAL_ID,
        conversationId: CONVERSATION_ID,
        instanceId: "operator",
        actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
        executorId: EXCALIBUR_DRAFT_PR_EXECUTOR_ID,
        outcome,
        idempotencyKey: "ik_draft_pr_test",
        inputDigest: "9".repeat(64),
        evidenceRefs: ["github:BenchAGI/bench-cli:pull:321"],
        result: {
            repository: "BenchAGI/bench-cli",
            pullRequestNumber: 321,
            pullRequestUrl: "https://github.com/BenchAGI/bench-cli/pull/321",
            headRef: "codex/might-surface",
            headSha: "2".repeat(40),
            draft: true,
            publisherPrincipal: "LightDriverCS",
            publisherPrincipalId: 42,
            publisherConfigDigest: "b".repeat(64),
            publisherIdentityAttestationDigest: "c".repeat(64),
            outputDigest: "a".repeat(64),
            ...(outcome === "indeterminate"
                ? { indeterminateReason: "provider_timeout_after_push", reconciliationRequired: true }
                : {}),
        },
        occurredAt: "2099-07-14T12:02:00.000Z",
    };
}
function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}
test("draft-PR proposal and approval bind exact hashes and a non-rendered single-use nonce", async () => {
    const bodies = [];
    const transport = new ExcaliburHttpTransport({
        baseUrl: "http://127.0.0.1:4178",
        posture: "sidecar",
        scope: { kind: "operator" },
        accessToken: "synthetic-sidecar-token",
        fetchFn: async (input, init = {}) => {
            const url = new URL(String(input));
            bodies.push(JSON.parse(String(init.body)));
            if (url.pathname.endsWith("/control/proposals")) {
                return json({ proposal: proposal(), approval: approval(), receipt: null, replayed: false }, 201);
            }
            if (url.pathname.endsWith(`/control/approvals/${APPROVAL_ID}/decide`)) {
                return json({
                    approval: approval("approved"),
                    proposal: proposal(),
                    receipt: receipt(),
                    executionUnconfirmed: false,
                    replayed: false,
                });
            }
            throw new Error(`unexpected path ${url.pathname}`);
        },
    });
    const created = await transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload,
            idempotencyKey: "ik_draft_pr_test",
        },
    });
    assert.equal(created.proposal.payload.headSha, "2".repeat(40));
    assert.equal(created.approval.confirmationNonce, NONCE);
    const card = renderApprovalCard(created.proposal, created.approval).join("\n");
    assert.match(card, /BenchAGI\/bench-cli/);
    assert.match(card, /pattern-a:mission-might-surface/);
    assert.match(card, new RegExp(`authority: principal local-operator · session ${CONVERSATION_ID}`));
    assert.match(card, new RegExp("7".repeat(64)));
    assert.match(card, /push exact head \+ open draft PR/);
    assert.match(card, /title \(exact JSON string\): "feat\(excalibur\): add MIGHT surface"/);
    assert.match(card, /body \(exact JSON string\): "Exact-head bounded draft publication\."/);
    assert.match(card, new RegExp(`changed paths: ${"4".repeat(64)} · packet: ${"5".repeat(64)}`));
    assert.match(card, /publisher: LightDriverCS #42/);
    assert.match(card, new RegExp(`publisher config: ${"b".repeat(64)}`));
    assert.match(card, new RegExp(`publisher identity attestation: ${"c".repeat(64)}`));
    assert.doesNotMatch(card, new RegExp(NONCE));
    const decided = await transport.decideApproval(APPROVAL_ID, {
        decision: "approved",
        proposalDigest: created.proposal.proposalDigest,
        confirmationNonce: created.approval.confirmationNonce,
    });
    assert.equal(decided.approval.decision, "approved");
    assert.equal(decided.receipt?.outcome, "succeeded");
    assert.deepEqual(bodies[1], {
        decision: "approved",
        proposalDigest: "7".repeat(64),
        confirmationNonce: NONCE,
    });
});
test("draft-only authority validation rejects mutable or non-draft intent before fetch", async () => {
    let calls = 0;
    const transport = new ExcaliburHttpTransport({
        baseUrl: "http://127.0.0.1:4178",
        posture: "sidecar",
        scope: { kind: "operator" },
        accessToken: "synthetic-sidecar-token",
        fetchFn: async () => { calls += 1; return json({}); },
    });
    await assert.rejects(transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload: { ...payload, draftOnly: false },
            idempotencyKey: "draft_pr_test",
        },
    }), /draft PR proposal intent is malformed/);
    assert.equal(calls, 0);
    await assert.rejects(transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload: { ...payload, sessionId: "90000000-0000-4000-8000-000000000009" },
            idempotencyKey: "draft_pr_provenance_test",
        },
    }), /session provenance does not match/);
    assert.equal(calls, 0);
    const { principalId: _principalId, ...withoutPrincipal } = payload;
    await assert.rejects(transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload: withoutPrincipal,
            idempotencyKey: "draft_pr_missing_principal_test",
        },
    }), /draft PR proposal intent is malformed/);
    const { sessionId: _sessionId, ...withoutSession } = payload;
    await assert.rejects(transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload: withoutSession,
            idempotencyKey: "draft_pr_missing_session_test",
        },
    }), /draft PR proposal intent is malformed/);
    assert.equal(calls, 0);
});
test("createProposal rejects a sidecar response that rewrites principal provenance", async () => {
    const transport = new ExcaliburHttpTransport({
        baseUrl: "http://127.0.0.1:4178",
        posture: "sidecar",
        scope: { kind: "operator" },
        accessToken: "synthetic-sidecar-token",
        fetchFn: async () => json({
            proposal: {
                ...proposal(),
                payload: { ...payload, principalId: "another-operator" },
            },
            approval: approval(),
            receipt: null,
            replayed: false,
        }, 201),
    });
    await assert.rejects(transport.createProposal({
        conversationId: CONVERSATION_ID,
        intent: {
            actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
            target,
            payload,
            idempotencyKey: "ik_draft_pr_test",
        },
    }), /does not bind the exact submitted intent/);
});
test("indeterminate GitHub receipts remain typed, visible, and reconciliation-specific", () => {
    const parsed = parseExcaliburExecutionReceipt(receipt("indeterminate"));
    const rendered = renderReceipt(parsed).join("\n");
    assert.match(rendered, /indeterminate/);
    assert.match(rendered, /provider_timeout_after_push · reconciliation required/);
    assert.match(rendered, /publisher: LightDriverCS #42/);
    assert.match(rendered, /identity attestation: c{64}/);
    assert.match(rendered, /https:\/\/github\.com\/BenchAGI\/bench-cli\/pull\/321/);
});
test("draft receipts require kernel-derived publisher identity attestation and reject payload-only mission fields", () => {
    const { publisherPrincipal: _publisherPrincipal, ...missingPrincipal } = receipt().result;
    assert.throws(() => parseExcaliburExecutionReceipt({ ...receipt(), result: missingPrincipal }), /execution receipt failed contract validation/);
    assert.throws(() => parseExcaliburExecutionReceipt({
        ...receipt(),
        result: { ...receipt().result, missionDigest: "d".repeat(64) },
    }), /execution receipt failed contract validation/);
});
test("draft publisher capability and receipt reject a drifted executor binding", () => {
    const draftCapability = {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        capabilityId: EXCALIBUR_DRAFT_PR_ACTION_ID,
        title: "Publish exact-head draft PR",
        kind: "action",
        mode: "propose_approve_execute",
        inputSchemaId: "Excalibur.Action.GithubDraftPrPublish.Input.v1",
        outputSchemaId: "Excalibur.ExecutionReceipt.GithubDraftPrPublish.v1",
        risk: "high",
        requiredScopes: [EXCALIBUR_DRAFT_PR_ACTION_ID],
        dataClasses: ["opaque_identifier"],
        approvalPolicy: {
            kind: "single_human_exact_digest",
            expiresInSeconds: 600,
            typedProseAccepted: false,
            singleUse: true,
        },
        executor: { kind: "deterministic", executorId: "github.draft-pr-publisher.v1" },
        availability: { status: "locked", blockingGates: ["exact_human_approval"] },
    };
    assert.throws(() => __testing.parseCapability(draftCapability), /must bind excalibur\.sidecar\.github-draft-pr\.v1/);
    assert.match(renderCapabilities([draftCapability], "action").join("\n"), /executor binding: blocked · expected excalibur\.sidecar\.github-draft-pr\.v1/);
    assert.throws(() => parseExcaliburExecutionReceipt({ ...receipt(), executorId: "github.draft-pr-publisher.v1" }), /execution receipt failed contract validation/);
    const rendered = renderReceipt({ ...receipt(), executorId: "github.draft-pr-publisher.v1" }).join("\n");
    assert.match(rendered, /blocked.*untrusted receipt executor binding/);
    assert.doesNotMatch(rendered, /pull request:/);
});
test("unknown future action receipts tolerate bounded result fields without inventing UI authority", () => {
    const unknown = parseExcaliburExecutionReceipt({
        ...receipt(),
        actionId: "future.typed.action.v1",
        result: { futureField: { bounded: true }, outputDigest: "a".repeat(64) },
    });
    assert.equal(unknown.actionId, "future.typed.action.v1");
    assert.match(renderReceipt(unknown).join("\n"), /future\.typed\.action\.v1/);
});
