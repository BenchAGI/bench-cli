// `benchagi auth {login,logout,status}` — SPEC §3 / §4.

import { c, println } from "../render/ansi.js";
import { loginFlow, loginWithPastedCredsBundle } from "../auth/firebase-direct.js";
import { syncUserProfile } from "../auth/profile-sync.js";
import { deleteCreds, loadCreds } from "../state/keychain.js";
import { clearUserProfile, loadUserProfile } from "../state/user-profile.js";

function accessLabel(level?: string, color?: string): string {
  if (!level) return "";
  return color ? `${level} (${color})` : level;
}

async function readAllStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return data;
}

export async function commandAuthLogin(opts: { paste?: boolean } = {}): Promise<void> {
  // `--paste` escape hatch: when the browser isn't on this machine (remote /
  // screen-shared / headless), the loopback handoff can't complete. Sign in on
  // any browser, copy the bundle the auth page shows, and paste it here.
  if (opts.paste) {
    println(
      c.dim(
        "Sign in at https://benchagi.com/auth/cli in any browser, copy the sign-in bundle it shows, then paste it here and press Ctrl-D:",
      ),
    );
    const raw = await readAllStdin();
    if (!raw.trim()) {
      println(c.yellow("No bundle pasted — nothing to do."));
      return;
    }
    const result = await loginWithPastedCredsBundle(raw);
    const pastedProfile = await syncUserProfile().catch(() => null);
    if (pastedProfile?.displayName) {
      const tier = accessLabel(pastedProfile.accessLevel, pastedProfile.accessColor);
      println(c.green(`Signed in as ${pastedProfile.displayName}${tier ? ` · ${tier}` : ""}`));
    } else {
      println(c.green(`Signed in as ${result.email}`));
    }
    return;
  }
  println(c.dim("Opening browser for Firebase sign-in…"));
  const result = await loginFlow();
  // Fetch the canonical, server-verified profile (name + access tier) so identity
  // is never hand-set. Best-effort: if the profile endpoint isn't reachable yet,
  // sign-in still succeeds — the seat falls back to the email until next sync.
  const profile = await syncUserProfile().catch(() => null);
  if (profile?.displayName) {
    const tier = accessLabel(profile.accessLevel, profile.accessColor);
    println(c.green(`Signed in as ${profile.displayName}${tier ? ` · ${tier}` : ""}`));
  } else {
    println(c.green(`Signed in as ${result.email}`));
  }
}

export async function commandAuthLogout(): Promise<void> {
  await deleteCreds();
  await clearUserProfile();
  println("Signed out (keychain entry + profile removed)");
}

export async function commandAuthStatus(): Promise<void> {
  const creds = await loadCreds();
  if (!creds) {
    println(c.dim("not signed in"));
    return;
  }
  const profile = await loadUserProfile();
  const who = profile?.displayName || creds.email;
  const tier = accessLabel(profile?.accessLevel, profile?.accessColor);
  const expiresIn = creds.expiresAt - Date.now();
  const tokenNote = expiresIn <= 0 ? c.yellow("token expired") : `token valid for ${Math.round(expiresIn / 60_000)}m`;
  println(`signed in as ${c.cyan(who)}${tier ? ` · ${tier}` : ""} (${tokenNote})`);
}
