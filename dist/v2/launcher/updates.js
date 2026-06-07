// updates.ts — update-on-launch client. Checks a version manifest and reports
// whether a newer CLI is available so the launcher can prompt. GRACEFUL: a
// missing/slow/failed check never blocks launch and never throws.
//
// Manifest contract (benchagi.com serves; until then no-URL = silent):
//   GET <manifestUrl> -> { version, minSupported?, channel?, notes?, upgrade? }
const DEFAULT_TIMEOUT = 2500;
export function parseSemver(v) {
    const m = String(v ?? "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** -1 if a<b, 0 if equal/unparseable, 1 if a>b. */
export function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb)
        return 0;
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i])
            return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}
export async function checkForUpdate(opts) {
    const { currentVersion, manifestUrl, timeoutMs = DEFAULT_TIMEOUT } = opts;
    if (!manifestUrl)
        return { available: false, reason: "no-manifest-url" };
    if (!currentVersion)
        return { available: false, reason: "no-current-version" };
    // TLS only (except localhost dev) — the manifest must not be MITM-substitutable.
    try {
        const u = new URL(manifestUrl);
        if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
            return { available: false, reason: "insecure-manifest-url" };
        }
    }
    catch {
        return { available: false, reason: "bad-manifest-url" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // redirect:"error" — a 30x must not silently re-source the manifest from another origin.
        const res = await fetch(manifestUrl, { signal: controller.signal, redirect: "error" });
        if (!res.ok)
            return { available: false, reason: `http-${res.status}` };
        const m = (await res.json().catch(() => null));
        const cli = (m?.cli ?? {});
        const latest = (m?.version ?? cli.version);
        if (!latest || !parseSemver(latest))
            return { available: false, reason: "no-version" };
        const minSupported = (m?.minSupported ?? cli.minSupported);
        return {
            available: compareSemver(currentVersion, latest) < 0,
            required: minSupported ? compareSemver(currentVersion, minSupported) < 0 : false,
            current: currentVersion,
            latest,
            notes: String(m?.notes ?? cli.notes ?? "").slice(0, 400),
            upgrade: String(m?.upgrade ?? cli.upgrade ?? "").slice(0, 400),
            channel: m?.channel ?? "stable",
        };
    }
    catch (error) {
        const name = error?.name;
        return { available: false, reason: name === "AbortError" ? "timeout" : "fetch-failed" };
    }
    finally {
        clearTimeout(timer);
    }
}
/** One-line, human-facing summary for the launcher prompt (empty if nothing). */
export function updateBanner(result) {
    if (!result?.available)
        return "";
    const tag = result.required ? "REQUIRED update" : "Update available";
    const notes = result.notes ? ` — ${result.notes}` : "";
    return `${tag}: ${result.current} → ${result.latest}${notes}`;
}
