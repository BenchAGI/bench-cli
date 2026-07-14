import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  EXCALIBUR_CONTRACT_BASELINE,
  EXCALIBUR_EXPECTED_DIGESTS,
} from "./contract-baseline.js";

export const EXCALIBUR_PROTOCOL_VERSION = EXCALIBUR_CONTRACT_BASELINE.protocolVersion;
export const EXCALIBUR_SCHEMA_VERSION = EXCALIBUR_CONTRACT_BASELINE.schemaVersion;

export const EXCALIBUR_CONTROL_PATHS = Object.freeze({
  session: "/api/v1/excalibur/control/session",
  capabilities: "/api/v1/excalibur/control/capabilities",
  snapshot: "/api/v1/excalibur/control/snapshot",
  observations: "/api/v1/excalibur/control/observations",
  receipts: "/api/v1/excalibur/control/receipts",
  proposals: "/api/v1/excalibur/control/proposals",
  approvals: "/api/v1/excalibur/control/approvals",
  conversations: "/api/v1/excalibur/conversations",
  memory: "/api/v1/excalibur/memory",
});

export type ExcaliburConversationScope =
  | { kind: "operator" }
  | { kind: "tenant"; instanceId: string };

export type ExcaliburControlSession = {
  schemaVersion: string;
  sessionId: string;
  principal: { principalId: string; kind: "human"; displayName?: string };
  scopes: string[];
  rank: "member" | "operator" | "admin" | "owner";
  contextKind: "operator" | "tenant";
  activeInstance: null | { instanceId: string; roles: string[] };
  surface: "cli";
  effectsPosture: "locked" | "read_only" | "approval_bound";
  authMethod: string;
  digests: { protocol: string; manifest: string; routing: string };
  issuedAt: string;
  tokenExpiresAt: string;
};

export type ExcaliburCapability = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  capabilityId: string;
  title: string;
  kind: "read" | "action";
  mode: "observe" | "propose_approve_execute";
  inputSchemaId?: string;
  outputSchemaId: string;
  risk: "none" | "low" | "medium" | "high" | "critical";
  requiredScopes: string[];
  dataClasses: Array<"aggregate" | "opaque_identifier" | "promoted_excerpt" | "customer_raw" | "financial">;
  approvalPolicy: { kind: "none" } | {
    kind: "single_human_exact_digest";
    expiresInSeconds: number;
    typedProseAccepted: false;
    singleUse: true;
  };
  executor: { kind: "none" } | { kind: "deterministic"; executorId: string };
  availability: { status: "available" | "locked" | "unavailable"; blockingGates: string[] };
};

export type ExcaliburObservation = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  observationId: string;
  capabilityId: string;
  instanceId: string;
  facts: Record<string, unknown>;
  authoritativeSource: string;
  sourceVersion: string;
  observedDigest: string;
  observedAt: string;
  freshness: { state: "fresh" | "stale" | "unavailable"; maxAgeSeconds: number };
  evidenceRefs: string[];
  redactionLevel: "aggregate_only" | "opaque_refs" | "promoted_excerpt";
  permittedNextProposal?: string;
};

export type ExcaliburControlSnapshot = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  instanceId: string;
  manifestDigest: string;
  observedAt: string;
  observations: ExcaliburObservation[];
};

export type ExcaliburMemoryPosture = {
  schemaVersion: "excalibur.memory-posture.v1";
  scopeKind: "operator" | "tenant";
  memoryPosture: {
    mode: "personal_durable" | "shadow";
    adapter: "aurelius_local" | "memory_tap";
    instanceId: string | null;
    sources: string[];
    sessionsConsented: false;
    dreamsConsented: false;
    operatorFallback: false;
    nativeModelMemory: false;
    receiptsIncluded: false;
    scratchRetentionSeconds: number;
  };
  adapterStatus: {
    schemaVersion: "excalibur.memory-context.v1";
    scopeKind: "operator" | "tenant";
    adapter: "aurelius_local" | "memory_tap";
    mode: "personal_durable" | "shadow";
    state: "available" | "locked" | "unavailable";
    sources: string[];
    promotedCount: number;
    operatorFallback: false;
    nativeModelMemory: false;
    receiptsIncluded: false;
    observedDigest: string;
    reason?: string | null;
    contentIncluded: false;
  };
  contentIncluded: false;
};

export type ExcaliburProposal = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  proposalId: string;
  commandId: string;
  conversationId: string;
  instanceId: string;
  actionId: "sales.whitespace.generate";
  target: { resourceType: "sales_whitespace_report" };
  payload: {
    mode: "field-only";
    maximumDeals: number;
    thresholdProfileDigest: string;
    stageSetDigest: string;
    destinationDigest: string;
    retentionDays: number;
  };
  payloadDigest: string;
  proposalDigest: string;
  resourceFingerprints: Record<string, string>;
  policyResult: { decision: "allow" | "deny"; policyDigest: string; reasons: string[] };
  idempotencyKey: string;
  approvalId: string;
  createdAt: string;
  expiresAt: string;
};

export type ExcaliburApproval = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  approvalId: string;
  proposalId: string;
  proposalDigest: string;
  principalId: string;
  decision: "pending" | "approved" | "denied" | "expired";
  grantedScope: string[];
  singleUse: true;
  decidedAt?: string;
  expiresAt: string;
};

export type ExcaliburExecutionReceipt = {
  schemaVersion: typeof EXCALIBUR_SCHEMA_VERSION;
  receiptId: string;
  commandId: string;
  proposalId: string;
  approvalId: string;
  conversationId: string;
  instanceId: string;
  actionId: "sales.whitespace.generate";
  executorId: string;
  outcome: "accepted" | "running" | "succeeded" | "failed" | "expired" | "reconciled";
  idempotencyKey: string;
  inputDigest: string;
  evidenceRefs: string[];
  result: { runId?: string; rowCount?: number; outputDigest?: string; errorCode?: string };
  occurredAt: string;
};

