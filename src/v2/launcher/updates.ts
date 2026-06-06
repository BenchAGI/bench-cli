// updates.ts — update-on-launch client. Checks a version manifest and reports
// whether a newer CLI is available so the launcher can prompt. GRACEFUL: a
// missing/slow/failed check never blocks launch and never throws.
//
// Manifest contract (benchagi.com serves; until then no-URL = silent):
//   GET <manifestUrl> -> { version, minSupported?, channel?, notes?, upgrade? }

const DEFAULT_TIMEOUT = 2500;

export interface UpdateResult {
  available: boolean;
  required?: boolean;
  current?: string;
  latest?: string;
  notes?: string;
  upgrade?: string;
  channel?: string;
  reason?: string;
}

export function parseSemver(v: string | undefined): [number, number, number] | null {
  const m = String(v ?? "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 if a<b, 0 if equal/unparseable, 1 if a>b. */
export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

export async function checkForUpdate(opts: {
  currentVersion: string;
  manifestUrl?: string;
  timeoutMs?: number;
}): Promise<UpdateResult> {
  const { currentVersion, manifestUrl, timeoutMs = DEFAULT_TIMEOUT } = opts;
  if (!manifestUrl) return { available: false, reason: "no-manifest-url" };
  if (!currentVersion) return { available: false, reason: "no-current-version" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(manifestUrl, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return { available: false, reason: `http-${res.status}` };
    const m = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const cli = (m?.cli ?? {}) as Record<string, unknown>;
    const latest = (m?.version ?? cli.version) as string | undefined;
    if (!latest || !parseSemver(latest)) return { available: false, reason: "no-version" };
    const minSupported = (m?.minSupported ?? cli.minSupported) as string | undefined;
    return {
      available: compareSemver(currentVersion, latest) < 0,
      required: minSupported ? compareSemver(currentVersion, minSupported) < 0 : false,
      current: currentVersion,
      latest,
      notes: String(m?.notes ?? cli.notes ?? "").slice(0, 400),
      upgrade: String(m?.upgrade ?? cli.upgrade ?? "").slice(0, 400),
      channel: (m?.channel as string | undefined) ?? "stable",
    };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return { available: false, reason: name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** One-line, human-facing summary for the launcher prompt (empty if nothing). */
export function updateBanner(result: UpdateResult | null | undefined): string {
  if (!result?.available) return "";
  const tag = result.required ? "REQUIRED update" : "Update available";
  const notes = result.notes ? ` — ${result.notes}` : "";
  return `${tag}: ${result.current} → ${result.latest}${notes}`;
}
