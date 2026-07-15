import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runExcaliburConversation } from "../excalibur/conversation.js";
import {
  EXCALIBUR_CONTRACT_BASELINE,
  EXCALIBUR_EXPECTED_DIGESTS,
} from "../excalibur/contract-baseline.js";
import {
  ExcaliburEffectsLockedError,
  ExcaliburHttpTransport,
  EXCALIBUR_DRAFT_PR_ACTION_ID,
  EXCALIBUR_DRAFT_PR_EXECUTOR_ID,
  EXCALIBUR_PROTOCOL_VERSION,
  EXCALIBUR_SCHEMA_VERSION,
  expectedExcaliburExecutorId,
} from "../excalibur/http-transport.js";
import { loadExcaliburState } from "../excalibur/scoped-state.js";
import { ExcaliburSidecarRuntime } from "../excalibur/sidecar-runtime.js";
import {
  EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA,
  EXCALIBUR_ORCHESTRA_PREFLIGHT_RESULT_SCHEMA,
} from "../excalibur/orchestra-broker.js";
import type { StateScope } from "../state/scope.js";

const CONTROL_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const RUN_ID = "30000000-0000-4000-8000-000000000003";
const COMMAND_ID = "40000000-0000-4000-8000-000000000004";
const PROPOSAL_ID = "50000000-0000-4000-8000-000000000005";
const APPROVAL_ID = "60000000-0000-4000-8000-000000000006";
const RECEIPT_ID = "70000000-0000-4000-8000-000000000007";
const CONFIRMATION_NONCE = "N".repeat(43);
const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2099-07-13T12:10:00.000Z";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const operatorScope: StateScope = {
  principalId: "operator-a",
  principalHash: "operator-a",
  instanceId: "instance-1",
  authenticated: true,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function controlSession(
  scope: "operator" | "tenant" = "operator",
  effectsPosture: "locked" | "read_only" | "approval_bound" = "locked",
): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    sessionId: CONTROL_ID,
    principal: { principalId: "operator-a", kind: "human" },
    scopes: [],
    rank: "operator",
    surface: "cli",
    effectsPosture,
    digests: { ...EXCALIBUR_EXPECTED_DIGESTS },
    issuedAt: NOW,
    tokenExpiresAt: "2026-07-13T12:05:00.000Z",
    contextKind: scope,
    activeInstance: scope === "operator" ? null : { instanceId: "instance-1", roles: ["member"] },
    authMethod: scope === "operator" ? "loopback_session" : "firebase_human",
  };
}