export type ExcaliburReceiptPage = { receipts: ExcaliburExecutionReceipt[]; nextCursor?: string };
export type ExcaliburApprovalDecisionInput = {
  decision: "approved" | "denied";
  proposalDigest: string;
};

export type ExcaliburConversationSession = {
  schemaVersion: string;
  sessionId: string;
  scope: ExcaliburConversationScope;
  providerSession: {
    provider: "xai";
    requestedModel: "grok-4.5";
    servedModel: "grok-4.5";
    providerSessionId: string;
    attestationDigest: string;
    attestedAt: string;
  };
  eventCursor: number;
  state: "active" | "aborted" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type ExcaliburConversationEvent = {
  protocolVersion: string;
  sessionId: string;
  sequence: number;
  runId: string;
  timestamp: string;
  type:
    | "turn.accepted"
    | "assistant.delta"
    | "assistant.final"
    | "proposal.created"
    | "approval.updated"
    | "execution.receipt"
    | "usage.recorded"
    | "conversation.closed"
    | "error";
  payload: Record<string, unknown>;
};

export type ExcaliburTurnAcceptance = { runId: string; acceptedAt: string };
export type ExcaliburConversationMutationReceipt = {
  sessionId: string;
  state: "aborted" | "closed";
  occurredAt: string;
};

export type ExcaliburTransportPosture = "sidecar" | "cloud_read_only";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ExcaliburTokenProvider = string | (() => Promise<string | undefined>);

export type ExcaliburHttpTransportOptions = {
  baseUrl: string;
  posture: ExcaliburTransportPosture;
  scope: ExcaliburConversationScope;
  accessToken: ExcaliburTokenProvider;
  /** Fresh human token forwarded only to a tenant loopback sidecar request. */
  cloudAccessToken?: ExcaliburTokenProvider;
  fetchFn?: FetchLike;
  timeoutMs?: number;
};

export type SidecarConnection = { baseUrl: string; token: string; tokenSource: "environment" | "file" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const EVENT_TYPES = new Set<ExcaliburConversationEvent["type"]>([
  "turn.accepted",
  "assistant.delta",
  "assistant.final",
  "proposal.created",
  "approval.updated",
  "execution.receipt",
  "usage.recorded",
  "conversation.closed",
  "error",
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export class ExcaliburTransportError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ExcaliburTransportError";
    this.exitCode = code === "EFFECTS_LOCKED" ? 13 : 6;
  }
}

export class ExcaliburEffectsLockedError extends ExcaliburTransportError {
  constructor(operation: string) {
    super(
      "EFFECTS_LOCKED",
      `${operation} is locked while Excalibur is in authenticated cloud read-only mode`,
    );
    this.name = "ExcaliburEffectsLockedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function uniqueIdentifiers(value: unknown, minimum = 0): value is string[] {
  return Array.isArray(value) && value.length >= minimum
    && value.every(isIdentifier) && new Set(value).size === value.length;
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  return exactKeys(value, [
    ...required,
    ...optional.filter((key) => Object.hasOwn(value, key)),
  ]);
}

function normalizeScope(scope: ExcaliburConversationScope): ExcaliburConversationScope {
  if (scope.kind === "operator") {
    if (Object.keys(scope).some((key) => key !== "kind")) {
      throw new ExcaliburTransportError("BAD_SCOPE", "operator scope must not contain tenant identity");
    }
    return Object.freeze({ kind: "operator" });
  }
  const instanceId = String(scope.instanceId || "").trim();
  if (!INSTANCE_RE.test(instanceId)) {
    throw new ExcaliburTransportError("BAD_SCOPE", "tenant scope requires one explicit valid instance id");
  }
  return Object.freeze({ kind: "tenant", instanceId });
}

function scopeMatches(actual: ExcaliburConversationScope, expected: ExcaliburConversationScope): boolean {
  return actual.kind === expected.kind
    && (actual.kind === "operator"
      || (expected.kind === "tenant" && actual.instanceId === expected.instanceId));
}

function parseScope(value: unknown): ExcaliburConversationScope {
  if (!isRecord(value)) throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar returned an invalid conversation scope");
  if (value.kind === "operator" && Object.keys(value).every((key) => key === "kind")) return { kind: "operator" };
  if (value.kind === "tenant" && typeof value.instanceId === "string" && INSTANCE_RE.test(value.instanceId)) {
    return { kind: "tenant", instanceId: value.instanceId };
  }
  throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar returned an invalid conversation scope");
}

function parseControlSession(value: unknown, expected: ExcaliburConversationScope): ExcaliburControlSession {
  if (!isRecord(value)
      || !exactKeys(value, [
        "schemaVersion", "sessionId", "principal", "scopes", "rank", "surface",
        "effectsPosture", "digests", "issuedAt", "tokenExpiresAt", "contextKind",
        "activeInstance", "authMethod",
      ])
      || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !UUID_RE.test(String(value.sessionId || ""))
      || !isRecord(value.principal)
      || !["principalId", "kind", "displayName"].every((key) => (
        key === "displayName" || Object.hasOwn(value.principal as object, key)
      ))
      || typeof value.principal.principalId !== "string" || !value.principal.principalId.trim()
      || value.principal.kind !== "human"
      || (value.principal.displayName !== undefined && typeof value.principal.displayName !== "string")
      || Object.keys(value.principal).some((key) => !["principalId", "kind", "displayName"].includes(key))
      || !Array.isArray(value.scopes) || value.scopes.some((item) => typeof item !== "string" || !item)
      || !["member", "operator", "admin", "owner"].includes(String(value.rank || ""))
      || value.surface !== "cli"
      || !["locked", "read_only", "approval_bound"].includes(String(value.effectsPosture || ""))
      || !isRecord(value.digests) || !exactKeys(value.digests, ["protocol", "manifest", "routing"])
      || !DIGEST_RE.test(String(value.digests.protocol || ""))
      || !DIGEST_RE.test(String(value.digests.manifest || ""))
      || !DIGEST_RE.test(String(value.digests.routing || ""))
      || !isTimestamp(value.issuedAt) || !isTimestamp(value.tokenExpiresAt)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "Excalibur control session failed contract validation");
  }
  if (expected.kind === "operator") {
    if (value.contextKind !== "operator" || value.activeInstance !== null || value.authMethod !== "loopback_session") {
      throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "sidecar control session is not operator-bound");
    }
  } else {
    if (value.contextKind !== "tenant" || !isRecord(value.activeInstance)
        || !exactKeys(value.activeInstance, ["instanceId", "roles"])
        || value.activeInstance.instanceId !== expected.instanceId
        || !Array.isArray(value.activeInstance.roles) || value.activeInstance.roles.length < 1
        || value.activeInstance.roles.some((item) => typeof item !== "string" || !item)
        || !["firebase_human", "loopback_session"].includes(String(value.authMethod || ""))) {
      throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "control session belongs to another tenant");
    }
  }
  for (const name of ["protocol", "manifest", "routing"] as const) {
    if (value.digests[name] !== EXCALIBUR_EXPECTED_DIGESTS[name]) {
      throw new ExcaliburTransportError(
        "CONTRACT_DIGEST_MISMATCH",
        `control session ${name} digest does not match the checked-in Excalibur contract baseline`,
      );
    }
  }
  return value as ExcaliburControlSession;
}

