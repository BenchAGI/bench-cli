// models.ts — single source of truth for the models the launcher offers and how
// their ids render as short names. Replaces the duplicated CLAUDE_MODELS /
// CODEX_MODELS / MODEL_SHORT maps that lived in picker.tsx, cloud-seat.ts, and
// roster.ts. Add or retire a model HERE and every surface updates.
// The 1M-context Opus 4.8 is a Claude Code context profile (`[1m]`). The OpenClaw
// gateway model catalog parses `@profile` suffixes, not `[…]` brackets, so it's a
// LOCAL Claude option only — cloud/direct agents fall back to base claude-opus-4-8.
export const CLAUDE_MODELS = [
    { label: "Default", value: undefined },
    { label: "Opus 4.8", value: "claude-opus-4-8" },
    { label: "Opus 4.8 (1M)", value: "claude-opus-4-8[1m]", short: "Opus 4.8·1M", envs: ["local-claude"] },
    { label: "Opus 4.6", value: "claude-opus-4-6" },
    { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
    { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
    { label: "Fable 5", value: "claude-fable-5" },
];
export const CODEX_MODELS = [
    { label: "Default", value: undefined },
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "Mini", value: "gpt-5.4-mini" },
    { label: "Spark", value: "gpt-5.3-codex-spark" },
];
/** The model options to show for a given picker environment. */
export function modelChoices(env) {
    const all = env === "local-codex" ? CODEX_MODELS : CLAUDE_MODELS;
    return all.filter((m) => !m.envs || m.envs.includes(env));
}
// id -> short name, derived from the registry, plus a few alias forms the gateway
// `agents list` may report (e.g. the Haiku alias without the dated suffix).
export const MODEL_SHORT = {
    "claude-haiku-4-5": "Haiku 4.5",
    "claude-opus-4-8[1m]": "Opus 4.8·1M",
    ...Object.fromEntries([...CLAUDE_MODELS, ...CODEX_MODELS]
        .filter((m) => Boolean(m.value))
        .map((m) => [m.value, m.short ?? m.label])),
};
/** Short display name for a model id ("" when unset). */
export function shortModel(model) {
    if (!model)
        return "";
    return MODEL_SHORT[model] ?? model;
}
