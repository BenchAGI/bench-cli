import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCALIBUR_EXPECTED_DIGESTS } from "../excalibur/contract-baseline.js";
import { EXCALIBUR_DRAFT_PR_ACTION_ID, EXCALIBUR_DRAFT_PR_EXECUTOR_ID, EXCALIBUR_SCHEMA_VERSION, } from "../excalibur/http-transport.js";
import { renderOneSurfaceStartupBrief, summarizeOneSurfaceReadiness, } from "../excalibur/readiness.js";
const NOW = "2026-07-14T12:00:00.000Z";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const controlSession = {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    sessionId: "10000000-0000-4000-8000-000000000001",
    principal: { principalId: "operator", kind: "human" },
    scopes: [],
    rank: "operator",
    contextKind: "operator",
    activeInstance: null,
    surface: "cli",
    effectsPosture: "locked",
    authMethod: "loopback_session",
    digests: { ...EXCALIBUR_EXPECTED_DIGESTS },
    issuedAt: NOW,
    tokenExpiresAt: "2026-07-14T12:05:00.000Z",
};
const conversation = {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    scope: { kind: "operator" },
    providerSession: {
        provider: "xai",
        requestedModel: "grok-4.5",
        servedModel: "grok-4.5",
        providerSessionId: "provider-session",
        attestationDigest: "d".repeat(64),
        attestedAt: NOW,
    },
    eventCursor: 7,
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
};
function snapshot() {
    const observation = (capabilityId, facts, freshness = "fresh") => ({
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        observationId: `test:operator:${capabilityId}`,
        capabilityId,
        instanceId: "operator",
        facts,
        authoritativeSource: "test.sidecar",
        sourceVersion: "v1",
        observedDigest: "a".repeat(64),
        observedAt: NOW,
        freshness: { state: freshness, maxAgeSeconds: 60 },
        evidenceRefs: [],
        redactionLevel: "aggregate_only",
    });
    return {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        instanceId: "operator",
        manifestDigest: EXCALIBUR_EXPECTED_DIGESTS.manifest,
        observedAt: NOW,
        observations: [
            observation("drive.status", {
                conversationId: SESSION_ID,
                conversationState: "active",
                requestedModel: "grok-4.5",
                servedModel: "grok-4.5",
                blockers: ["served-model-safe"],
            }),
            observation("memory.status", {
                state: "unavailable",
                adapter: "aurelius_local",
                mode: "personal_durable",
                reason: "operator_memory_shelf_unconfigured",
                promotedCount: 0,
            }, "unavailable"),
            observation("schedules", {
                total: 4,
                declared: 4,
                armed: 2,
                agenda: {
                    state: "ready",
                    enabled: true,
                    configured: true,
                    provider: "gog",
                    timezone: "America/Denver",
                    lookaheadDays: 7,
                    upcomingCount: 3,
                    account: "operator@example.test",
                    calendarId: "private-calendar@example.test",
                },
            }),
            observation("controls", { blockers: ["cloud_approval_broker_required"] }),
            observation("system", {
                service: "excalibur-forge-console",
                packageVersion: "0.5.0",
                bundleVersion: "10",
                protocolVersion: 4,
            }),
        ],
    };
}
test("startup brief is deterministic, projection-only, and omits calendar identifiers", () => {
    const readiness = summarizeOneSurfaceReadiness({
        controlSession,
        snapshot: snapshot(),
        conversation,
    });
    const lines = renderOneSurfaceStartupBrief(readiness);
    const text = lines.join("\n");
    assert.match(text, /One-Surface MIGHT startup · PREPARE · core contract verified/);
    assert.match(text, new RegExp(SESSION_ID));
    assert.match(text, /served grok-4\.5/);
    assert.match(text, /operator_memory_shelf_unconfigured/);
    assert.match(text, /total 4 · declared 4 · armed 2/);
    assert.match(text, /calendar ready · configured yes · enabled yes · upcoming 3/);
    assert.match(text, /protocol 4/);
    assert.equal(readiness.system.protocolVersion, "4");
    assert.match(text, /cloud_approval_broker_required, served-model-safe/);
    assert.doesNotMatch(text, /operator@example|private-calendar/);
});
test("MIGHT posture reaches WIELD only for an approval-bound typed action and never implies LAND", () => {
    const capability = {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        capabilityId: EXCALIBUR_DRAFT_PR_ACTION_ID,
        title: "Publish exact-head draft PR",
        kind: "action",
        mode: "propose_approve_execute",
        inputSchemaId: "Excalibur.Action.GitHubDraftPrPublish.Input.v1",
        outputSchemaId: "Excalibur.ExecutionReceipt.v1",
        risk: "high",
        requiredScopes: [EXCALIBUR_DRAFT_PR_ACTION_ID],
        dataClasses: ["opaque_identifier"],
        approvalPolicy: {
            kind: "single_human_exact_digest",
            expiresInSeconds: 600,
            typedProseAccepted: false,
            singleUse: true,
        },
        executor: { kind: "deterministic", executorId: EXCALIBUR_DRAFT_PR_EXECUTOR_ID },
        availability: { status: "locked", blockingGates: ["exact_human_approval"] },
    };
    const readiness = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "approval_bound" },
        snapshot: snapshot(),
        conversation,
        capabilities: [capability],
    });
    assert.equal(readiness.posture, "WIELD");
    assert.equal(readiness.health.publisher.state, "ready");
    assert.match(renderOneSurfaceStartupBrief(readiness).join("\n"), /merge\/ready\/deploy|draft-only/);
    const shadow = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "read_only" },
        snapshot: snapshot(),
        conversation,
        capabilities: [capability],
    });
    assert.equal(shadow.posture, "SHADOW");
    const drifted = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "approval_bound" },
        snapshot: snapshot(),
        conversation,
        capabilities: [{
                ...capability,
                executor: { kind: "deterministic", executorId: "github.draft-pr-publisher.v1" },
            }],
    });
    assert.equal(drifted.posture, "PREPARE");
    assert.equal(drifted.health.publisher.state, "blocked");
    assert.match(drifted.health.publisher.detail, /executor binding mismatch/);
    const missing = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "approval_bound" },
        snapshot: snapshot(),
        conversation,
        capabilities: [{ ...capability, capabilityId: "future.typed.action.v1" }],
    });
    assert.equal(missing.posture, "PREPARE");
    assert.equal(missing.health.publisher.state, "unavailable");
    const land = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "approval_bound" },
        snapshot: snapshot(),
        conversation,
        capabilities: [capability, { ...capability, capabilityId: "github.pr.merge.v1" }],
    });
    assert.equal(land.posture, "LAND");
});
test("loaded sidecar memory posture overrides a pre-load snapshot without exposing content", () => {
    const memoryStatus = {
        schemaVersion: "excalibur.memory-posture.v1",
        scopeKind: "operator",
        memoryPosture: {
            mode: "personal_durable",
            adapter: "aurelius_local",
            instanceId: null,
            sources: ["memory"],
            sessionsConsented: false,
            dreamsConsented: false,
            operatorFallback: false,
            nativeModelMemory: false,
            receiptsIncluded: false,
            scratchRetentionSeconds: 90_000,
        },
        adapterStatus: {
            schemaVersion: "excalibur.memory-context.v1",
            scopeKind: "operator",
            adapter: "aurelius_local",
            mode: "personal_durable",
            state: "available",
            sources: ["memory"],
            promotedCount: 3,
            operatorFallback: false,
            nativeModelMemory: false,
            receiptsIncluded: false,
            observedDigest: "b".repeat(64),
            reason: null,
            contentIncluded: false,
        },
        contentIncluded: false,
    };
    const readiness = summarizeOneSurfaceReadiness({
        controlSession,
        snapshot: snapshot(),
        conversation,
        memoryStatus,
    });
    assert.equal(readiness.memory.state, "available");
    assert.equal(readiness.memory.promotedCount, 3);
    assert.equal(readiness.blockers.includes("memory_projection_unavailable"), false);
});
test("MIGHT health reports exact support seats, worktree heads, ledger, and publisher independently", () => {
    const value = snapshot();
    const template = value.observations[0];
    value.observations.push({
        ...template,
        observationId: "test:operator:fleet",
        capabilityId: "fleet",
        facts: {
            seats: [
                { seatId: "sol", role: "builder", provider: "openai", requestedModel: "codex-5.6", servedModel: "codex-5.6", state: "ready", attestationDigest: "c".repeat(64) },
                { seatId: "fable", role: "planner", provider: "anthropic", requestedModel: "claude-fable", servedModel: "claude-fable", state: "ready", attestationDigest: "d".repeat(64) },
            ],
        },
    }, {
        ...template,
        observationId: "test:operator:forge",
        capabilityId: "forge",
        facts: { worktrees: [{ path: "/private/work/sol", state: "ready", clean: true, headSha: "e".repeat(40) }] },
    }, {
        ...template,
        observationId: "test:operator:receipts",
        capabilityId: "receipts",
        facts: { receiptCount: 12, appendOnly: true },
    });
    const draftCapability = {
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        capabilityId: EXCALIBUR_DRAFT_PR_ACTION_ID,
        title: "Publish exact-head draft PR",
        kind: "action",
        mode: "propose_approve_execute",
        inputSchemaId: "Excalibur.Action.GitHubDraftPrPublish.Input.v1",
        outputSchemaId: "Excalibur.ExecutionReceipt.v1",
        risk: "high",
        requiredScopes: [EXCALIBUR_DRAFT_PR_ACTION_ID],
        dataClasses: ["opaque_identifier"],
        approvalPolicy: { kind: "single_human_exact_digest", expiresInSeconds: 600, typedProseAccepted: false, singleUse: true },
        executor: { kind: "deterministic", executorId: EXCALIBUR_DRAFT_PR_EXECUTOR_ID },
        availability: { status: "locked", blockingGates: ["exact_human_approval"] },
    };
    const readiness = summarizeOneSurfaceReadiness({
        controlSession: { ...controlSession, effectsPosture: "approval_bound" },
        snapshot: value,
        conversation,
        capabilities: [draftCapability],
        receiptPage: { receipts: [] },
    });
    assert.equal(readiness.health.publisher.state, "ready");
    assert.equal(readiness.health.worktree.state, "ready");
    assert.equal(readiness.health.ledger.state, "ready");
    assert.deepEqual(readiness.health.seats.slice(1).map((item) => [item.seatId, item.servedModel, item.state]), [
        ["sol", "codex-5.6", "ready"],
        ["fable", "claude-fable", "ready"],
    ]);
});
test("missing served-model evidence is surfaced as a deterministic blocker", () => {
    const value = snapshot();
    const drive = value.observations.find((item) => item.capabilityId === "drive.status");
    drive.facts.servedModel = null;
    drive.facts.conversationId = null;
    drive.facts.conversationState = "unavailable";
    const readiness = summarizeOneSurfaceReadiness({ controlSession, snapshot: value });
    assert.equal(readiness.servedModel, null);
    assert.deepEqual(readiness.blockers.filter((item) => ["served_model_attestation_required", "shared_conversation_unavailable"].includes(item)), ["served_model_attestation_required", "shared_conversation_unavailable"]);
});