function parseCapability(value: unknown): ExcaliburCapability {
  if (!isRecord(value)
      || !exactOptionalKeys(value, [
        "schemaVersion", "capabilityId", "title", "kind", "mode", "outputSchemaId",
        "risk", "requiredScopes", "dataClasses", "approvalPolicy", "executor", "availability",
      ], ["inputSchemaId"])
      || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !isIdentifier(value.capabilityId)
      || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 120
      || !["read", "action"].includes(String(value.kind || ""))
      || !["observe", "propose_approve_execute"].includes(String(value.mode || ""))
      || (value.inputSchemaId !== undefined && !isIdentifier(value.inputSchemaId))
      || !isIdentifier(value.outputSchemaId)
      || !["none", "low", "medium", "high", "critical"].includes(String(value.risk || ""))
      || !uniqueIdentifiers(value.requiredScopes)
      || !Array.isArray(value.dataClasses)
      || new Set(value.dataClasses).size !== value.dataClasses.length
      || value.dataClasses.some((item) => ![
        "aggregate", "opaque_identifier", "promoted_excerpt", "customer_raw", "financial",
      ].includes(String(item || "")))
      || !isRecord(value.approvalPolicy)
      || !isRecord(value.executor)
      || !isRecord(value.availability)
      || !exactKeys(value.availability, ["status", "blockingGates"])
      || !["available", "locked", "unavailable"].includes(String(value.availability.status || ""))
      || !uniqueIdentifiers(value.availability.blockingGates)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "capability response failed contract validation");
  }
  if (value.approvalPolicy.kind === "none") {
    if (!exactKeys(value.approvalPolicy, ["kind"])) {
      throw new ExcaliburTransportError("BAD_CONTRACT", "capability approval policy is malformed");
    }
  } else if (value.approvalPolicy.kind === "single_human_exact_digest") {
    if (!exactKeys(value.approvalPolicy, ["kind", "expiresInSeconds", "typedProseAccepted", "singleUse"])
        || !Number.isSafeInteger(value.approvalPolicy.expiresInSeconds)
        || Number(value.approvalPolicy.expiresInSeconds) < 1
        || Number(value.approvalPolicy.expiresInSeconds) > 3600
        || value.approvalPolicy.typedProseAccepted !== false
        || value.approvalPolicy.singleUse !== true) {
      throw new ExcaliburTransportError("BAD_CONTRACT", "capability approval policy is malformed");
    }
  } else {
    throw new ExcaliburTransportError("BAD_CONTRACT", "capability approval policy is unknown");
  }
  if (value.executor.kind === "none") {
    if (!exactKeys(value.executor, ["kind"])) {
      throw new ExcaliburTransportError("BAD_CONTRACT", "capability executor is malformed");
    }
  } else if (value.executor.kind === "deterministic") {
    if (!exactKeys(value.executor, ["kind", "executorId"]) || !isIdentifier(value.executor.executorId)) {
      throw new ExcaliburTransportError("BAD_CONTRACT", "capability executor is malformed");
    }
  } else {
    throw new ExcaliburTransportError("BAD_CONTRACT", "capability executor is unknown");
  }
  if ((value.kind === "read" && (value.mode !== "observe" || value.approvalPolicy.kind !== "none" || value.executor.kind !== "none"))
      || (value.kind === "action" && (value.mode !== "propose_approve_execute"
        || value.approvalPolicy.kind !== "single_human_exact_digest" || value.executor.kind !== "deterministic"))) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "capability authority lanes are inconsistent");
  }
  return value as ExcaliburCapability;
}

export function parseExcaliburObservation(value: unknown): ExcaliburObservation {
  if (!isRecord(value)
      || !exactOptionalKeys(value, [
        "schemaVersion", "observationId", "capabilityId", "instanceId", "facts",
        "authoritativeSource", "sourceVersion", "observedDigest", "observedAt",
        "freshness", "evidenceRefs", "redactionLevel",
      ], ["permittedNextProposal"])
      || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !isIdentifier(value.observationId) || !isIdentifier(value.capabilityId)
      || !isIdentifier(value.instanceId) || !isRecord(value.facts)
      || !isIdentifier(value.authoritativeSource) || !isIdentifier(value.sourceVersion)
      || !DIGEST_RE.test(String(value.observedDigest || "")) || !isTimestamp(value.observedAt)
      || !isRecord(value.freshness) || !exactKeys(value.freshness, ["state", "maxAgeSeconds"])
      || !["fresh", "stale", "unavailable"].includes(String(value.freshness.state || ""))
      || !Number.isSafeInteger(value.freshness.maxAgeSeconds) || Number(value.freshness.maxAgeSeconds) < 0
      || !uniqueIdentifiers(value.evidenceRefs)
      || !["aggregate_only", "opaque_refs", "promoted_excerpt"].includes(String(value.redactionLevel || ""))
      || (value.permittedNextProposal !== undefined && !isIdentifier(value.permittedNextProposal))) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "observation response failed contract validation");
  }
  return value as ExcaliburObservation;
}

