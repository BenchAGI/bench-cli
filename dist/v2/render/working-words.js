// Eagle-themed "working" words — our 🦅 answer to Claude Code's "Clauding…/wrangling…".
// Shown in the working line while a run is in flight. The word is deterministic per run (stable
// within a turn — no jarring flicker) and rotates on a slow timer. No Math.random so the choice is
// reproducible and resume-safe.
export const WORKING_WORDS = [
    "Soaring",
    "Hunting",
    "Circling",
    "Diving",
    "Gliding",
    "Scouting",
    "Hovering",
    "Swooping",
    "Tracking",
    "Wheeling",
    "Stooping", // a falcon's hunting dive
    "Roosting",
    "Cresting",
    "Banking",
    "Perching",
    "Talon-deep",
];
// Default rotation period for the working word (ms).
export const WORD_ROTATE_MS = 4_000;
// FNV-1a-style 32-bit hash → stable seed per runId.
function hashSeed(runId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < runId.length; i++) {
        h ^= runId.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
// Deterministic word for a run at rotation step `tick` (0, 1, 2, …).
// Same (runId, tick) always yields the same word.
export function pickWord(runId, tick = 0) {
    const seed = hashSeed(runId || "run");
    const idx = (seed + Math.max(0, Math.floor(tick))) % WORKING_WORDS.length;
    return WORKING_WORDS[idx];
}
// Convenience: the word to show after `elapsedMs` of a run, rotating every `periodMs`.
export function wordForElapsed(runId, elapsedMs, periodMs = WORD_ROTATE_MS) {
    const tick = periodMs > 0 ? Math.floor(Math.max(0, elapsedMs) / periodMs) : 0;
    return pickWord(runId, tick);
}
