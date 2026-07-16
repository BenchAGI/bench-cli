import type {
  ExcaliburApproval,
  ExcaliburCapability,
  ExcaliburControlSnapshot,
  ExcaliburExecutionReceipt,
  ExcaliburObservation,
  ExcaliburProposal,
  ExcaliburReceiptPage,
} from "./http-transport.js";
import {
  EXCALIBUR_DRAFT_PR_ACTION_ID,
  EXCALIBUR_WHITESPACE_ACTION_ID,
  expectedExcaliburExecutorId,
} from "./http-transport.js";

export const EXCALIBUR_VIEW_COMMANDS = Object.freeze({
  pulse: "pulse",
  decisions: "decisions",
  forge: "forge",
  comms: "comms.counts",
  schedules: "schedules",
  fleet: "fleet",
  system: "system",
} as const);

function safeText(value: unknown, maximum = 1_000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value); }
    catch { text = "[unrenderable]"; }
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function statusLabel(status: ExcaliburCapability["availability"]["status"]): string {
  return status === "available" ? "ready" : status;
}

export function renderCapabilities(
  capabilities: ExcaliburCapability[],
  kind?: ExcaliburCapability["kind"],
): string[] {
  const selected = kind ? capabilities.filter((item) => item.kind === kind) : capabilities;
  const lines = [kind === "action" ? "Actions" : "Controls"];
  if (!selected.length) return [...lines, "  none"];
  for (const capability of selected) {
    const executorId = capability.executor.kind === "deterministic"
      ? safeText(capability.executor.executorId, 160) : "none";
    const expectedExecutorId = capability.kind === "action"
      ? expectedExcaliburExecutorId(capability.capabilityId) : null;
    const executorBindingBlocked = expectedExecutorId !== null && executorId !== expectedExecutorId;
    lines.push(
      `  ${(executorBindingBlocked ? "blocked" : statusLabel(capability.availability.status)).padEnd(11)} ${capability.capabilityId} — ${safeText(capability.title, 120)}`,
    );
    if (capability.availability.blockingGates.length) {
      lines.push(`    gates: ${capability.availability.blockingGates.map((item) => safeText(item, 160)).join(", ")}`);
    }
    if (capability.kind === "action") {
      lines.push(`    risk: ${capability.risk} · approval: exact human card · executor: ${executorId}`);
      if (executorBindingBlocked) {
        lines.push(`    executor binding: blocked · expected ${expectedExecutorId}`);
      }
      if (capability.capabilityId === EXCALIBUR_DRAFT_PR_ACTION_ID) {
        lines.push("    boundary: exact-head draft PR only · raw push/gh, ready, merge, and deploy unavailable");
      }
    }
  }
  return lines;
}

function renderObservation(observation: ExcaliburObservation): string[] {
  const freshness = observation.freshness.state;
  const lines = [
    `  ${freshness.padEnd(11)} ${observation.capabilityId} · ${observation.authoritativeSource} · ${observation.observedAt}`,
  ];
  const entries = Object.entries(observation.facts).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) lines.push(`    ${safeText(key, 160)}: ${safeText(value)}`);
  if (observation.permittedNextProposal) {
    lines.push(`    permitted proposal: ${observation.permittedNextProposal}`);
  }
  return lines;
}

export function renderSnapshot(
  snapshot: ExcaliburControlSnapshot,
  capabilityId?: string,
): string[] {
  const observations = capabilityId
    ? snapshot.observations.filter((item) => item.capabilityId === capabilityId)
    : snapshot.observations;
  const lines = [
    capabilityId ? `View · ${capabilityId}` : "Views",
    `  instance: ${snapshot.instanceId} · observed: ${snapshot.observedAt}`,
  ];
  if (!observations.length) return [...lines, "  unavailable · no authoritative observation returned"];
  for (const observation of observations) lines.push(...renderObservation(observation));
  return lines;
}

function resultText(result: Record<string, unknown>, key: string, maximum = 1_000): string | null {
  return typeof result[key] === "string" ? safeText(result[key], maximum) : null;
}

function resultInteger(result: Record<string, unknown>, key: string): number | null {
  return Number.isSafeInteger(result[key]) ? Number(result[key]) : null;
}