function parseControlSnapshot(
  value: unknown,
  expected: ExcaliburConversationScope,
): ExcaliburControlSnapshot {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "instanceId", "manifestDigest", "observedAt", "observations",
  ]) || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !isIdentifier(value.instanceId)
      || value.manifestDigest !== EXCALIBUR_EXPECTED_DIGESTS.manifest
      || !isTimestamp(value.observedAt) || !Array.isArray(value.observations)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "snapshot response failed contract validation");
  }
  if (expected.kind === "tenant" && value.instanceId !== expected.instanceId) {
    throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "snapshot belongs to another tenant");
  }
  const observations = value.observations.map(parseExcaliburObservation);
  if (expected.kind === "tenant" && observations.some((item) => item.instanceId !== expected.instanceId)) {
    throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "snapshot contains a cross-tenant observation");
  }
  const capabilityIds = observations.map((item) => item.capabilityId);
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "snapshot contains duplicate capability observations");
  }
  return { ...value, observations } as ExcaliburControlSnapshot;
}

function parseMemoryPosture(
  value: unknown,
  expected: ExcaliburConversationScope,
): ExcaliburMemoryPosture {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "scopeKind", "memoryPosture", "adapterStatus", "contentIncluded",
  ]) || value.schemaVersion !== "excalibur.memory-posture.v1"
      || value.scopeKind !== expected.kind || value.contentIncluded !== false
      || !isRecord(value.memoryPosture) || !isRecord(value.adapterStatus)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "memory posture response failed contract validation");
  }
  const posture = value.memoryPosture;
  if (!exactKeys(posture, [
    "mode", "adapter", "instanceId", "sources", "sessionsConsented", "dreamsConsented",
    "operatorFallback", "nativeModelMemory", "receiptsIncluded", "scratchRetentionSeconds",
  ]) || !uniqueIdentifiers(posture.sources)
      || posture.sessionsConsented !== false || posture.dreamsConsented !== false
      || posture.operatorFallback !== false || posture.nativeModelMemory !== false
      || posture.receiptsIncluded !== false || !Number.isSafeInteger(posture.scratchRetentionSeconds)
      || Number(posture.scratchRetentionSeconds) < 1) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "memory posture boundary is malformed");
  }
  const status = value.adapterStatus;
  if (!exactOptionalKeys(status, [
    "schemaVersion", "scopeKind", "adapter", "mode", "state", "sources", "promotedCount",
    "operatorFallback", "nativeModelMemory", "receiptsIncluded", "observedDigest", "contentIncluded",
  ], ["reason"]) || status.schemaVersion !== "excalibur.memory-context.v1"
      || status.scopeKind !== expected.kind || !uniqueIdentifiers(status.sources)
      || !Number.isSafeInteger(status.promotedCount) || Number(status.promotedCount) < 0
      || !["available", "locked", "unavailable"].includes(String(status.state || ""))
      || status.operatorFallback !== false || status.nativeModelMemory !== false
      || status.receiptsIncluded !== false || status.contentIncluded !== false
      || !DIGEST_RE.test(String(status.observedDigest || ""))
      || (status.reason !== undefined && status.reason !== null && !isIdentifier(status.reason))) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "memory adapter status is malformed");
  }
  const expectedAdapter = expected.kind === "operator" ? "aurelius_local" : "memory_tap";
  const expectedMode = expected.kind === "operator" ? "personal_durable" : "shadow";
  if (posture.adapter !== expectedAdapter || posture.mode !== expectedMode
      || status.adapter !== expectedAdapter || status.mode !== expectedMode
      || (expected.kind === "operator" ? posture.instanceId !== null : posture.instanceId !== expected.instanceId)) {
    throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "memory posture belongs to another scope");
  }
  return value as ExcaliburMemoryPosture;
}

function validWhitespacePayload(value: unknown): value is ExcaliburProposal["payload"] {
  return isRecord(value)
    && exactKeys(value, [
      "mode", "maximumDeals", "thresholdProfileDigest", "stageSetDigest",
      "destinationDigest", "retentionDays",
    ])
    && value.mode === "field-only"
    && Number.isSafeInteger(value.maximumDeals) && Number(value.maximumDeals) >= 1
    && Number(value.maximumDeals) <= 5000
    && DIGEST_RE.test(String(value.thresholdProfileDigest || ""))
    && DIGEST_RE.test(String(value.stageSetDigest || ""))
    && DIGEST_RE.test(String(value.destinationDigest || ""))
    && Number.isSafeInteger(value.retentionDays) && Number(value.retentionDays) >= 1
    && Number(value.retentionDays) <= 90;
}

export function parseExcaliburProposal(value: unknown): ExcaliburProposal {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "proposalId", "commandId", "conversationId", "instanceId",
    "actionId", "target", "payload", "payloadDigest", "proposalDigest",
    "resourceFingerprints", "policyResult", "idempotencyKey", "approvalId",
    "createdAt", "expiresAt",
  ]) || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !UUID_RE.test(String(value.proposalId || ""))
      || !UUID_RE.test(String(value.commandId || ""))
      || !UUID_RE.test(String(value.conversationId || ""))
      || !isIdentifier(value.instanceId)
      || value.actionId !== "sales.whitespace.generate"
      || !isRecord(value.target) || !exactKeys(value.target, ["resourceType"])
      || value.target.resourceType !== "sales_whitespace_report"
      || !validWhitespacePayload(value.payload)
      || !DIGEST_RE.test(String(value.payloadDigest || ""))
      || !DIGEST_RE.test(String(value.proposalDigest || ""))
      || !isRecord(value.resourceFingerprints)
      || Object.values(value.resourceFingerprints).some((digest) => !DIGEST_RE.test(String(digest || "")))
      || !isRecord(value.policyResult)
      || !exactKeys(value.policyResult, ["decision", "policyDigest", "reasons"])
      || !["allow", "deny"].includes(String(value.policyResult.decision || ""))
      || !DIGEST_RE.test(String(value.policyResult.policyDigest || ""))
      || !uniqueIdentifiers(value.policyResult.reasons)
      || !isIdentifier(value.idempotencyKey)
      || !UUID_RE.test(String(value.approvalId || ""))
      || !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "validated proposal failed contract validation");
  }
  return value as ExcaliburProposal;
}