function conversation(eventCursor = 0, scope: "operator" | "tenant" = "operator"): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    scope: scope === "operator" ? { kind: "operator" } : { kind: "tenant", instanceId: "instance-1" },
    providerSession: {
      provider: "xai",
      requestedModel: "grok-4.5",
      servedModel: "grok-4.5",
      providerSessionId: "provider-shared-session",
      attestationDigest: "d".repeat(64),
      attestedAt: NOW,
    },
    eventCursor,
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function controlSnapshot(scope: "operator" | "tenant" = "operator"): Record<string, unknown> {
  const instanceId = scope === "operator" ? "operator" : "instance-1";
  const observation = (
    capabilityId: string,
    facts: Record<string, unknown>,
    freshness: "fresh" | "stale" | "unavailable" = "fresh",
  ): Record<string, unknown> => ({
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    observationId: `test:${instanceId}:${capabilityId}`,
    capabilityId,
    instanceId,
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
    instanceId,
    manifestDigest: EXCALIBUR_EXPECTED_DIGESTS.manifest,
    observedAt: NOW,
    observations: [
      observation("drive.status", {
        conversationId: SESSION_ID,
        conversationState: "active",
        requestedModel: "grok-4.5",
        servedModel: "grok-4.5",
        blockers: [],
      }),
      observation("memory.status", {
        adapter: scope === "operator" ? "aurelius_local" : "memory_tap",
        mode: scope === "operator" ? "personal_durable" : "shadow",
        state: "available",
        reason: null,
        promotedCount: 0,
      }),
      observation("schedules", { total: 2, declared: 2, armed: 1 }),
      observation("controls", { blockers: ["cloud_approval_broker_required"] }),
      observation("system", {
        service: "excalibur-forge-console",
        packageVersion: "0.5.0",
        bundleVersion: "10",
        protocolVersion: "4",
      }),
    ],
  };
}

function memoryPosture(scope: "operator" | "tenant" = "operator"): Record<string, unknown> {
  const operator = scope === "operator";
  return {
    schemaVersion: "excalibur.memory-posture.v1",
    scopeKind: scope,
    memoryPosture: {
      mode: operator ? "personal_durable" : "shadow",
      adapter: operator ? "aurelius_local" : "memory_tap",
      instanceId: operator ? null : "instance-1",
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
      scopeKind: scope,
      adapter: operator ? "aurelius_local" : "memory_tap",
      mode: operator ? "personal_durable" : "shadow",
      state: "available",
      sources: ["memory"],
      promotedCount: 0,
      operatorFallback: false,
      nativeModelMemory: false,
      receiptsIncluded: false,
      observedDigest: "b".repeat(64),
      reason: null,
      contentIncluded: false,
    },
    contentIncluded: false,
  };
}

function capabilities(): Record<string, unknown>[] {
  return [
    ...EXCALIBUR_CONTRACT_BASELINE.viewCapabilityIds.map((capabilityId) => ({
      schemaVersion: EXCALIBUR_SCHEMA_VERSION,
      capabilityId,
      title: capabilityId,
      kind: "read",
      mode: "observe",
      outputSchemaId: "Excalibur.Observation.v1",
      risk: "none",
      requiredScopes: [`${capabilityId}:read`],
      dataClasses: ["aggregate"],
      approvalPolicy: { kind: "none" },
      executor: { kind: "none" },
      availability: capabilityId === "finance"
        ? { status: "unavailable", blockingGates: ["v1_finance_locked"] }
        : { status: "available", blockingGates: [] },
    })),
    ...[...new Set([
      ...EXCALIBUR_CONTRACT_BASELINE.actionCapabilityIds,
      EXCALIBUR_DRAFT_PR_ACTION_ID,
    ])].map((capabilityId) => ({
      schemaVersion: EXCALIBUR_SCHEMA_VERSION,
      capabilityId,
      title: capabilityId,
      kind: "action",
      mode: "propose_approve_execute",
      inputSchemaId: `Excalibur.Action.${capabilityId}.Input.v1`,
      outputSchemaId: "Excalibur.ExecutionReceipt.v1",
      risk: "high",
      requiredScopes: [capabilityId],
      dataClasses: ["aggregate", "opaque_identifier"],
      approvalPolicy: {
        kind: "single_human_exact_digest",
        expiresInSeconds: 600,
        typedProseAccepted: false,
        singleUse: true,
      },
      executor: {
        kind: "deterministic",
        executorId: expectedExcaliburExecutorId(capabilityId) ?? `test.${capabilityId}`,
      },
      availability: { status: "locked", blockingGates: ["exact_human_approval"] },
    })),
  ];
}

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  runId = RUN_ID,
): Record<string, unknown> {
  return {
    protocolVersion: EXCALIBUR_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    sequence,
    runId,
    timestamp: NOW,
    type,
    payload,
  };
}

function proposal(): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    proposalId: PROPOSAL_ID,
    commandId: COMMAND_ID,
    conversationId: SESSION_ID,
    instanceId: "instance-1",
    actionId: "sales.whitespace.generate",
    target: { resourceType: "sales_whitespace_report" },
    payload: {
      mode: "field-only",
      maximumDeals: 2000,
      thresholdProfileDigest: "1".repeat(64),
      stageSetDigest: "2".repeat(64),
      destinationDigest: "3".repeat(64),
      retentionDays: 14,
    },
    payloadDigest: "4".repeat(64),
    proposalDigest: "5".repeat(64),
    resourceFingerprints: { engine: "6".repeat(64) },
    policyResult: { decision: "allow", policyDigest: "7".repeat(64), reasons: ["all_preapproval_gates_satisfied"] },
    idempotencyKey: "whitespace-test-command",
    approvalId: APPROVAL_ID,
    createdAt: "2099-07-13T12:00:00.000Z",
    expiresAt: EXPIRES,
  };
}

function approval(decision: "pending" | "approved" = "pending"): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    approvalId: APPROVAL_ID,
    proposalId: PROPOSAL_ID,
    proposalDigest: "5".repeat(64),
    principalId: "operator-a",
    decision,
    grantedScope: ["sales.whitespace.generate"],
    singleUse: true,
    ...(decision === "pending" ? {} : { decidedAt: "2099-07-13T12:01:00.000Z" }),
    expiresAt: EXPIRES,
  };
}

