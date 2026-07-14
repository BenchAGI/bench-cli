export const EXCALIBUR_VIEW_COMMANDS = Object.freeze({
    pulse: "pulse",
    decisions: "decisions",
    forge: "forge",
    comms: "comms.counts",
    schedules: "schedules",
    fleet: "fleet",
    system: "system",
});
function safeText(value, maximum = 1_000) {
    let text;
    if (typeof value === "string")
        text = value;
    else {
        try {
            text = JSON.stringify(value);
        }
        catch {
            text = "[unrenderable]";
        }
    }
    return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}
function statusLabel(status) {
    return status === "available" ? "ready" : status;
}
export function renderCapabilities(capabilities, kind) {
    const selected = kind ? capabilities.filter((item) => item.kind === kind) : capabilities;
    const lines = [kind === "action" ? "Actions" : "Controls"];
    if (!selected.length)
        return [...lines, "  none"];
    for (const capability of selected) {
        lines.push(`  ${statusLabel(capability.availability.status).padEnd(11)} ${capability.capabilityId} — ${safeText(capability.title, 120)}`);
        if (capability.availability.blockingGates.length) {
            lines.push(`    gates: ${capability.availability.blockingGates.map((item) => safeText(item, 160)).join(", ")}`);
        }
        if (capability.kind === "action") {
            lines.push(`    risk: ${capability.risk} · approval: exact human card · executor: deterministic`);
        }
    }
    return lines;
}
function renderObservation(observation) {
    const freshness = observation.freshness.state;
    const lines = [
        `  ${freshness.padEnd(11)} ${observation.capabilityId} · ${observation.authoritativeSource} · ${observation.observedAt}`,
    ];
    const entries = Object.entries(observation.facts).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of entries)
        lines.push(`    ${safeText(key, 160)}: ${safeText(value)}`);
    if (observation.permittedNextProposal) {
        lines.push(`    permitted proposal: ${observation.permittedNextProposal}`);
    }
    return lines;
}
export function renderSnapshot(snapshot, capabilityId) {
    const observations = capabilityId
        ? snapshot.observations.filter((item) => item.capabilityId === capabilityId)
        : snapshot.observations;
    const lines = [
        capabilityId ? `View · ${capabilityId}` : "Views",
        `  instance: ${snapshot.instanceId} · observed: ${snapshot.observedAt}`,
    ];
    if (!observations.length)
        return [...lines, "  unavailable · no authoritative observation returned"];
    for (const observation of observations)
        lines.push(...renderObservation(observation));
    return lines;
}
function renderReceipt(receipt) {
    const lines = [
        `  ${receipt.outcome.padEnd(11)} ${receipt.actionId} · command ${receipt.commandId} · ${receipt.occurredAt}`,
        `    receipt ${receipt.receiptId} · executor ${receipt.executorId}`,
    ];
    if (receipt.result.runId)
        lines.push(`    run: ${safeText(receipt.result.runId, 160)}`);
    if (receipt.result.rowCount !== undefined)
        lines.push(`    rows: ${receipt.result.rowCount}`);
    if (receipt.result.errorCode)
        lines.push(`    error: ${safeText(receipt.result.errorCode, 160)}`);
    return lines;
}
export function renderReceiptPage(page) {
    const lines = ["Receipts"];
    if (!page.receipts.length)
        return [...lines, "  none"];
    for (const receipt of page.receipts)
        lines.push(...renderReceipt(receipt));
    if (page.nextCursor)
        lines.push(`  more available · cursor ${safeText(page.nextCursor, 160)}`);
    return lines;
}
