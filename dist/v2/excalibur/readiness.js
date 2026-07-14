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
export function summarizeOneSurfaceReadiness({ controlSession, snapshot, conversation = null, capabilities = [], memoryStatus = null, }) {
    const drive = observation(snapshot, "drive.status");
    const driveFacts = drive?.facts || {};
    const memoryObservation = observation(snapshot, "memory.status");
    const memoryFacts = memoryStatus?.adapterStatus || memoryObservation?.facts || {};
    const schedulesObservation = observation(snapshot, "schedules");
    const schedulesFacts = schedulesObservation?.facts || {};
    const controlsFacts = observation(snapshot, "controls")?.facts || {};
    const systemFacts = observation(snapshot, "system")?.facts || {};
    const context = controlSession.contextKind === "tenant"
        ? safeText(controlSession.activeInstance?.instanceId, 128) || "tenant-bound"
        : "operator-local";
    const conversationId = conversation?.sessionId
        || safeText(driveFacts.conversationId, 160);
    const conversationState = conversation?.state
        || safeText(driveFacts.conversationState, 32)
        || "unavailable";
    const requestedModel = conversation?.providerSession.requestedModel
        || safeText(driveFacts.requestedModel, 64)
        || "grok-4.5";
    const servedModel = conversation?.providerSession.servedModel
        || safeText(driveFacts.servedModel, 64);
    const blockers = new Set([
        ...safeStrings(driveFacts.blockers),
        ...safeStrings(controlsFacts.blockers),
        ...capabilities
            .filter((item) => item.kind === "action")
            .flatMap((item) => item.availability.blockingGates)
            .map((item) => safeText(item))
            .filter((item) => Boolean(item)),
    ]);
    if (!conversationId || conversationState !== "active")
        blockers.add("shared_conversation_unavailable");
    if (servedModel !== "grok-4.5")
        blockers.add("served_model_attestation_required");
    if (!memoryStatus && !memoryObservation)
        blockers.add("memory_projection_unavailable");
    if (!schedulesObservation)
        blockers.add("schedules_projection_unavailable");
    return {
        context,
        effectsPosture: controlSession.effectsPosture,
        conversationId,
        conversationState,
        eventCursor: conversation ? conversation.eventCursor : null,
        requestedModel,
        servedModel,
        modelAttestedAt: conversation?.providerSession.attestedAt || null,
        memory: {
            state: safeText(memoryFacts.state, 32) || memoryObservation?.freshness.state || "unavailable",
            adapter: safeText(memoryFacts.adapter, 64) || "unavailable",
            mode: safeText(memoryFacts.mode, 64) || "unavailable",
            reason: safeText(memoryFacts.reason, 160),
            promotedCount: safeCount(memoryFacts.promotedCount),
        },
        schedules: {
            freshness: schedulesObservation?.freshness.state || "unavailable",
            total: safeCount(schedulesFacts.total),
            declared: safeCount(schedulesFacts.declared),
            armed: safeCount(schedulesFacts.armed),
            calendar: calendarReadiness(schedulesFacts),
        },
        system: {
            service: safeText(systemFacts.service, 80),
            packageVersion: safeText(systemFacts.packageVersion, 40),
            bundleVersion: safeText(systemFacts.bundleVersion, 40),
            protocolVersion: safeProtocolVersion(systemFacts.protocolVersion),
        },
        blockers: [...blockers].sort(),
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
/** Human-facing only. These lines are never sent back through submitTurn. */
export function renderOneSurfaceStartupBrief(readiness) {
    const memoryReason = readiness.memory.reason ? ` · ${readiness.memory.reason}` : "";
    const systemVersion = readiness.system.packageVersion
        ? `${readiness.system.packageVersion}${readiness.system.bundleVersion ? ` build ${readiness.system.bundleVersion}` : ""}`
        : "unavailable";
    return [
        "One-Surface startup · contract verified",
        `  context: ${readiness.context} · effects: ${readiness.effectsPosture}`,
        `  conversation: ${nullable(readiness.conversationId)} · ${readiness.conversationState}${readiness.eventCursor === null ? "" : ` · cursor ${readiness.eventCursor}`}`,
        `  model: requested ${readiness.requestedModel} · served ${nullable(readiness.servedModel)}${readiness.modelAttestedAt ? ` · attested ${readiness.modelAttestedAt}` : ""}`,
        `  memory: ${readiness.memory.state} · ${readiness.memory.adapter}/${readiness.memory.mode}${memoryReason}`,
        `  schedules: ${renderSchedules(readiness.schedules)}`,
        `  sidecar: ${readiness.system.service || "unavailable"} · ${systemVersion} · protocol ${readiness.system.protocolVersion || "unavailable"}`,
        `  blockers: ${readiness.blockers.length ? readiness.blockers.join(", ") : "none"}`,
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