export function parseExcaliburApproval(value: unknown): ExcaliburApproval {
  if (!isRecord(value) || !exactOptionalKeys(value, [
    "schemaVersion", "approvalId", "proposalId", "proposalDigest", "principalId",
    "decision", "grantedScope", "singleUse", "expiresAt",
  ], ["decidedAt"])
      || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !UUID_RE.test(String(value.approvalId || ""))
      || !UUID_RE.test(String(value.proposalId || ""))
      || !DIGEST_RE.test(String(value.proposalDigest || ""))
      || !isIdentifier(value.principalId)
      || !["pending", "approved", "denied", "expired"].includes(String(value.decision || ""))
      || !uniqueIdentifiers(value.grantedScope)
      || value.singleUse !== true
      || (value.decidedAt !== undefined && !isTimestamp(value.decidedAt))
      || !isTimestamp(value.expiresAt)
      || (value.decision === "pending" && value.decidedAt !== undefined)
      || (value.decision !== "pending" && value.decision !== "expired" && value.decidedAt === undefined)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "approval failed contract validation");
  }
  return value as ExcaliburApproval;
}

export function parseExcaliburExecutionReceipt(value: unknown): ExcaliburExecutionReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "receiptId", "commandId", "proposalId", "approvalId",
    "conversationId", "instanceId", "actionId", "executorId", "outcome",
    "idempotencyKey", "inputDigest", "evidenceRefs", "result", "occurredAt",
  ]) || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !UUID_RE.test(String(value.receiptId || ""))
      || !UUID_RE.test(String(value.commandId || ""))
      || !UUID_RE.test(String(value.proposalId || ""))
      || !UUID_RE.test(String(value.approvalId || ""))
      || !UUID_RE.test(String(value.conversationId || ""))
      || !isIdentifier(value.instanceId)
      || value.actionId !== "sales.whitespace.generate"
      || !isIdentifier(value.executorId)
      || !["accepted", "running", "succeeded", "failed", "expired", "reconciled"].includes(String(value.outcome || ""))
      || !isIdentifier(value.idempotencyKey)
      || !DIGEST_RE.test(String(value.inputDigest || ""))
      || !uniqueIdentifiers(value.evidenceRefs)
      || !isRecord(value.result)
      || !exactOptionalKeys(value.result, [], ["runId", "rowCount", "outputDigest", "errorCode"])
      || (value.result.runId !== undefined && !isIdentifier(value.result.runId))
      || (value.result.rowCount !== undefined && (!Number.isSafeInteger(value.result.rowCount)
        || Number(value.result.rowCount) < 0 || Number(value.result.rowCount) > 5000))
      || (value.result.outputDigest !== undefined && !DIGEST_RE.test(String(value.result.outputDigest || "")))
      || (value.result.errorCode !== undefined && !isIdentifier(value.result.errorCode))
      || !isTimestamp(value.occurredAt)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "execution receipt failed contract validation");
  }
  return value as ExcaliburExecutionReceipt;
}

function parseReceiptPage(value: unknown): ExcaliburReceiptPage {
  if (!isRecord(value) || !exactOptionalKeys(value, ["receipts"], ["nextCursor"])
      || !Array.isArray(value.receipts)
      || (value.nextCursor !== undefined && !isIdentifier(value.nextCursor))) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "receipt page failed contract validation");
  }
  return {
    receipts: value.receipts.map(parseExcaliburExecutionReceipt),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  };
}

function parseConversationSession(value: unknown, expected: ExcaliburConversationScope): ExcaliburConversationSession {
  if (!isRecord(value)
      || !exactKeys(value, ["schemaVersion", "sessionId", "scope", "providerSession", "eventCursor", "state", "createdAt", "updatedAt"])
      || value.schemaVersion !== EXCALIBUR_SCHEMA_VERSION
      || !UUID_RE.test(String(value.sessionId || ""))
      || !Number.isSafeInteger(value.eventCursor) || Number(value.eventCursor) < 0
      || !["active", "aborted", "closed"].includes(String(value.state || ""))
      || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
      || !isRecord(value.providerSession)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar returned an invalid conversation session");
  }
  const provider = value.providerSession;
  if (!exactKeys(provider, ["provider", "requestedModel", "servedModel", "providerSessionId", "attestationDigest", "attestedAt"])
      || provider.provider !== "xai"
      || provider.requestedModel !== "grok-4.5"
      || provider.servedModel !== "grok-4.5"
      || typeof provider.providerSessionId !== "string" || !provider.providerSessionId.trim()
      || !DIGEST_RE.test(String(provider.attestationDigest || ""))
      || !isTimestamp(provider.attestedAt)) {
    throw new ExcaliburTransportError(
      "SERVED_MODEL_ATTESTATION_REQUIRED",
      "sidecar conversation lacks exact Grok 4.5 served-model attestation",
    );
  }
  const scope = parseScope(value.scope);
  if (!scopeMatches(scope, expected)) {
    throw new ExcaliburTransportError("CONVERSATION_SCOPE_MISMATCH", "conversation belongs to another explicit scope");
  }
  return { ...value, scope } as ExcaliburConversationSession;
}

