import { EXCALIBUR_DRAFT_PR_ACTION_ID, EXCALIBUR_DRAFT_PR_EXECUTOR_ID, expectedExcaliburExecutorId, } from "./http-transport.js";
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function safeText(value, maximum = 160) {
    if (typeof value !== "string")
        return null;
    const text = value.trim();
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text))
        return null;
    return text;
}
function safeCount(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
function safeProtocolVersion(value) {
    const text = safeText(value, 80);
    if (text !== null)
        return text;
    return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null;
}
function safeBoolean(value) {
    return typeof value === "boolean" ? value : null;
}
function safeStrings(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => safeText(item)).filter((item) => Boolean(item));
}
function observation(snapshot, capabilityId) {
    return snapshot.observations.find((item) => item.capabilityId === capabilityId) || null;
}
function calendarReadiness(facts) {
    const calendar = record(facts.agenda) || record(facts.calendar) || record(facts.operatorCalendar);
    if (!calendar)
        return null;
    const rawState = safeText(calendar.state || calendar.status) || "unavailable";
    return {
        state: rawState,
        enabled: safeBoolean(calendar.enabled),
        configured: safeBoolean(calendar.configured),
        provider: safeText(calendar.provider, 32),
        timezone: safeText(calendar.timezone, 128),
        lookaheadDays: safeCount(calendar.lookaheadDays),
        upcomingCount: safeCount(calendar.upcomingCount ?? calendar.eventCount),
    };
}
function health(id, state, detail, evidence, remediation = null) {
    return { id, state, detail, evidence, remediation };
}
function stateFromText(value) {
    const state = safeText(value, 32)?.toLowerCase();
    if (["ready", "available", "active", "idle", "healthy", "ok"].includes(state || ""))
        return "ready";
    if (["locked", "denied"].includes(state || ""))
        return "locked";
    if (["blocked", "failed", "unsafe", "dirty", "unhealthy"].includes(state || ""))
        return "blocked";
    if (["degraded", "stale", "partial"].includes(state || ""))
        return "degraded";
    return "unavailable";
}
function parseSupportSeats(fleet, conversation, conversationState, requestedModel, servedModel) {
    const seats = [{
            seatId: "aurelius-conductor",
            role: "conductor",
            provider: "xai",
            requestedModel,
            servedModel,
            state: conversationState === "active" && servedModel === requestedModel ? "ready" : "blocked",
            attestationDigest: conversation?.providerSession.attestationDigest || null,
        }];
    const facts = fleet?.facts || {};
    const candidates = [facts.seats, facts.seatRoster, facts.supportSeats]
        .find((value) => Array.isArray(value));
    if (Array.isArray(candidates)) {
        for (const [index, value] of candidates.slice(0, 24).entries()) {
            const seat = record(value);
            if (!seat)
                continue;
            const role = safeText(seat.role, 64) || "support";
            if (role === "conductor")
                continue;
            seats.push({
                seatId: safeText(seat.seatId ?? seat.id, 120) || `support-${index + 1}`,
                role,
                provider: safeText(seat.provider, 64),
                requestedModel: safeText(seat.requestedModel ?? seat.model, 120),
                servedModel: safeText(seat.servedModel, 120),
                state: stateFromText(seat.state ?? seat.status),
                attestationDigest: safeText(seat.attestationDigest, 64),
            });
        }
    }
    if (seats.length === 1) {
        seats.push({
            seatId: "support-seat-roster",
            role: "planner/builder/adversary",
            provider: null,
            requestedModel: null,
            servedModel: null,
            state: "unavailable",
            attestationDigest: null,
        });
    }
    return seats;
}
function summarizeWorktree(forge) {
    if (!forge)
        return health("worktree", "unavailable", "no authoritative worktree projection", "forge observation absent", "start the worktree broker and publish its content-free projection");
    const facts = forge.facts;
    const candidates = Array.isArray(facts.worktrees)
        ? facts.worktrees.map(record).filter((item) => Boolean(item))
        : [record(facts.worktree) || record(facts.worktreeHealth)].filter((item) => Boolean(item));
    if (!candidates.length)
        return health("worktree", "unavailable", "no exact worktree lease or head reported", forge.authoritativeSource, "provision a clean isolated worktree and publish its lease plus exact head SHA");
    const blocked = candidates.some((item) => stateFromText(item.state ?? item.status) === "blocked"
        || item.clean === false);
    const exactHeads = candidates.filter((item) => /^[a-f0-9]{40}$/.test(String(item.headSha || item.head || ""))).length;
    const state = blocked ? "blocked" : exactHeads === candidates.length ? "ready" : "degraded";
    const paths = candidates.map((item) => safeText(item.path ?? item.worktreePath, 1_024)).filter(Boolean);
    return health("worktree", state, `${candidates.length} isolated worktree(s) · exact heads ${exactHeads}/${candidates.length}${paths.length ? ` · ${paths.join(", ")}` : ""}`, forge.authoritativeSource, state === "ready" ? null : "refresh the clean-worktree lease and exact head projection");
}
function summarizePublisher(capabilities) {
    const publisher = capabilities.find((item) => item.capabilityId === EXCALIBUR_DRAFT_PR_ACTION_ID);
    if (!publisher)
        return health("publisher", "unavailable", `${EXCALIBUR_DRAFT_PR_ACTION_ID} is absent`, "capability manifest", "run a sidecar and CLI built from the same draft-PR control contract");
    const approvalReady = publisher.availability.status === "locked"
        && publisher.availability.blockingGates.length > 0
        && publisher.availability.blockingGates.every(isApprovalGate);
    const state = publisher.availability.status === "available" || approvalReady
        ? "ready" : publisher.availability.status;
    const gates = publisher.availability.blockingGates.length
        ? publisher.availability.blockingGates.join(", ") : "none";
    const executor = publisher.executor.kind === "deterministic" ? publisher.executor.executorId : "none";
    if (executor !== EXCALIBUR_DRAFT_PR_EXECUTOR_ID)
        return health("publisher", "blocked", `draft-only · executor binding mismatch · expected ${EXCALIBUR_DRAFT_PR_EXECUTOR_ID} · received ${executor}`, `capability ${publisher.capabilityId}`, "run a sidecar and CLI generated from the same canonical action/executor registry");
    return health("publisher", state, `draft-only · capability ${publisher.availability.status} · executor ${executor} · gates ${gates}`, `capability ${publisher.capabilityId}`, state === "ready" ? null : "satisfy only the listed publisher gates; raw git/gh remains unavailable");
}
function summarizeLedger(receipts, receiptPage, receiptProbeError) {
    if (receiptProbeError)
        return health("ledger", "degraded", `receipt endpoint unavailable · ${receiptProbeError}`, receipts?.authoritativeSource || "receipt endpoint", "restore the shared receipt endpoint; do not infer effect completion from chat");
    if (!receipts)
        return health("ledger", "unavailable", "no authoritative receipt-ledger projection", "receipts observation absent", "restore the shared append-only receipt projection");
    const appendOnly = safeBoolean(receipts.facts.appendOnly);
    const state = appendOnly === false ? "blocked"
        : receipts.freshness.state === "fresh" ? "ready" : "degraded";
    const projected = safeCount(receipts.facts.receiptCount);
    const sampled = receiptPage?.receipts.length ?? null;
    return health("ledger", state, `freshness ${receipts.freshness.state} · append-only ${appendOnly === null ? "unattested" : appendOnly ? "yes" : "no"} · projected ${projected ?? "unavailable"} · sampled ${sampled ?? "unavailable"}`, receipts.authoritativeSource, state === "ready" ? null : "restore a fresh append-only receipt projection");
}
function isApprovalGate(gate) {
    return ["exact_human_approval", "operator_approval_required", "confirmation_required"].includes(gate);
}
function wieldable(capability) {
    const expectedExecutorId = expectedExcaliburExecutorId(capability.capabilityId);
    return capability.kind === "action" && capability.availability.status !== "unavailable"
        && (expectedExecutorId === null
            || (capability.executor.kind === "deterministic"
                && capability.executor.executorId === expectedExecutorId))
        && (capability.availability.status === "available"
            || capability.availability.blockingGates.every(isApprovalGate));
}
function derivePosture(session, capabilities, coreReady) {
    if (!coreReady || session.effectsPosture === "read_only")
        return "SHADOW";
    if (session.effectsPosture !== "approval_bound")
        return "PREPARE";
    const publisher = capabilities.find((item) => item.capabilityId === EXCALIBUR_DRAFT_PR_ACTION_ID);
    if (!publisher || !wieldable(publisher))
        return "PREPARE";
    const actions = capabilities.filter((item) => item.kind === "action" && wieldable(item));
    if (actions.some((item) => /(?:^|[._-])(?:merge|land)(?:[._-]|$)/i.test(item.capabilityId)))
        return "LAND";
    if (actions.length)
        return "WIELD";
    return "PREPARE";
}
export function summarizeOneSurfaceReadiness({ controlSession, snapshot, conversation = null, capabilities = [], memoryStatus = null, receiptPage = null, receiptProbeError = null, }) {
    const drive = observation(snapshot, "drive.status");
    const driveFacts = drive?.facts || {};
    const memoryObservation = observation(snapshot, "memory.status");
    const memoryFacts = memoryStatus?.adapterStatus || memoryObservation?.facts || {};
    const schedulesObservation = observation(snapshot, "schedules");
    const schedulesFacts = schedulesObservation?.facts || {};
    const controlsFacts = observation(snapshot, "controls")?.facts || {};
    const system = observation(snapshot, "system");
    const systemFacts = system?.facts || {};
    const fleet = observation(snapshot, "fleet");
    const forge = observation(snapshot, "forge");
    const receiptsObservation = observation(snapshot, "receipts");
    const context = controlSession.contextKind === "tenant"
        ? safeText(controlSession.activeInstance?.instanceId, 128) || "tenant-bound"
        : "operator-local";
    const conversationId = conversation?.sessionId || safeText(driveFacts.conversationId, 160);
    const conversationState = conversation?.state || safeText(driveFacts.conversationState, 32) || "unavailable";
    const requestedModel = conversation?.providerSession.requestedModel
        || safeText(driveFacts.requestedModel, 64) || "grok-4.5";
    const servedModel = conversation?.providerSession.servedModel || safeText(driveFacts.servedModel, 64);
    const coreBlockers = new Set();
    if (!conversationId || conversationState !== "active")
        coreBlockers.add("shared_conversation_unavailable");
    if (servedModel !== requestedModel || servedModel !== "grok-4.5")
        coreBlockers.add("served_model_attestation_required");
    const coreReady = coreBlockers.size === 0;
    const reportedBlockers = new Set([
        ...safeStrings(driveFacts.blockers),
        ...safeStrings(controlsFacts.blockers),
        ...coreBlockers,
    ]);
    const capabilityReadiness = capabilities
        .filter((item) => item.kind === "action")
        .map((item) => ({
        capabilityId: item.capabilityId,
        state: item.availability.status,
        gates: [...item.availability.blockingGates],
    }));
    for (const item of capabilityReadiness)
        for (const gate of item.gates)
            reportedBlockers.add(gate);
    const memory = {
        state: safeText(memoryFacts.state, 32) || memoryObservation?.freshness.state || "unavailable",
        adapter: safeText(memoryFacts.adapter, 64) || "unavailable",
        mode: safeText(memoryFacts.mode, 64) || "unavailable",
        reason: safeText(memoryFacts.reason, 160),
        promotedCount: safeCount(memoryFacts.promotedCount),
    };
    const schedules = {
        freshness: schedulesObservation?.freshness.state || "unavailable",
        total: safeCount(schedulesFacts.total ?? schedulesFacts.jobCount),
        declared: safeCount(schedulesFacts.declared),
        armed: safeCount(schedulesFacts.armed),
        calendar: calendarReadiness(schedulesFacts),
    };
    const systemSummary = {
        service: safeText(systemFacts.service, 80),
        packageVersion: safeText(systemFacts.packageVersion, 40),
        bundleVersion: safeText(systemFacts.bundleVersion, 40),
        protocolVersion: safeProtocolVersion(systemFacts.protocolVersion),
    };
    const sidecarHealth = health("sidecar", "ready", `${systemSummary.service || "shared Excalibur sidecar"} · ${systemSummary.packageVersion || "version unavailable"}${systemSummary.bundleVersion ? ` build ${systemSummary.bundleVersion}` : ""}`, `protocol ${controlSession.digests.protocol} · manifest ${controlSession.digests.manifest} · routing ${controlSession.digests.routing}`);
    const conductorHealth = health("conductor", coreReady ? "ready" : "blocked", `xai · requested ${requestedModel} · served ${servedModel || "unavailable"}${conversation?.providerSession.attestedAt ? ` · attested ${conversation.providerSession.attestedAt}` : ""}`, conversation?.providerSession.attestationDigest || drive?.authoritativeSource || "no model attestation", coreReady ? null : "restore the sidecar-owned exact Grok 4.5 conversation; direct provider launch is disabled");
    const ledgerHealth = summarizeLedger(receiptsObservation, receiptPage, receiptProbeError);
    const worktreeHealth = summarizeWorktree(forge);
    const publisherHealth = summarizePublisher(capabilities);
    const memoryHealth = health("memory", memory.state === "available" ? "ready" : stateFromText(memory.state), `${memory.adapter}/${memory.mode}${memory.reason ? ` · ${memory.reason}` : ""}`, memoryObservation?.authoritativeSource || memoryStatus?.adapterStatus.observedDigest || "memory projection absent", memory.state === "available" ? null : "configure or restore the scoped memory adapter; conversation may continue without it");
    const schedulesHealth = health("schedules", schedules.freshness === "fresh" ? "ready" : stateFromText(schedules.freshness), `freshness ${schedules.freshness} · total ${schedules.total ?? "unavailable"}`, schedulesObservation?.authoritativeSource || "schedules projection absent", schedules.freshness === "fresh" ? null : "restore the schedules projection; unrelated capabilities remain available");
    const seats = parseSupportSeats(fleet, conversation, conversationState, requestedModel, servedModel);
    const degradations = new Set();
    for (const item of [ledgerHealth, worktreeHealth, publisherHealth, memoryHealth, schedulesHealth]) {
        if (item.state !== "ready")
            degradations.add(`${item.id}:${item.state}`);
    }
    for (const seat of seats.filter((item) => item.role !== "conductor" && item.state !== "ready")) {
        degradations.add(`seat:${seat.seatId}:${seat.state}`);
    }
    return {
        posture: derivePosture(controlSession, capabilities, coreReady),
        coreReady,
        context,
        effectsPosture: controlSession.effectsPosture,
        conversationId,
        conversationState,
        eventCursor: conversation ? conversation.eventCursor : null,
        requestedModel,
        servedModel,
        modelAttestedAt: conversation?.providerSession.attestedAt || null,
        contractDigests: { ...controlSession.digests },
        memory,
        schedules,
        system: systemSummary,
        health: {
            sidecar: sidecarHealth,
            conductor: conductorHealth,
            ledger: ledgerHealth,
            worktree: worktreeHealth,
            publisher: publisherHealth,
            memory: memoryHealth,
            schedules: schedulesHealth,
            seats,
        },
        capabilities: capabilityReadiness,
        coreBlockers: [...coreBlockers].sort(),
        degradations: [...degradations].sort(),
        blockers: [...reportedBlockers].sort(),
    };
}
function nullable(value) {
    return value === null ? "unavailable" : String(value);
}
function renderSchedules(readiness) {
    const parts = [
        readiness.freshness,
        `total ${nullable(readiness.total)}`,
        `declared ${nullable(readiness.declared)}`,
        `armed ${nullable(readiness.armed)}`,
    ];
    if (readiness.calendar) {
        const calendar = readiness.calendar;
        parts.push(`calendar ${calendar.state}`);
        if (calendar.configured !== null)
            parts.push(`configured ${calendar.configured ? "yes" : "no"}`);
        if (calendar.enabled !== null)
            parts.push(`enabled ${calendar.enabled ? "yes" : "no"}`);
        if (calendar.upcomingCount !== null)
            parts.push(`upcoming ${calendar.upcomingCount}`);
    }
    return parts.join(" · ");
}
function shortDigest(value) {
    return value.slice(0, 12);
}
function compactHealth(item) {
    return `${item.state} · ${item.detail}`;
}
/** Human-facing only. These lines are never sent back through submitTurn. */
export function renderOneSurfaceStartupBrief(readiness) {
    const seatSummary = readiness.health.seats.map((seat) => (`${seat.role}/${seat.seatId} ${seat.state}${seat.servedModel ? ` ${seat.provider || "provider"}:${seat.servedModel}` : ""}`)).join("; ");
    const capabilitySummary = readiness.capabilities.length
        ? readiness.capabilities.map((item) => (`${item.capabilityId}=${item.state}${item.gates.length ? `(${item.gates.join("+")})` : ""}`)).join("; ")
        : "none returned";
    return [
        `One-Surface MIGHT startup · ${readiness.posture} · ${readiness.coreReady ? "core contract verified" : "core blocked"}`,
        `  M Mission: ${readiness.context} · conversation ${nullable(readiness.conversationId)} · ${readiness.conversationState}${readiness.eventCursor === null ? "" : ` · cursor ${readiness.eventCursor}`}`,
        `  I Intelligence: ${compactHealth(readiness.health.conductor)}`,
        `  G Grants: effects ${readiness.effectsPosture} · publisher ${compactHealth(readiness.health.publisher)}`,
        `  H Hands/seats: ${seatSummary}`,
        `  H Hands/worktree: ${compactHealth(readiness.health.worktree)}`,
        `  T Truth/ledger: ${compactHealth(readiness.health.ledger)}`,
        `  component/sidecar: ${compactHealth(readiness.health.sidecar)}`,
        `  contract: protocol ${shortDigest(readiness.contractDigests.protocol)} · manifest ${shortDigest(readiness.contractDigests.manifest)} · routing ${shortDigest(readiness.contractDigests.routing)}`,
        `  memory: ${compactHealth(readiness.health.memory)}`,
        `  schedules: ${renderSchedules(readiness.schedules)}`,
        `  actions: ${capabilitySummary}`,
        `  core blockers: ${readiness.coreBlockers.length ? readiness.coreBlockers.join(", ") : "none"}`,
        `  capability degradations: ${readiness.degradations.length ? readiness.degradations.join(", ") : "none"}`,
        `  reported gates: ${readiness.blockers.length ? readiness.blockers.join(", ") : "none"}`,
    ];
}
/** Content-free sidecar adapter posture; never renders entries or local shelf paths. */
export function renderSidecarMemoryStatus(memory) {
    const status = memory.adapterStatus;
    return [
        `Sidecar memory · ${status.state}`,
        `  scope: ${memory.scopeKind} · adapter: ${status.adapter} · mode: ${status.mode}`,
        `  sources: ${status.sources.length ? status.sources.join(", ") : "none"} · promoted: ${status.promotedCount}`,
        `  reason: ${status.reason || "none"}`,
        "  content: excluded · operator fallback: disabled · native model memory: disabled · receipts: excluded",
    ];
}
