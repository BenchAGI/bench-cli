// effort.ts — the effort taxonomy, kept pure (no React) so it's unit-testable and
// shared. Effort is environment-specific:
//   • local Claude Code has the `ultracode` preset (xhigh + dynamic-workflow
//     orchestration), set via the CLAUDE_CODE_EFFORT_LEVEL env — NOT a --effort flag.
//   • the OpenClaw cloud harness exposes off…max thinkingLevels (no ultracode).
//   • Codex reasoning effort is minimal…high.
// Conflating these is the bug behind "Ultra Code runs max thinking".
export const DEFAULT_EFFORT = "medium";
const CLAUDE_EFFORTS = [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "XHigh", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Ultra Code", value: "ultracode" },
];
const CLOUD_EFFORTS = [
    { label: "Off", value: "off" },
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "XHigh", value: "xhigh" },
    { label: "Max", value: "max" },
];
const CODEX_EFFORTS = [
    { label: "Minimal", value: "minimal" },
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "XHigh", value: "xhigh" },
];
/** Effort options for a given environment. */
export function effortChoices(env) {
    if (env === "local-codex")
        return CODEX_EFFORTS;
    if (env === "local-claude")
        return CLAUDE_EFFORTS;
    return CLOUD_EFFORTS; // tunnel | direct
}
/**
 * Index of `value` within the env's effort list, preserving the chosen level by
 * value when supported, else falling back to DEFAULT_EFFORT (then index 0).
 * Used to keep the selection sensible when the environment changes.
 */
export function effortIndexFor(env, value) {
    const list = effortChoices(env);
    const exact = list.findIndex((c) => c.value === value);
    if (exact >= 0)
        return exact;
    const fallback = list.findIndex((c) => c.value === DEFAULT_EFFORT);
    return fallback >= 0 ? fallback : 0;
}
export function effortValueForEnv(env, value) {
    const list = effortChoices(env);
    return list[effortIndexFor(env, value)]?.value ?? DEFAULT_EFFORT;
}
export function nextEffortValueForEnv(env, value, delta) {
    const list = effortChoices(env);
    const current = effortIndexFor(env, value);
    const next = ((current + delta) % list.length + list.length) % list.length;
    return list[next]?.value ?? DEFAULT_EFFORT;
}
/** Every known picker effort, for env-var validation. */
export const ALL_EFFORTS = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode",
];
