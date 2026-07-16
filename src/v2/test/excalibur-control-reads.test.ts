import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXCALIBUR_CONTRACT_BASELINE,
  EXCALIBUR_EXPECTED_DIGESTS,
} from "../excalibur/contract-baseline.js";
import { renderCapabilities, renderReceiptPage, renderSnapshot } from "../excalibur/control-render.js";
import {
  ExcaliburEffectsLockedError,
  ExcaliburHttpTransport,
  EXCALIBUR_SCHEMA_VERSION,
  expectedExcaliburExecutorId,
} from "../excalibur/http-transport.js";

const NOW = "2026-07-14T12:00:00.000Z";
const CONTROL_ID = "10000000-0000-4000-8000-000000000001";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function readCapability(capabilityId: string): Record<string, unknown> {
  return {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    capabilityId,
    title: capabilityId,
    kind: "read",
    mode: "observe",
    outputSchemaId: "Excalibur.Observation.v1",
    risk: "none",
    requiredScopes: [`${capabilityId}:read`],
    dataClasses: capabilityId === "finance" ? ["financial"] : ["aggregate", "opaque_identifier"],
    approvalPolicy: { kind: "none" },
    executor: { kind: "none" },
    availability: capabilityId === "finance"
      ? { status: "unavailable", blockingGates: ["v1_finance_locked"] }
      : { status: "available", blockingGates: [] },
  };
}

function actionCapability(capabilityId: string): Record<string, unknown> {
  return {
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
  };
}

test("sidecar memory endpoint validates a content-free, scope-bound adapter posture", async () => {
  let requestedPath = "";
  const transport = new ExcaliburHttpTransport({
    baseUrl: "http://127.0.0.1:4178",
    posture: "sidecar",
    scope: { kind: "tenant", instanceId: "instance-1" },
    accessToken: "synthetic-loopback-token",
    fetchFn: async (input, init = {}) => {
      const url = new URL(String(input));
      requestedPath = url.pathname;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-instance-id"), "instance-1");
      assert.equal(headers.get("x-excalibur-scope"), null);
      return json({
        schemaVersion: "excalibur.memory-posture.v1",
        scopeKind: "tenant",
        memoryPosture: {
          mode: "shadow",
          adapter: "memory_tap",
          instanceId: "instance-1",
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
          scopeKind: "tenant",
          adapter: "memory_tap",
          mode: "shadow",
          state: "available",
          sources: ["memory"],
          promotedCount: 2,
          operatorFallback: false,
          nativeModelMemory: false,
          receiptsIncluded: false,
          observedDigest: "a".repeat(64),
          reason: null,
          contentIncluded: false,
        },
        contentIncluded: false,
      });
    },
  });
  const posture = await transport.getMemoryStatus();
  assert.equal(requestedPath, "/api/v1/excalibur/memory");
  assert.equal(posture.adapterStatus.state, "available");
  assert.equal(posture.contentIncluded, false);
  assert.equal(Object.hasOwn(posture.adapterStatus, "entries"), false);
});

test("validated control reads provide real snapshot, capabilities, and receipts in cloud-read-only posture", async () => {
  const paths: string[] = [];
  const capabilities = [
    ...EXCALIBUR_CONTRACT_BASELINE.viewCapabilityIds.map(readCapability),
    ...EXCALIBUR_CONTRACT_BASELINE.actionCapabilityIds.map(actionCapability),
  ];
  const observation = {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    observationId: "memory.status:instance-1",
    capabilityId: "memory.status",
    instanceId: "instance-1",
    facts: { mode: "shadow", crossTenantFallback: false },
    authoritativeSource: "excalibur.sidecar.memory-projection",
    sourceVersion: "v1",
    observedDigest: "1".repeat(64),
    observedAt: NOW,
    freshness: { state: "fresh", maxAgeSeconds: 300 },
    evidenceRefs: [],
    redactionLevel: "aggregate_only",
  };
  const receipt = {
    schemaVersion: EXCALIBUR_SCHEMA_VERSION,
    receiptId: "20000000-0000-4000-8000-000000000002",
    commandId: "30000000-0000-4000-8000-000000000003",
    proposalId: "40000000-0000-4000-8000-000000000004",
    approvalId: "50000000-0000-4000-8000-000000000005",
    conversationId: "60000000-0000-4000-8000-000000000006",
    instanceId: "instance-1",
    actionId: "sales.whitespace.generate",
    executorId: "bench.whitespace.field-only.v1",
    outcome: "succeeded",
    idempotencyKey: "whitespace-command-1",
    inputDigest: "2".repeat(64),
    evidenceRefs: ["whitespace-run:opaque-1"],
    result: { runId: "ws-opaque-1", rowCount: 42, outputDigest: "3".repeat(64) },
    occurredAt: NOW,
  };

  const transport = new ExcaliburHttpTransport({
    baseUrl: "https://control.example.test",
    posture: "cloud_read_only",
    scope: { kind: "tenant", instanceId: "instance-1" },
    accessToken: "synthetic-firebase-token",
    fetchFn: async (input, init = {}) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("x-instance-id"), "instance-1");
      if (url.pathname.endsWith("/control/session")) return json({
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        sessionId: CONTROL_ID,
        principal: { principalId: "principal-a", kind: "human" },
        scopes: ["excalibur:read"],
        rank: "admin",
        surface: "cli",
        effectsPosture: "read_only",
        digests: { ...EXCALIBUR_EXPECTED_DIGESTS },
        issuedAt: NOW,
        tokenExpiresAt: "2026-07-14T12:05:00.000Z",
        contextKind: "tenant",
        activeInstance: { instanceId: "instance-1", roles: ["admin"] },
        authMethod: "firebase_human",
      });
      if (url.pathname.endsWith("/control/capabilities")) return json(capabilities);
      if (url.pathname.endsWith("/control/snapshot")) return json({
        schemaVersion: EXCALIBUR_SCHEMA_VERSION,
        instanceId: "instance-1",
        manifestDigest: EXCALIBUR_EXPECTED_DIGESTS.manifest,
        observedAt: NOW,
        observations: [observation],
      });
      if (url.pathname.endsWith("/control/receipts")) return json({ receipts: [receipt] });
      throw new Error(`unexpected read path ${url.pathname}`);
    },
  });

  await transport.getControlSession();
  const readCapabilities = await transport.getCapabilities();
  const snapshot = await transport.getSnapshot();
  const receipts = await transport.getReceipts({ limit: 50 });
  assert.match(renderCapabilities(readCapabilities, "action").join("\n"), /exact_human_approval/);
  assert.match(renderSnapshot(snapshot, "memory.status").join("\n"), /crossTenantFallback: false/);
  assert.match(renderReceiptPage(receipts).join("\n"), /rows: 42/);
  await assert.rejects(
    transport.decideApproval("50000000-0000-4000-8000-000000000005", {
      decision: "approved",
      proposalDigest: "4".repeat(64),
    }),
    ExcaliburEffectsLockedError,
  );
  assert.equal(paths.length, 4, "cloud-read-only effects reject before fetch");
});
