// `bench link` / `bench relink` — self-serve Aurelius bridge pairing.
//
// Zero-touch: when the CLI is already signed in (Firebase creds present), this
// mints the pairing under that identity — no 8-digit code, no human. A brand-new
// Mac that isn't signed in falls back to the browser login, and an explicit
// `bench link <8-digit-code>` still works via the pairing/complete route.
//
// What this does NOT do: start the long-running chat listener (that's the
// agent-chat-runtime / runtime.py launchd job, deployed separately). This
// registers the Mac as the tenant's active pairing and persists the bridge
// token for that listener to consume, then reports the real bridge state.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { c, println, eprintln } from "../render/ansi.js";
import { loadAccount, resolveApiBase } from "../launcher/account.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { loginFlow } from "../auth/firebase-direct.js";
import { loadOpenClawDeviceIdentity, fingerprintPublicKey } from "../auth/device-identity.js";
import { CLI_VERSION } from "./version.js";
const AURELIUS_DIR = join(homedir(), ".aurelius");
const MACHINE_PATH = join(AURELIUS_DIR, "machine.json");
const BRIDGE_PATH = join(AURELIUS_DIR, "bridge.json");
async function ensureAureliusDir() {
    await mkdir(AURELIUS_DIR, { recursive: true, mode: 0o700 });
    await chmod(AURELIUS_DIR, 0o700).catch(() => { });
}
function sanitizeMachineId(raw) {
    const cleaned = raw
        .replace(/[^A-Za-z0-9._:-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 96);
    return cleaned.length >= 3 ? cleaned : `mac-${randomUUID().slice(0, 8)}`;
}
// Prefer openclaw's device identity (so the bridge shares the gateway's id);
// otherwise persist a stable local id under ~/.aurelius so re-links land on the
// same pairing doc (single-machine policy) instead of spawning new ones.
async function resolveMachineIdentity() {
    const dev = await loadOpenClawDeviceIdentity();
    if (dev) {
        return {
            machineId: sanitizeMachineId(dev.deviceId),
            machineFingerprint: fingerprintPublicKey(dev.publicKeyPem),
        };
    }
    try {
        const saved = JSON.parse(await readFile(MACHINE_PATH, "utf8"));
        if (saved.machineId && saved.machineFingerprint) {
            return { machineId: saved.machineId, machineFingerprint: saved.machineFingerprint };
        }
    }
    catch {
        // generate below
    }
    const machineId = sanitizeMachineId(`mac-${hostname()}-${randomUUID().slice(0, 8)}`);
    const machineFingerprint = randomUUID();
    await ensureAureliusDir();
    await writeFile(MACHINE_PATH, JSON.stringify({ machineId, machineFingerprint }, null, 2), {
        mode: 0o600,
    });
    await chmod(MACHINE_PATH, 0o600).catch(() => { });
    return { machineId, machineFingerprint };
}
async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "error",
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch {
        // non-JSON body
    }
    if (!res.ok) {
        const err = (json ?? {});
        const code = err.code ? ` (${err.code})` : "";
        const msg = err.error || text || `HTTP ${res.status}`;
        throw Object.assign(new Error(`${msg}${code}`), { exitCode: res.status === 401 ? 4 : 1 });
    }
    return json;
}
async function saveBridgeCreds(data) {
    await ensureAureliusDir();
    await writeFile(BRIDGE_PATH, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await chmod(BRIDGE_PATH, 0o600).catch(() => { });
    return BRIDGE_PATH;
}
function readRequiredString(value, field) {
    if (!value || typeof value !== "object") {
        throw Object.assign(new Error("Pairing service returned an invalid response."), { exitCode: 1 });
    }
    const raw = value[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw Object.assign(new Error(`Pairing service response missing ${field}.`), { exitCode: 1 });
    }
    return raw;
}
function parsePairingResult(value) {
    return {
        tenantId: readRequiredString(value, "tenantId"),
        machineId: readRequiredString(value, "machineId"),
        token: readRequiredString(value, "token"),
        expiresAt: readRequiredString(value, "expiresAt"),
    };
}
async function fetchBridgeState(apiBase, token, instanceId) {
    try {
        const qs = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : "";
        const res = await fetch(`${apiBase}/v1/aurelius/bridge/status${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export async function commandLink(args, opts = {}) {
    const account = await loadAccount();
    const apiBase = resolveApiBase(account);
    const codeArg = args.find((a) => /^\d{8}$/.test(a.trim()));
    const { machineId, machineFingerprint } = await resolveMachineIdentity();
    const meta = {
        machineId,
        machineFingerprint,
        displayName: hostname(),
        platform: `${platform()} ${release()}`.slice(0, 80),
        version: CLI_VERSION,
    };
    println(c.dim(opts.relink ? "Re-linking this Mac to your Bench workspace…" : "Linking this Mac to your Bench workspace…"));
    let firebaseToken = null;
    let result;
    if (codeArg) {
        // Fallback path: explicit 8-digit code (fresh Mac / not signed in).
        result = parsePairingResult(await postJson(`${apiBase}/v1/aurelius/bridge/pairing/complete`, {
            code: codeArg,
            ...meta,
        }));
    }
    else {
        // Zero-touch path: pair under the already-signed-in identity.
        firebaseToken = await loadFreshFirebaseIdToken();
        if (!firebaseToken) {
            println(c.dim("Not signed in — opening your browser to sign in to Bench…"));
            try {
                await loginFlow();
            }
            catch (err) {
                eprintln(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}\n` +
                    "Run `benchagi auth login` and retry, or use `bench link <8-digit-code>`.");
                return 1;
            }
            firebaseToken = await loadFreshFirebaseIdToken();
        }
        if (!firebaseToken) {
            eprintln("Could not obtain a Bench sign-in. Use `bench link <8-digit-code>` instead.");
            return 1;
        }
        result = parsePairingResult(await postJson(`${apiBase}/v1/aurelius/bridge/pairing/self`, { ...meta, ...(account?.instanceId ? { instanceId: account.instanceId } : {}) }, { Authorization: `Bearer ${firebaseToken}` }));
    }
    const savedTo = await saveBridgeCreds({ ...result, apiBase });
    println(c.green("✔ This Mac is paired to your Bench workspace."));
    println(c.dim(`  bridge credential → ${savedTo}`));
    // Best-effort: report the real bridge state (needs the signed-in token).
    const token = firebaseToken ?? (await loadFreshFirebaseIdToken());
    const status = token ? await fetchBridgeState(apiBase, token, account?.instanceId) : null;
    if (status?.state === "connected") {
        println(c.green("✔ Aurelius is online."));
    }
    else if (status?.state) {
        println(c.dim(`  bridge state: ${status.state}. It comes online once the local listener picks up the new credential.`));
    }
    return 0;
}