export function renderApprovalCard(proposal: ExcaliburProposal, approval: ExcaliburApproval): string[] {
  const lines = [
    "Approval required · exact operator card",
    `  action: ${safeText(proposal.actionId, 160)}`,
    `  command: ${proposal.commandId}`,
  ];
  if (proposal.actionId === EXCALIBUR_DRAFT_PR_ACTION_ID) {
    const repository = safeText(proposal.target.repository, 220);
    const baseRef = safeText(proposal.payload.baseRef, 255);
    const headRef = safeText(proposal.payload.headRef, 255);
    const baseSha = safeText(proposal.payload.baseSha, 64);
    const headSha = safeText(proposal.payload.headSha, 64);
    const patchDigest = safeText(proposal.payload.patchDigest, 64);
    const changedPathsDigest = safeText(proposal.payload.changedPathsDigest, 64);
    const packetDigest = safeText(proposal.payload.packetDigest, 64);
    const missionId = safeText(proposal.payload.missionId, 128);
    const principalId = safeText(proposal.payload.principalId, 160);
    const sessionId = safeText(proposal.payload.sessionId, 160);
    const missionDigest = safeText(proposal.payload.missionDigest, 64);
    const publicationGateDigest = safeText(proposal.payload.publicationGateDigest, 64);
    const titleJson = JSON.stringify(String(proposal.payload.title));
    const bodyJson = JSON.stringify(String(proposal.payload.body));
    const labelsJson = JSON.stringify(proposal.payload.labels);
    const publisherPrincipal = safeText(proposal.resourceFingerprints.publisherPrincipal, 39);
    const publisherPrincipalId = Number(proposal.resourceFingerprints.publisherPrincipalId);
    const publisherConfigDigest = safeText(proposal.resourceFingerprints.publisherConfigDigest, 64);
    const publisherIdentityDigest = safeText(
      proposal.resourceFingerprints.publisherIdentityAttestationDigest,
      64,
    );
    lines.push(`  repository: ${repository}`);
    lines.push(`  mission: ${missionId} @ ${missionDigest}`);
    lines.push(`  authority: principal ${principalId} · session ${sessionId}`);
    lines.push(`  publication gate: ${publicationGateDigest}`);
    lines.push(`  base: ${baseRef} @ ${baseSha}`);
    lines.push(`  head: ${headRef} @ ${headSha}`);
    lines.push(`  patch: ${patchDigest}`);
    lines.push(`  changed paths: ${changedPathsDigest} · packet: ${packetDigest}`);
    lines.push(`  title (exact JSON string): ${titleJson}`);
    lines.push(`  body (exact JSON string): ${bodyJson}`);
    lines.push(`  labels (exact JSON): ${labelsJson}`);
    lines.push(`  publisher: ${publisherPrincipal} #${publisherPrincipalId}`);
    lines.push(`  publisher config: ${publisherConfigDigest}`);
    lines.push(`  publisher identity attestation: ${publisherIdentityDigest}`);
    lines.push("  effect: push exact head + open draft PR · merge/ready/deploy excluded");
  } else if (proposal.actionId === EXCALIBUR_WHITESPACE_ACTION_ID) {
    lines.push(`  maximum deals: ${safeText(proposal.payload.maximumDeals, 16)} · mode: ${safeText(proposal.payload.mode, 32)}`);
  } else {
    lines.push(`  target: ${safeText(proposal.target.resourceType ?? "typed resource", 160)}`);
  }
  lines.push(`  proposal digest: ${proposal.proposalDigest}`);
  lines.push(`  expires: ${approval.expiresAt}`);
  lines.push("  [A] Approve  [D] Deny · typed prose never approves");
  return lines;
}

export function renderReceipt(receipt: ExcaliburExecutionReceipt): string[] {
  const expectedExecutorId = expectedExcaliburExecutorId(receipt.actionId);
  if (expectedExecutorId !== null && receipt.executorId !== expectedExecutorId) {
    return [
      `  blocked     ${receipt.actionId} · untrusted receipt executor binding`,
      `    receipt ${receipt.receiptId} · expected ${expectedExecutorId} · received ${safeText(receipt.executorId, 160)}`,
      "    outcome withheld · run sidecar/CLI contract parity diagnostics",
    ];
  }
  const lines = [
    `  ${receipt.outcome.padEnd(11)} ${receipt.actionId} · command ${receipt.commandId} · ${receipt.occurredAt}`,
    `    receipt ${receipt.receiptId} · executor ${receipt.executorId}`,
  ];
  const runId = resultText(receipt.result, "runId", 160);
  const rowCount = resultInteger(receipt.result, "rowCount");
  const outputDigest = resultText(receipt.result, "outputDigest", 64);
  const errorCode = resultText(receipt.result, "errorCode", 160);
  if (runId) lines.push(`    run: ${runId}`);
  if (rowCount !== null) lines.push(`    rows: ${rowCount}`);
  if (receipt.actionId === EXCALIBUR_DRAFT_PR_ACTION_ID) {
    const repository = resultText(receipt.result, "repository", 220) || "unavailable";
    const headRef = resultText(receipt.result, "headRef", 255) || "unavailable";
    const headSha = resultText(receipt.result, "headSha", 64) || "unavailable";
    const prNumber = resultInteger(receipt.result, "pullRequestNumber");
    const prUrl = resultText(receipt.result, "pullRequestUrl", 2_048);
    const publisherPrincipal = resultText(receipt.result, "publisherPrincipal", 39) || "unavailable";
    const publisherPrincipalId = resultInteger(receipt.result, "publisherPrincipalId");
    const publisherConfigDigest = resultText(receipt.result, "publisherConfigDigest", 64) || "unavailable";
    const publisherIdentityDigest = resultText(receipt.result, "publisherIdentityAttestationDigest", 64) || "unavailable";
    lines.push(`    repository: ${repository} · head: ${headRef} @ ${headSha} · draft: yes`);
    lines.push(`    publisher: ${publisherPrincipal}${publisherPrincipalId === null ? "" : ` #${publisherPrincipalId}`}`);
    lines.push(`    publisher config: ${publisherConfigDigest} · identity attestation: ${publisherIdentityDigest}`);
    if (prNumber !== null || prUrl) lines.push(`    pull request: ${prNumber === null ? "draft" : `#${prNumber}`}${prUrl ? ` · ${prUrl}` : ""}`);
    const indeterminateReason = resultText(receipt.result, "indeterminateReason", 160);
    if (indeterminateReason) lines.push(`    indeterminate: ${indeterminateReason} · reconciliation required`);
  }
  if (outputDigest) lines.push(`    output: ${outputDigest}`);
  if (errorCode) lines.push(`    error: ${errorCode}`);
  if (receipt.evidenceRefs.length) lines.push(`    evidence: ${receipt.evidenceRefs.map((item) => safeText(item, 160)).join(", ")}`);
  return lines;
}

export function renderReceiptPage(page: ExcaliburReceiptPage): string[] {
  const lines = ["Receipts"];
  if (!page.receipts.length) return [...lines, "  none"];
  for (const receipt of page.receipts) lines.push(...renderReceipt(receipt));
  if (page.nextCursor) lines.push(`  more available · cursor ${safeText(page.nextCursor, 160)}`);
  return lines;
}
