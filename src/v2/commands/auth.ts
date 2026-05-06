// `benchagi auth {login,logout,status}` — SPEC §3 / §4.

import { c, println } from "../render/ansi.js";
import { loginFlow } from "../auth/firebase-direct.js";
import { deleteCreds, loadCreds } from "../state/keychain.js";

export async function commandAuthLogin(): Promise<void> {
  println(c.dim("Opening browser for Firebase sign-in…"));
  const result = await loginFlow();
  println(c.green(`Signed in as ${result.email}`));
}

export async function commandAuthLogout(): Promise<void> {
  await deleteCreds();
  println("Signed out (keychain entry removed)");
}

export async function commandAuthStatus(): Promise<void> {
  const creds = await loadCreds();
  if (!creds) {
    println(c.dim("not signed in"));
    return;
  }
  const expiresIn = creds.expiresAt - Date.now();
  if (expiresIn <= 0) {
    println(c.yellow(`signed in as ${creds.email} (token expired)`));
  } else {
    const mins = Math.round(expiresIn / 60_000);
    println(`signed in as ${c.cyan(creds.email)} (token valid for ${mins}m)`);
  }
}