function draftProposal(): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    proposalId: PROPOSAL_ID,
    commandId: COMMAND_ID,
    conversationId: SESSION_ID,
    instanceId: "operator",
    actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
    target: {
      resourceType: "github_draft_pull_request",
      repository: "BenchAGI/bench-cli",
    },
    payload: {
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
      missionDigest: "6".repeat(64),
      publicationGateDigest: "7".repeat(64),
      title: "feat(excalibur): add MIGHT surface",
      body: "Exact-head bounded draft publication.",
      labels: ["excalibur"],
      draftOnly: true,
    },
    payloadDigest: "6".repeat(64),
    proposalDigest: "7".repeat(64),
    resourceFingerprints: {
      base: "1".repeat(64),
      head: "2".repeat(64),
      patch: "3".repeat(64),
      publisherPrincipal: "LightDriverCS",
      publisherPrincipalId: 42,
      publisherConfigDigest: "b".repeat(64),
      publisherIdentityAttestationDigest: "c".repeat(64),
    },
    policyResult: {
      decision: "allow",
      policyDigest: "8".repeat(64),
      reasons: ["all_preapproval_gates_satisfied"],
    },
    idempotencyKey: "ik_draft_pr_runtime_test",
    approvalId: APPROVAL_ID,
    createdAt: "2099-07-13T12:00:00.000Z",
    expiresAt: EXPIRES,
  };
}

function draftApproval(decision: "pending" | "approved" = "pending"): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    approvalId: APPROVAL_ID,
    proposalId: PROPOSAL_ID,
    proposalDigest: "7".repeat(64),
    principalId: "operator-a",
    decision,
    grantedScope: [EXCALIBUR_DRAFT_PR_ACTION_ID],
    singleUse: true,
    confirmationNonce: CONFIRMATION_NONCE,
    ...(decision === "approved" ? { decidedAt: "2099-07-13T12:01:00.000Z" } : {}),
    expiresAt: EXPIRES,
  };
}

function draftReceipt(): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    receiptId: RECEIPT_ID,
    commandId: COMMAND_ID,
    proposalId: PROPOSAL_ID,
    approvalId: APPROVAL_ID,
    conversationId: SESSION_ID,
    instanceId: "operator",
    actionId: EXCALIBUR_DRAFT_PR_ACTION_ID,
    executorId: EXCALIBUR_DRAFT_PR_EXECUTOR_ID,
    outcome: "succeeded",
    idempotencyKey: "ik_draft_pr_runtime_test",
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
    },
    occurredAt: "2099-07-13T12:02:00.000Z",
  };
}

