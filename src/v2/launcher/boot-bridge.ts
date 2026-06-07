// boot-bridge.ts — play the BenchAGI boot cinematic, which ships as a pure-JS
// asset (dist/v2/assets/boot.mjs) rather than compiled TS. We import it via a
// runtime URL so tsc doesn't try to resolve/typecheck the .mjs. Non-critical:
// any failure is swallowed so a boot hiccup never blocks launch.

type RunBoot = (opts?: { fast?: boolean; motion?: "off" | "on" | "auto" }) => Promise<unknown>;

export async function playBoot(opts: { fast?: boolean; motion?: "off" } = {}): Promise<void> {
  try {
    const href = new URL("../assets/boot.mjs", import.meta.url).href;
    const mod = (await import(href)) as { runBoot?: RunBoot };
    if (mod?.runBoot) await mod.runBoot(opts);
  } catch {
    // boot is presentation only — never block the launcher
  }
}
