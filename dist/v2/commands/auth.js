// `benchagi auth {login,logout,status}` — SPEC §3 / §4.
import { c, println } from "../render/ansi.js";
import { loginFlow } from "../auth/firebase-direct.js";
import { syncUserProfile } from "../auth/profile-sync.js";
import { deleteCreds, loadCreds } from "../state/keychain.js";
import { clearUserProfile, loadUserProfile } from "../state/user-profile.js";
function accessLabel(level, color) {
    if (!level)
        return "";
    return color ? `${level} (${color})` : level;
}
export async function commandAuthLogin() {
    println(c.dim("Opening browser for Firebase sign-in…"));
    const result = await loginFlow();
    // Fetch the canonical, server-verified profile (name + access tier) so identity
    // is never hand-set. Best-effort: if the profile endpoint isn't reachable yet,
    // sign-in still succeeds — the seat falls back to the email until next sync.
    const profile = await syncUserProfile().catch(() => null);
    if (profile?.displayName) {
        const tier = accessLabel(profile.accessLevel, profile.accessColor);
        println(c.green(`Signed in as ${profile.displayName}${tier ? ` · ${tier}` : ""}`));
    }
    else {
        println(c.green(`Signed in as ${result.email}`));
    }
}
export async function commandAuthLogout() {
    await deleteCreds();
    await clearUserProfile();
    println("Signed out (keychain entry + profile removed)");
}
export async function commandAuthStatus() {
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