function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((item) => (
    `id: ${item.sequence}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
  )).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("CLI uses the shared scoped conversation and replays SSE from the last cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalibur-sidecar-runtime-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(root, "state") };
  const requests: Array<{ url: URL; init: RequestInit; headers: Headers }> = [];
  let eventAttempt = 0;
  let createCount = 0;
  let sharedCursor = 0;

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    requests.push({ url, init, headers });
    assert.equal(headers.get("authorization"), "Bearer synthetic-sidecar-token");
    assert.equal(headers.get("x-excalibur-surface"), "cli");
    assert.equal(headers.get("x-excalibur-scope"), "operator");
    assert.equal(headers.has("x-instance-id"), false);
    assert.equal(headers.has("x-excalibur-cloud-authorization"), false);
    if (url.pathname.endsWith("/control/session")) return json(controlSession());
    if (url.pathname.endsWith("/conversations") && init.method === "POST") {
      createCount += 1;
      assert.deepEqual(JSON.parse(String(init.body)), { scope: { kind: "operator" } });
      return json(conversation(sharedCursor), createCount === 1 ? 201 : 200);
    }
    if (url.pathname.endsWith("/control/snapshot")) return json(controlSnapshot());
    if (url.pathname.endsWith("/control/capabilities")) return json(capabilities());
    if (url.pathname.endsWith("/control/receipts")) return json({ receipts: [] });
    if (url.pathname.endsWith("/excalibur/memory")) return json(memoryPosture());
    if (url.pathname.endsWith(`/${SESSION_ID}/turns`)) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["clientTurnId", "content"]);
      assert.equal(body.content, "show the shared pulse");
      assert.match(String(body.clientTurnId), /^[0-9a-f-]{36}$/);
      return json({ runId: RUN_ID, acceptedAt: NOW }, 202);
    }
    if (url.pathname.endsWith(`/${SESSION_ID}/events`)) {
      eventAttempt += 1;
      if (eventAttempt === 1) {
        assert.equal(url.searchParams.get("cursor"), "0");
        assert.equal(headers.get("last-event-id"), "0");
        sharedCursor = 2;
        return sse(
          event(1, "turn.accepted", { acceptedAt: NOW }),
          event(2, "assistant.delta", { text: "shared " }),
        );
      }
      assert.equal(url.searchParams.get("cursor"), "2");
      assert.equal(headers.get("last-event-id"), "2");
      sharedCursor = 3;
      // Duplicate 2 proves idempotent replay handling; 3 completes the turn.
      return sse(
        event(2, "assistant.delta", { text: "shared " }),
        event(3, "assistant.final", { text: "shared response" }),
      );
    }
    throw new Error(`unexpected synthetic request: ${url.pathname}`);
  };

  const transport = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "operator" },
    accessToken: "synthetic-sidecar-token",
    cloudAccessToken: async () => { throw new Error("operator requests must never resolve cloud auth"); },
    fetchFn,
  });
  const runtime = new ExcaliburSidecarRuntime({
    env,
    scope: operatorScope,
    contextId: "operator-local",
    transport,
    reconnectDelaysMs: [0, 0, 0],
    showThinking: false,
  });
  await runtime.connect();
  assert.equal(runtime.resumeKey(), SESSION_ID);
  assert.match(
    (await runtime.runControlCommand("orchestra", ["status", "mission-1"])).join("\n"),
    /Orchestra · unavailable/,
  );
  assert.match(
    (await runtime.runControlCommand("orchestra", ["advance", "mission-1", "d".repeat(64)])).join("\n"),
    /advance locked/,
  );
  const runId = await runtime.sendMessage("show the shared pulse");
  assert.equal(runId, RUN_ID);
  assert.equal(await runtime.waitForFinal(2_000, RUN_ID), "final");
  await runtime.close();

  const persisted = await loadExcaliburState({ scope: operatorScope, env });
  assert.equal(persisted.sessions[0]?.sessionId, SESSION_ID);
  assert.equal(persisted.sessions[0]?.nativeSessionId, SESSION_ID);
  assert.equal(persisted.sessions[0]?.provider, "excalibur-sidecar");
  assert.equal(persisted.sessions[0]?.status, "open");

  // A new terminal attachment receives the same sidecar-owned id as Desktop.
  const second = new ExcaliburSidecarRuntime({
    env,
    scope: operatorScope,
    contextId: "operator-local",
    transport,
    reconnectDelaysMs: [0],
  });
  await second.connect();
  assert.equal(second.resumeKey(), SESSION_ID);
  await second.close();
  assert.equal(createCount, 2);
  assert.equal(eventAttempt, 2);
  assert.ok(requests.length >= 7);
});

test("a broker-correlated tenant approval card remains active after assistant.final", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalibur-approval-card-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(root, "state") };
  let eventCalls = 0;
  let turnCalls = 0;
  let decisionBody: Record<string, unknown> | null = null;

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/control/session")) {
      return json(controlSession("tenant", "approval_bound"));
    }
    if (url.pathname.endsWith("/conversations") && init.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), { scope: { kind: "tenant", instanceId: "instance-1" } });
      return json(conversation(0, "tenant"), 201);
    }
    if (url.pathname.endsWith("/control/snapshot")) return json(controlSnapshot("tenant"));
    if (url.pathname.endsWith("/control/capabilities")) return json(capabilities());
    if (url.pathname.endsWith("/control/receipts")) return json({ receipts: [] });
    if (url.pathname.endsWith("/excalibur/memory")) return json(memoryPosture("tenant"));
    if (url.pathname.endsWith(`/${SESSION_ID}/turns`)) {
      turnCalls += 1;
      return json({ runId: RUN_ID, acceptedAt: NOW }, 202);
    }
    if (url.pathname.endsWith(`/${SESSION_ID}/events`)) {
      eventCalls += 1;
      if (eventCalls === 1) {
        return sse(
          event(1, "proposal.created", { trust: "validated_cloud_broker", proposal: proposal() }, COMMAND_ID),
          event(2, "approval.updated", { approval: approval() }, COMMAND_ID),
          event(3, "assistant.final", { text: "The exact server card is ready." }),
        );
      }
      const signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          if (signal.aborted) controller.close();
          else signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith(`/control/approvals/${APPROVAL_ID}/decide`)) {
      decisionBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json(approval("approved"));
    }
    throw new Error(`unexpected synthetic request: ${url.pathname}`);
  };

  const transport = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "tenant", instanceId: "instance-1" },
    accessToken: "synthetic-sidecar-token",
    cloudAccessToken: "synthetic-firebase-token",
    fetchFn,
  });
  const runtime = new ExcaliburSidecarRuntime({
    env,
    scope: operatorScope,
    contextId: "instance-1",
    transport,
    reconnectDelaysMs: [0, 0],
  });
  await runtime.connect();
  const runId = await runtime.sendMessage("prepare the field-only report");
  assert.equal(await runtime.waitForFinal(2_000, runId || undefined), "final");
  assert.equal(runtime.isInFlight(), false);
  assert.equal(runtime.hasPendingApproval(), true);
  assert.equal(runtime.canHandleApprovalKey("a"), true);

  assert.equal(await runtime.sendMessage("approve"), null, "typed prose must not hit the turn endpoint");
  assert.equal(turnCalls, 1);
  assert.equal(await runtime.handleApprovalKey("a"), true);
  assert.deepEqual(decisionBody, { decision: "approved", proposalDigest: "5".repeat(64) });
  assert.equal(runtime.hasPendingApproval(), false);
  await runtime.close();
});

test("operator-local draft publication carries the hidden nonce through the broker wrapper and exact receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalibur-operator-draft-pr-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(root, "state") };
  let eventCalls = 0;
  let decisionBody: Record<string, unknown> | null = null;

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/control/session")) {
      return json(controlSession("operator", "approval_bound"));
    }
    if (url.pathname.endsWith("/conversations") && init.method === "POST") {
      return json(conversation(0, "operator"), 201);
    }
    if (url.pathname.endsWith("/control/snapshot")) return json(controlSnapshot("operator"));
    if (url.pathname.endsWith("/control/capabilities")) return json(capabilities());
    if (url.pathname.endsWith("/control/receipts")) return json({ receipts: [] });
    if (url.pathname.endsWith("/excalibur/memory")) return json(memoryPosture("operator"));
    if (url.pathname.endsWith(`/${SESSION_ID}/turns`)) {
      return json({ runId: RUN_ID, acceptedAt: NOW }, 202);
    }
    if (url.pathname.endsWith(`/${SESSION_ID}/events`)) {
      eventCalls += 1;
      if (eventCalls === 1) {
        return sse(
          event(1, "proposal.created", {
            trust: "validated_operator_broker",
            proposal: draftProposal(),
          }, COMMAND_ID),
          event(2, "approval.updated", { approval: draftApproval() }, COMMAND_ID),
          event(3, "assistant.final", { text: "The exact draft-only card is ready." }),
        );
      }
      const signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          if (signal.aborted) controller.close();
          else signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith(`/control/approvals/${APPROVAL_ID}/decide`)) {
      decisionBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({
        approval: draftApproval("approved"),
        proposal: draftProposal(),
        receipt: draftReceipt(),
        executionUnconfirmed: false,
        replayed: false,
      });
    }
    throw new Error(`unexpected synthetic request: ${url.pathname}`);
  };

  const transport = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "operator" },
    accessToken: "synthetic-sidecar-token",
    fetchFn,
  });
  const runtime = new ExcaliburSidecarRuntime({
    env,
    scope: operatorScope,
    contextId: "operator-local",
    transport,
    reconnectDelaysMs: [0, 0],
  });

  await runtime.connect();
  const runId = await runtime.sendMessage("publish the exact approved head as a draft PR");
  assert.equal(await runtime.waitForFinal(2_000, runId || undefined), "final");
  assert.equal(runtime.hasPendingApproval(), true);
  assert.equal(await runtime.handleApprovalKey("a"), true);
  assert.deepEqual(decisionBody, {
    decision: "approved",
    proposalDigest: "7".repeat(64),
    confirmationNonce: CONFIRMATION_NONCE,
  });
  assert.equal(runtime.hasPendingApproval(), false);
  await runtime.close();
});

test("control sessions fail closed when any canonical contract digest drifts", async () => {
  const drifted = controlSession();
  drifted.digests = { ...EXCALIBUR_EXPECTED_DIGESTS, routing: "0".repeat(64) };
  const transport = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "operator" },
    accessToken: "synthetic-sidecar-token",
    fetchFn: async () => json(drifted),
  });
  await assert.rejects(
    transport.getControlSession(),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as { code: string }).code === "CONTRACT_DIGEST_MISMATCH",
  );
});

test("tenant sidecar loss degrades to authenticated cloud reads and performs no cloud chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "excalibur-sidecar-loss-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(root, "state") };
  const scope: StateScope = {
    principalId: "principal-a",
    principalHash: "principal-a",
    instanceId: "instance-1",
    authenticated: true,
  };
  let sidecarCalls = 0;
  let cloudCalls = 0;
  const sidecar = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "tenant", instanceId: "instance-1" },
    accessToken: "synthetic-sidecar-token",
    cloudAccessToken: "synthetic-firebase-token",
    fetchFn: async (_input, init = {}) => {
      sidecarCalls += 1;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-instance-id"), "instance-1");
      assert.equal(headers.has("x-excalibur-scope"), false);
      assert.equal(headers.get("x-excalibur-surface"), "cli");
      assert.equal(headers.get("x-excalibur-cloud-authorization"), "Bearer synthetic-firebase-token");
      return json({ code: "tenant-control-session-unavailable" }, 503);
    },
  });
  const cloud = new ExcaliburHttpTransport({
    baseUrl: "https://control.example.test",
    posture: "cloud_read_only",
    scope: { kind: "tenant", instanceId: "instance-1" },
    accessToken: "synthetic-firebase-token",
    fetchFn: async (_input, init = {}) => {
      cloudCalls += 1;
      const headers = new Headers(init.headers);
      assert.equal(init.method, "GET");
      assert.equal(headers.get("x-instance-id"), "instance-1");
      assert.equal(headers.has("x-excalibur-scope"), false);
      assert.equal(headers.get("authorization"), "Bearer synthetic-firebase-token");
      return json(controlSession("tenant"));
    },
  });

  await assert.rejects(
    runExcaliburConversation({
      env,
      scope,
      contextId: "instance-1",
      message: "mutate this customer",
      sidecarTransport: sidecar,
      cloudReadTransport: cloud,
      firebaseToken: "synthetic-firebase-token",
      entitlementResolver: async () => [],
    }),
    ExcaliburEffectsLockedError,
  );
  assert.equal(sidecarCalls, 1);
  assert.equal(cloudCalls, 1, "fallback may authenticate one read session but must not submit a turn");

  await assert.rejects(
    cloud.submitTurn(SESSION_ID, { content: "chat", clientTurnId: RUN_ID }),
    ExcaliburEffectsLockedError,
  );
  await assert.rejects(cloud.createProposal({}), ExcaliburEffectsLockedError);
  assert.equal(cloudCalls, 1, "locked mutation methods reject before fetch");
  const persisted = JSON.stringify(await loadExcaliburState({ scope, env }));
  assert.equal(persisted.includes("synthetic-firebase-token"), false);
  assert.equal(persisted.includes("synthetic-sidecar-token"), false);
});

test("legacy direct ACP session records cannot bypass the shared sidecar", async () => {
  await assert.rejects(
    runExcaliburConversation({
      scope: operatorScope,
      contextId: "operator-local",
      message: "hello",
      resume: {
        sessionId: "legacy-session",
        provider: "grok-acp",
        nativeSessionId: "legacy-native-session",
        model: "grok-4.5",
        contextId: "operator-local",
        startedAt: NOW,
        updatedAt: NOW,
        status: "closed",
      },
    }),
    /direct Grok ACP sessions are disabled/,
  );
});

test("sidecar endpoints are exact numeric loopback origins", () => {
  assert.throws(() => new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.10:4178",
    posture: "sidecar",
    scope: { kind: "operator" },
    accessToken: "synthetic-sidecar-token",
  }), /numeric loopback/);
  assert.throws(() => new ExcaliburHttpTransport({
    baseUrl: "https://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "operator" },
    accessToken: "synthetic-sidecar-token",
  }), /numeric loopback/);
});
