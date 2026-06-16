// `bench link` / `bench relink` — front door for self-serve Aurelius bridge pairing.
//
// The device-side lives in ONE place: the `aurelius` bridge CLI (@kestrel-aurelius/chat),
// which owns pairing, the canonical credential (~/.openclaw/agents/aurelius-<principal>/
// bridge-credential.json), and the supervised listener that drives the Mac to `connected`.
// `bench link` just supplies the Bench sign-in and drives it:
//   - zero-touch (default): mint the Firebase ID token, hand it to `aurelius link`.
//   - `bench link <8-digit-code>`: fall back to `aurelius pair <code>` (fresh / not signed in).
// Then it installs + starts the bridge listener.

import { spawnSync } from "node:child_process";

import { c, println, eprintln } from "../render/ansi.js";
import { loadAccount, type Account } from "../launcher/account.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { loginFlow } from "../auth/firebase-direct.js";

function findAurelius(): string | null {
  const result = spawnSync("which", ["aurelius"], { encoding: "utf8" });
  const found = result.status === 0 ? result.stdout.trim() : "";
  return found || null;
}

// Derive a stable, document-safe principal from the signed-in identity so each
// human's pairing lands under aurelius-<principal>. Falls back to the bridge
// CLI's own default ("cory" / AURELIUS_PRINCIPAL) when unknown.
function derivePrincipal(account: Account | null): string | undefined {
  const id = account?.user?.email || account?.user?.preferredName || account?.user?.name || account?.user?.uid;
  if (!id) return undefined;
  const norm = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return norm || undefined;
}

function runAurelius(aurelius: string, args: string[], opts: { input?: string } = {}): number {
  const result = spawnSync(aurelius, args, {
    stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    input: opts.input,
    encoding: "utf8",
  });
  return result.status ?? 1;
}

export async function commandLink(args: string[], opts: { relink?: boolean } = {}): Promise<number> {
  const account = await loadAccount();
  const principal = derivePrincipal(account);
  const principalArgs = principal ? ["--principal", principal] : [];
  const codeArg = args.find((a) => /^\d{8}$/.test(a.trim()));

  const aurelius = findAurelius();
  if (!aurelius) {
    eprintln(
      "The Aurelius bridge CLI ('aurelius') isn't installed on this Mac yet.\n" +
        "It runs the local bridge that keeps your Aurelius reachable. Install it, then re-run `bench link`.\n" +
        "(BenchAGI onboarding ships it — ask your Bench contact if you're unsure.)",
    );
    return 1;
  }

  println(c.dim(opts.relink ? "Re-linking this Mac to your Aurelius…" : "Linking this Mac to your Aurelius…"));

  if (codeArg) {
    const code = runAurelius(aurelius, ["pair", codeArg, ...principalArgs]);
    if (code !== 0) return code;
  } else {
    let token = await loadFreshFirebaseIdToken();
    if (!token) {
      println(c.dim("Not signed in — opening your browser to sign in to Bench…"));
      try {
        await loginFlow();
      } catch (err) {
        eprintln(
          `Sign-in failed: ${err instanceof Error ? err.message : String(err)}\n` +
            "Or pair with a code: bench link <8-digit-code>",
        );
        return 1;
      }
      token = await loadFreshFirebaseIdToken();
    }
    if (!token) {
      eprintln("Could not obtain a Bench sign-in. Use `bench link <8-digit-code>` instead.");
      return 1;
    }
    const instanceArgs = account?.instanceId ? ["--instance", account.instanceId] : [];
    const code = runAurelius(aurelius, ["link", "--id-token", "-", ...instanceArgs, ...principalArgs], {
      input: `${token}\n`,
    });
    if (code !== 0) return code;
  }

  // Install + (re)start the supervised listener so the bridge reaches `connected`.
  const installCode = runAurelius(aurelius, ["bridge", "install", ...principalArgs]);
  if (installCode !== 0) return installCode;
  runAurelius(aurelius, ["bridge", "up"]);
  runAurelius(aurelius, ["bridge", "status", ...principalArgs]);

  println(c.green("✔ Linked. The Aurelius bridge is installed and running."));
  return 0;
}