function parseTurnAcceptance(value: unknown): ExcaliburTurnAcceptance {
  if (!isRecord(value) || !exactKeys(value, ["runId", "acceptedAt"])
      || !UUID_RE.test(String(value.runId || "")) || !isTimestamp(value.acceptedAt)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar returned an invalid turn acceptance");
  }
  return { runId: String(value.runId), acceptedAt: String(value.acceptedAt) };
}

function parseMutationReceipt(value: unknown): ExcaliburConversationMutationReceipt {
  if (!isRecord(value) || !exactKeys(value, ["sessionId", "state", "occurredAt"])
      || !UUID_RE.test(String(value.sessionId || ""))
      || !["aborted", "closed"].includes(String(value.state || "")) || !isTimestamp(value.occurredAt)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar returned an invalid conversation mutation receipt");
  }
  return value as ExcaliburConversationMutationReceipt;
}

function parseConversationEvent(value: unknown): ExcaliburConversationEvent {
  if (!isRecord(value)
      || !exactKeys(value, ["protocolVersion", "sessionId", "sequence", "runId", "timestamp", "type", "payload"])
      || value.protocolVersion !== EXCALIBUR_PROTOCOL_VERSION
      || !UUID_RE.test(String(value.sessionId || ""))
      || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
      || !UUID_RE.test(String(value.runId || ""))
      || !isTimestamp(value.timestamp)
      || !EVENT_TYPES.has(value.type as ExcaliburConversationEvent["type"])
      || !isRecord(value.payload)) {
    throw new ExcaliburTransportError("BAD_CONTRACT", "sidecar emitted an invalid conversation event");
  }
  return value as ExcaliburConversationEvent;
}

function validateBaseUrl(raw: string, posture: ExcaliburTransportPosture): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ExcaliburTransportError("BAD_ENDPOINT", "Excalibur endpoint is malformed"); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ExcaliburTransportError("BAD_ENDPOINT", "Excalibur endpoint must be a bare origin without credentials");
  }
  if (posture === "sidecar") {
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new ExcaliburTransportError("NON_LOOPBACK_SIDECAR", "sidecar endpoint must be numeric loopback HTTP");
    }
  } else if (url.protocol !== "https:") {
    throw new ExcaliburTransportError("INSECURE_CLOUD_ENDPOINT", "cloud read endpoint must use HTTPS");
  }
  return url.origin;
}

function boundedToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length < 16 || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token)) return null;
  return token;
}

