// Backend capability probe — ADR-005 (post-ANVIL P2 fix).
// Heuristic on agent's model.primary returns a HINT, not authoritative.
// Runtime liveness threshold drives the indicator regardless.
export function classifyByModel(modelPrimary) {
    if (!modelPrimary)
        return "unknown";
    if (modelPrimary.startsWith("pi/"))
        return "stream";
    if (modelPrimary.startsWith("anthropic-direct/"))
        return "stream";
    if (modelPrimary.startsWith("openai-direct/"))
        return "stream";
    if (modelPrimary.startsWith("claude-cli/"))
        return "batch";
    if (modelPrimary.startsWith("openai-codex/"))
        return "batch";
    return "unknown";
}
export function resolveLivenessThreshold(hint, override, tickIntervalMs) {
    if (override === "always")
        return 0;
    if (override === "off")
        return Number.POSITIVE_INFINITY;
    if (override === "stream")
        return Math.max(5_000, 3 * tickIntervalMs);
    if (override === "batch")
        return 0;
    // auto:
    if (hint === "batch")
        return 0;
    return Math.max(5_000, 3 * tickIntervalMs);
}
