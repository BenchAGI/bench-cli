// Reconnect backoff sequence per V1.1 §"Item 1" runbook + ADR-004.
// Sequence is 1s, 2s, 5s, 10s, 30s. Attempts beyond 5 cap at 30s.
export const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
export const BACKOFF_CAP_MS = 30_000;
/**
 * Returns the delay (ms) before the (1-indexed) Nth reconnect attempt.
 *
 * - attempt 1 → 1000
 * - attempt 2 → 2000
 * - attempt 3 → 5000
 * - attempt 4 → 10000
 * - attempt 5 → 30000
 * - attempt 6+ → 30000 (cap)
 *
 * Non-positive `attempt` returns 0.
 */
export function nextBackoffMs(attempt) {
    if (!Number.isFinite(attempt) || attempt < 1)
        return 0;
    const idx = Math.floor(attempt) - 1;
    if (idx < BACKOFF_SEQUENCE_MS.length)
        return BACKOFF_SEQUENCE_MS[idx];
    return BACKOFF_CAP_MS;
}
