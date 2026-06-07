// profile-sync.ts — fetch the canonical, server-verified user profile after login.
//
// `GET <apiBase>/cli/user-profile` (Bearer = Firebase ID token) returns the user's
// display name + access tier, resolved server-side from the authoritative source
// (Firestore user doc + rank). We persist it so every seat reads a VERIFIED identity
// instead of a hand-set account.json. Graceful: any failure (endpoint not deployed
// yet, offline, expired token) returns null and never throws.

import { loadAccount, resolveApiBase } from "../launcher/account.js";
import { loadFreshFirebaseIdToken } from "./firebase-token.js";
import { saveUserProfile, type UserProfile } from "../state/user-profile.js";

const DEFAULT_TIMEOUT = 4000;

interface ProfileResponse {
  uid?: unknown;
  email?: unknown;
  displayName?: unknown;
  accessLevel?: unknown;
  accessColor?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export async function syncUserProfile(timeoutMs = DEFAULT_TIMEOUT): Promise<UserProfile | null> {
  const token = await loadFreshFirebaseIdToken().catch(() => null);
  if (!token) return null; // not logged in → nothing to verify

  const account = await loadAccount().catch(() => null);
  const apiBase = resolveApiBase(account); // https-enforced (except localhost)
  const url = `${apiBase.replace(/\/+$/, "")}/cli/user-profile`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: "error", // a 30x must not silently re-source identity cross-origin
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as ProfileResponse | null;
    if (!data) return null;
    const profile: UserProfile = {
      uid: str(data.uid),
      email: str(data.email),
      displayName: str(data.displayName),
      accessLevel: str(data.accessLevel),
      accessColor: str(data.accessColor),
      verifiedAt: new Date().toISOString(),
    };
    await saveUserProfile(profile);
    return profile;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
