// user-profile.ts — the durable, server-verified user identity.
//
// Identity is NOT hand-set: `benchagi auth login` fetches the canonical profile
// (display name + access tier) from the cloud and persists it here, so every seat
// reads the same verified identity. ~/.config/benchagi/user-profile.json sits
// alongside the keychain creds (token) and the account.json (token/instance cfg).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UserProfile {
  uid?: string;
  email?: string;
  displayName?: string;
  /** Permission tier, e.g. "Epic" / "Legendary" (server-resolved from rank). */
  accessLevel?: string;
  /** Tier color, e.g. "Purple" / "Orange". */
  accessColor?: string;
  /** ISO timestamp of the last successful server fetch. */
  verifiedAt?: string;
}

const PROFILE_PATH = join(homedir(), ".config", "benchagi", "user-profile.json");

export function userProfilePath(): string {
  return PROFILE_PATH;
}

export async function loadUserProfile(): Promise<UserProfile | null> {
  try {
    const raw = await readFile(PROFILE_PATH, "utf8");
    const p = JSON.parse(raw) as UserProfile;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await mkdir(dirname(PROFILE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(PROFILE_PATH, JSON.stringify(profile, null, 2), { mode: 0o600 });
}

export async function clearUserProfile(): Promise<void> {
  await rm(PROFILE_PATH, { force: true }).catch(() => {});
}

/** True if the profile was verified within `maxAgeDays` (default 30). */
export function profileIsFresh(profile: UserProfile | null, maxAgeDays = 30): boolean {
  if (!profile?.verifiedAt) return false;
  const ts = Date.parse(profile.verifiedAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= maxAgeDays * 24 * 60 * 60 * 1000;
}