export async function resolveSidecarConnection(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SidecarConnection> {
  const port = String(env.EXCALIBUR_SIDECAR_PORT || env.ANVIL_APP_PORT || "4178");
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) {
    throw new ExcaliburTransportError("BAD_ENDPOINT", "Excalibur sidecar port is invalid");
  }
  const baseUrl = validateBaseUrl(
    env.EXCALIBUR_SIDECAR_URL || `http://127.0.0.1:${port}`,
    "sidecar",
  );
  const rawEnvironmentToken = env.EXCALIBUR_SIDECAR_TOKEN || env.ANVIL_APP_TOKEN;
  if (rawEnvironmentToken !== undefined) {
    const environmentToken = boundedToken(rawEnvironmentToken);
    if (!environmentToken) {
      throw new ExcaliburTransportError("BAD_SIDECAR_TOKEN", "configured sidecar token is malformed");
    }
    return { baseUrl, token: environmentToken, tokenSource: "environment" };
  }

  const home = env.HOME || homedir();
  const localRoot = env.ANVIL_ROOT || join(home, "aurelius-anvil", "local");
  const tokenFile = env.EXCALIBUR_SIDECAR_TOKEN_FILE || join(localRoot, "anvil-app-token");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tokenFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096
        || (currentUid !== null && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
      throw new ExcaliburTransportError("UNSAFE_SIDECAR_TOKEN", "sidecar token file is not a private owner-only regular file");
    }
    const token = boundedToken(await handle.readFile("utf8"));
    if (!token) throw new ExcaliburTransportError("BAD_SIDECAR_TOKEN", "sidecar token file is empty or malformed");
    return { baseUrl, token, tokenSource: "file" };
  } catch (error) {
    if (error instanceof ExcaliburTransportError) throw error;
    throw new ExcaliburTransportError(
      "SIDECAR_CREDENTIAL_UNAVAILABLE",
      "Excalibur sidecar credential is unavailable; start the desktop sidecar or configure its private token",
      null,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class ExcaliburHttpTransport {
  readonly posture: ExcaliburTransportPosture;
  readonly scope: ExcaliburConversationScope;
  readonly baseUrl: string;
  private readonly accessToken: ExcaliburTokenProvider;
  private readonly cloudAccessToken: ExcaliburTokenProvider | undefined;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ExcaliburHttpTransportOptions) {
    this.posture = options.posture;
    this.scope = normalizeScope(options.scope);
    this.baseUrl = validateBaseUrl(options.baseUrl, options.posture);
    this.accessToken = options.accessToken;
    this.cloudAccessToken = options.cloudAccessToken;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = Math.max(250, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  async getControlSession(signal?: AbortSignal): Promise<ExcaliburControlSession> {
    return parseControlSession(await this.requestJson(EXCALIBUR_CONTROL_PATHS.session, { signal }), this.scope);
  }

  async getCapabilities(signal?: AbortSignal): Promise<ExcaliburCapability[]> {
    const value = await this.requestJson(EXCALIBUR_CONTROL_PATHS.capabilities, { signal });
    if (!Array.isArray(value)) throw new ExcaliburTransportError("BAD_CONTRACT", "capability response must be an array");
    const capabilities = value.map(parseCapability);
    const actual = capabilities.map((item) => item.capabilityId).sort();
    const expected = [
      ...EXCALIBUR_CONTRACT_BASELINE.viewCapabilityIds,
      ...EXCALIBUR_CONTRACT_BASELINE.actionCapabilityIds,
    ].sort();
    if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
      throw new ExcaliburTransportError(
        "CONTRACT_DIGEST_MISMATCH",
        "capability response does not match the checked-in manifest capability set",
      );
    }
    return capabilities;
  }

  async getSnapshot(signal?: AbortSignal): Promise<ExcaliburControlSnapshot> {
    return parseControlSnapshot(
      await this.requestJson(EXCALIBUR_CONTROL_PATHS.snapshot, { signal }),
      this.scope,
    );
  }

  async getMemoryStatus(signal?: AbortSignal): Promise<ExcaliburMemoryPosture> {
    this.assertSidecar("memory status");
    return parseMemoryPosture(
      await this.requestJson(EXCALIBUR_CONTROL_PATHS.memory, { signal }),
      this.scope,
    );
  }

  async getObservation(observationId: string, signal?: AbortSignal): Promise<ExcaliburObservation> {
    const id = encodeBoundedIdentifier(observationId, "observation id");
    const observation = parseExcaliburObservation(
      await this.requestJson(`${EXCALIBUR_CONTROL_PATHS.observations}/${id}`, { signal }),
    );
    if (this.scope.kind === "tenant" && observation.instanceId !== this.scope.instanceId) {
      throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "observation belongs to another tenant");
    }
    return observation;
  }

  async getReceipts(
    query: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<ExcaliburReceiptPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500) {
        throw new ExcaliburTransportError("BAD_QUERY", "receipt limit must be between 1 and 500");
      }
      params.set("limit", String(query.limit));
    }
    if (query.cursor) params.set("cursor", decodeURIComponent(encodeBoundedIdentifier(query.cursor, "receipt cursor")));
    const suffix = params.size ? `?${params.toString()}` : "";
    const page = parseReceiptPage(
      await this.requestJson(`${EXCALIBUR_CONTROL_PATHS.receipts}${suffix}`, { signal }),
    );
    const expectedInstanceId = this.scope.kind === "tenant" ? this.scope.instanceId : null;
    if (expectedInstanceId && page.receipts.some((item) => item.instanceId !== expectedInstanceId)) {
      throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "receipt page contains cross-tenant evidence");
    }
    return page;
  }

  async getReceipt(commandId: string, signal?: AbortSignal): Promise<ExcaliburExecutionReceipt> {
    const id = encodeBoundedIdentifier(commandId, "command id");
    const receipt = parseExcaliburExecutionReceipt(
      await this.requestJson(`${EXCALIBUR_CONTROL_PATHS.receipts}/${id}`, { signal }),
    );
    if (this.scope.kind === "tenant" && receipt.instanceId !== this.scope.instanceId) {
      throw new ExcaliburTransportError("CONTROL_SCOPE_MISMATCH", "receipt belongs to another tenant");
    }
    return receipt;
  }

  async createConversation(signal?: AbortSignal): Promise<ExcaliburConversationSession> {
    this.assertSidecar("conversation creation");
    const value = await this.requestJson(EXCALIBUR_CONTROL_PATHS.conversations, {
      method: "POST",
      body: { scope: this.scope },
      signal,
    });
    return parseConversationSession(value, this.scope);
  }

  async resumeConversation(sessionId: string, signal?: AbortSignal): Promise<ExcaliburConversationSession> {
    this.assertSidecar("conversation resume");
    assertUuid(sessionId, "conversation id");
    const value = await this.requestJson(
      `${EXCALIBUR_CONTROL_PATHS.conversations}/${encodeURIComponent(sessionId)}`,
      { signal },
    );
    return parseConversationSession(value, this.scope);
  }

  async submitTurn(
    sessionId: string,
    input: { content: string; clientTurnId: string },
    signal?: AbortSignal,
  ): Promise<ExcaliburTurnAcceptance> {
    this.assertSidecar("chat");
    assertUuid(sessionId, "conversation id");
    assertUuid(input.clientTurnId, "client turn id");
    const content = String(input.content || "").trim();
    if (!content || content.length > 32_000) {
      throw new ExcaliburTransportError("BAD_TURN", "turn content must be 1..32000 characters");
    }
    return parseTurnAcceptance(await this.requestJson(
      `${EXCALIBUR_CONTROL_PATHS.conversations}/${encodeURIComponent(sessionId)}/turns`,
      { method: "POST", body: { content, clientTurnId: input.clientTurnId }, signal },
    ));
  }

  async *streamEvents(
    sessionId: string,
    cursor: number,
    signal?: AbortSignal,
  ): AsyncIterable<ExcaliburConversationEvent> {
    this.assertSidecar("event streaming");
    assertUuid(sessionId, "conversation id");
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new ExcaliburTransportError("BAD_EVENT_CURSOR", "event cursor must be a non-negative integer");
    }
    const response = await this.rawRequest(
      `${EXCALIBUR_CONTROL_PATHS.conversations}/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`,
      {
        signal,
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
      },
    );
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream") || !response.body) {
      throw new ExcaliburTransportError("BAD_SSE_RESPONSE", "sidecar event stream is not SSE", response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
          throw new ExcaliburTransportError("SSE_FRAME_TOO_LARGE", "sidecar event frame exceeded the safety bound");
        }
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) yield parsed;
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async abortConversation(sessionId: string, signal?: AbortSignal): Promise<ExcaliburConversationMutationReceipt> {
    this.assertSidecar("conversation abort");
    return this.mutateConversation(sessionId, "abort", signal);
  }

  async closeConversation(sessionId: string, signal?: AbortSignal): Promise<ExcaliburConversationMutationReceipt> {
    this.assertSidecar("conversation close");
    return this.mutateConversation(sessionId, "close", signal);
  }

  async createProposal(_intent: unknown, _signal?: AbortSignal): Promise<never> {
    this.assertSidecar("proposal creation");
    throw new ExcaliburEffectsLockedError("local proposal brokering");
  }

  async decideApproval(
    approvalId: string,
    input: ExcaliburApprovalDecisionInput,
    signal?: AbortSignal,
  ): Promise<ExcaliburApproval> {
    this.assertSidecar("approval decisions");
    assertUuid(approvalId, "approval id");
    if (!isRecord(input) || !exactKeys(input, ["decision", "proposalDigest"])
        || !["approved", "denied"].includes(String(input.decision || ""))
        || !DIGEST_RE.test(String(input.proposalDigest || ""))) {
      throw new ExcaliburTransportError("BAD_APPROVAL_DECISION", "approval decision must bind one exact proposal digest");
    }
    return parseExcaliburApproval(await this.requestJson(
      `${EXCALIBUR_CONTROL_PATHS.approvals}/${encodeURIComponent(approvalId)}/decide`,
      { method: "POST", body: input, signal },
    ));
  }

  private async mutateConversation(
    sessionId: string,
    operation: "abort" | "close",
    signal?: AbortSignal,
  ): Promise<ExcaliburConversationMutationReceipt> {
    assertUuid(sessionId, "conversation id");
    return parseMutationReceipt(await this.requestJson(
      `${EXCALIBUR_CONTROL_PATHS.conversations}/${encodeURIComponent(sessionId)}/${operation}`,
      { method: "POST", body: {}, signal },
    ));
  }

  private async requestJson(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const response = await this.rawRequest(path, options);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      throw new ExcaliburTransportError("BAD_CONTENT_TYPE", "Excalibur endpoint did not return JSON", response.status);
    }
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
      throw new ExcaliburTransportError("RESPONSE_TOO_LARGE", "Excalibur JSON response exceeded the safety bound", response.status);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
      throw new ExcaliburTransportError("RESPONSE_TOO_LARGE", "Excalibur JSON response exceeded the safety bound", response.status);
    }
    try { return JSON.parse(text); }
    catch { throw new ExcaliburTransportError("BAD_JSON", "Excalibur endpoint returned malformed JSON", response.status); }
  }

  private async rawRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    if (!path.startsWith("/api/v1/excalibur/")) {
      throw new ExcaliburTransportError("BAD_PATH", "refusing a non-Excalibur transport path");
    }
    const token = boundedToken(
      typeof this.accessToken === "function" ? await this.accessToken() : this.accessToken,
    );
    if (!token) {
      throw new ExcaliburTransportError(
        this.posture === "sidecar" ? "SIDECAR_CREDENTIAL_UNAVAILABLE" : "AUTH_REQUIRED",
        this.posture === "sidecar"
          ? "sidecar credential is unavailable"
          : "authenticated cloud reads require a fresh human access token",
      );
    }
    const headers = new Headers(options.headers);
    headers.set("Accept", headers.get("Accept") || "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Excalibur-Surface", "cli");
    if (this.scope.kind === "operator") headers.set("X-Excalibur-Scope", "operator");
    else {
      headers.set("X-Instance-Id", this.scope.instanceId);
      if (this.posture === "sidecar" && this.cloudAccessToken) {
        const rawCloudToken = typeof this.cloudAccessToken === "function"
          ? await this.cloudAccessToken()
          : this.cloudAccessToken;
        const cloudToken = boundedToken(rawCloudToken);
        if (rawCloudToken !== undefined && !cloudToken) {
          throw new ExcaliburTransportError("BAD_CLOUD_AUTH", "fresh tenant federation credential is malformed");
        }
        if (cloudToken) headers.set("X-Excalibur-Cloud-Authorization", `Bearer ${cloudToken}`);
      }
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const requestedTimeout = options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
    const timer = requestedTimeout > 0 ? setTimeout(() => controller.abort(), requestedTimeout) : null;
    timer?.unref();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ExcaliburTransportError(
          response.status === 401 || response.status === 403 ? "AUTH_REFUSED"
            : response.status === 423 ? "EFFECTS_LOCKED"
              : response.status === 503 ? "SIDECAR_UNAVAILABLE" : "HTTP_ERROR",
          `Excalibur endpoint returned HTTP ${response.status}`,
          response.status,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ExcaliburTransportError) throw error;
      const code = controller.signal.aborted ? "REQUEST_ABORTED" : "SIDECAR_UNAVAILABLE";
      throw new ExcaliburTransportError(code, "Excalibur transport is unavailable", null, { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private assertSidecar(operation: string): void {
    if (this.posture !== "sidecar") throw new ExcaliburEffectsLockedError(operation);
  }
}

function parseSseFrame(frame: string): ExcaliburConversationEvent | null {
  if (!frame || frame.startsWith(":")) return null;
  let id: number | null = null;
  let eventType = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new ExcaliburTransportError("BAD_EVENT_CURSOR", "sidecar emitted an invalid SSE event id");
      }
      id = parsed;
    } else if (field === "event") eventType = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  const encoded = data.join("\n");
  if (encoded === "[DONE]") return null;
  let value: unknown;
  try { value = JSON.parse(encoded); }
  catch { throw new ExcaliburTransportError("BAD_SSE_JSON", "sidecar emitted malformed event JSON"); }
  const event = parseConversationEvent(value);
  if (id !== null && id !== event.sequence) {
    throw new ExcaliburTransportError("EVENT_ID_MISMATCH", "SSE id does not match the event sequence");
  }
  if (eventType && eventType !== "message" && eventType !== event.type) {
    throw new ExcaliburTransportError("EVENT_TYPE_MISMATCH", "SSE event field does not match its contract payload");
  }
  return event;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(String(value || ""))) {
    throw new ExcaliburTransportError("BAD_IDENTIFIER", `${label} must be a UUID`);
  }
}

function encodeBoundedIdentifier(value: string, label: string): string {
  const text = String(value || "").trim();
  if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ExcaliburTransportError("BAD_IDENTIFIER", `${label} is malformed`);
  }
  return encodeURIComponent(text);
}

export const __testing = {
  parseControlSession,
  parseConversationEvent,
  parseConversationSession,
  parseControlSnapshot,
  parseExcaliburApproval,
  parseExcaliburExecutionReceipt,
  parseExcaliburProposal,
  parseSseFrame,
  validateBaseUrl,
};
