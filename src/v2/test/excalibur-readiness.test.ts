import assert from "node:assert/strict";
import { test } from "node:test";

import { EXCALIBUR_EXPECTED_DIGESTS } from "../excalibur/contract-baseline.js";
import {
  EXCALIBUR_SCHEMA_VERSION,
  type ExcaliburControlSession,
  type ExcaliburControlSnapshot,
  type ExcaliburConversationSession,
  type ExcaliburMemoryPosture,
} from "../excalibur/http-transport.js";
import {
  renderOneSurfaceStartupBrief,
  summarizeOneSurfaceReadiness,
} from "../excalibur/readiness.js";

const NOW = "2026-07-14T12:00:00.000Z";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";

const controlSession: ExcaliburControlSession = {
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

const conversation: ExcaliburConversationSession = {
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

function snapshot(): ExcaliburControlSnapshot {
  const observation = (
    capabilityId: string,
    facts: Record<string, unknown>,
    freshness: "fresh" | "stale" | "unavailable" = "fresh",
  ) => ({
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
    redactionLevel: "aggregate_only" as const,
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

  assert.match(text, /One-Surface startup · contract verified/);
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

test("loaded sidecar memory posture overrides a pre-load snapshot without exposing content", () => {
  const memoryStatus: ExcaliburMemoryPosture = {
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

test("missing served-model evidence is surfaced as a deterministic blocker", () => {
  const value = snapshot();
  const drive = value.observations.find((item) => item.capabilityId === "drive.status")!;
  drive.facts.servedModel = null;
  drive.facts.conversationId = null;
  drive.facts.conversationState = "unavailable";
  const readiness = summarizeOneSurfaceReadiness({ controlSession, snapshot: value });
  assert.equal(readiness.servedModel, null);
  assert.deepEqual(
    readiness.blockers.filter((item) => ["served_model_attestation_required", "shared_conversation_unavailable"].includes(item)),
    ["served_model_attestation_required", "shared_conversation_unavailable"],
  );
});
