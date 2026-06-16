// `bench link` / `bench relink` -- self-serve Aurelius bridge pairing.
//
// The web banner points customers at the `bench` front door. This command pairs
// the local Mac through Bench cloud, then writes the canonical credential that
// the Aurelius bridge listener consumes:
//   ~/.openclaw/agents/aurelius-<principal>/bridge-credential.json
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { c, println, eprintln } from "../render/ansi.js";
import { loadAccount, resolveApiBase } from "../launcher/account.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { loginFlow } from "../auth/firebase-direct.js";
import { fingerprintPublicKey, loadOpenClawDeviceIdentity } from "../auth/device-identity.js";
import { CLI_VERSION } from "./version.js";
const BRIDGE_VERSION = "presence-vault-v1.4";
const BRIDGE_CHANNEL = "vault-chat";
const MACHINE_PATH = join(homedir(), ".config", "benchagi", "aurelius-machine.json");
function normalizePrincipal(principal) {
    return (String(principal || "cory")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "cory");
}
function derivePrincipal(account, loginIdentity) {
    const id = account?.user?.email ||
        loginIdentity?.email ||
        account?.user?.preferredName ||
        account?.user?.name ||
        account?.user?.uid ||
        loginIdentity?.uid;
    return id ? normalizePrincipal(id) : undefined;
}
function sanitizeMachineId(raw) {
    const cleaned = raw
        .replace(/[^A-Za-z0-9._:-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 96);
    return cleaned.length >= 3 ? cleaned : `mac-${randomUUID().slice(0, 8)}`;
}
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
            return {
                machineId: sanitizeMachineId(saved.machineId),
                machineFingerprint: String(saved.machineFingerprint),
            };
        }
    }
    catch {
        // Generate below.
    }
    const machineId = sanitizeMachineId(`mac-${hostname()}-${randomUUID().slice(0, 8)}`);
    const machineFingerprint = randomUUID();
    await mkdir(dirname(MACHINE_PATH), { recursive: true, mode: 0o700 });
    await chmod(dirname(MACHINE_PATH), 0o700).catch(() => { });
    await writeFile(MACHINE_PATH, JSON.stringify({ machineId, machineFingerprint }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(MACHINE_PATH, 0o600).catch(() => { });
    return { machineId, machineFingerprint };
}
function apiUrl(apiBase, path) {
    return `${apiBase.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
function bridgeBaseUrlFromApiBase(apiBase) {
    try {
        const u = new URL(apiBase);
        return `${u.protocol}//${u.host}`;
    }
    catch {
        return "https://benchagi.com";
    }
}
async function postJson(fetchImpl, url, body, headers = {}) {
    const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "error",
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    }
    catch {
        // Non-JSON body.
    }
    if (!res.ok) {
        const err = (json ?? {});
        const code = err.code ? ` (${err.code})` : "";
        const msg = err.error || text.slice(0, 600) || `HTTP ${res.status}`;
        throw Object.assign(new Error(`${msg}${code}`), { exitCode: res.status === 401 ? 4 : 1 });
    }
    return json;
}
function readRequiredString(value, field) {
    if (!value || typeof value !== "object") {
        throw new Error("Pairing service returned an invalid response.");
    }
    const raw = value[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error(`Pairing service response missing ${field}.`);
    }
    return raw;
}
function parsePairingResult(value) {
    return {
        tenantId: readRequiredString(value, "tenantId"),
        principalUid: readRequiredString(value, "principalUid"),
        machineId: readRequiredString(value, "machineId"),
        token: readRequiredString(value, "token"),
        expiresAt: readRequiredString(value, "expiresAt"),
    };
}
function bridgeAgentDir({ principal, homeDir = homedir() }) {
    return join(homeDir, ".openclaw", "agents", `aurelius-${normalizePrincipal(principal)}`);
}
function bridgeCredentialPath({ principal, homeDir = homedir() }) {
    return join(bridgeAgentDir({ principal, homeDir }), "bridge-credential.json");
}
async function writeBridgeCredential(credential, opts = {}) {
    const dir = bridgeAgentDir({ principal: credential.principal, homeDir: opts.homeDir });
    const target = bridgeCredentialPath({ principal: credential.principal, homeDir: opts.homeDir });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => { });
    await writeFile(tmp, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
    await chmod(target, 0o600);
    return target;
}
function buildCredential(params) {
    const now = params.now.toISOString();
    return {
        version: BRIDGE_VERSION,
        principal: normalizePrincipal(params.principal),
        bridgeBaseUrl: params.bridgeBaseUrl,
        token: params.result.token,
        tenantId: params.result.tenantId,
        uid: params.result.principalUid,
        machineId: params.result.machineId,
        hostname: hostname(),
        channel: BRIDGE_CHANNEL,
        issuedAt: now,
        pairedAt: now,
        expiresAt: params.result.expiresAt,
        seedUrl: null,
        cloudBrainBaseUrl: null,
    };
}
function principalForCredential(account, loginIdentity, result) {
    return derivePrincipal(account, loginIdentity) ?? normalizePrincipal(result.principalUid);
}
function exitCodeFor(error) {
    const exitCode = error?.exitCode;
    return typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : 1;
}
export async function commandLink(args, opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        eprintln("This Node runtime does not provide fetch. Upgrade Node.js to 20 or newer.");
        return 1;
    }
    let account = opts.account !== undefined ? opts.account : await loadAccount();
    let loginIdentity = null;
    const apiBase = resolveApiBase(account);
    const codeArg = args.find((a) => /^\d{8}$/.test(a.trim()));
    const machine = opts.machineIdentity ?? (await resolveMachineIdentity());
    const meta = {
        machineId: machine.machineId,
        machineFingerprint: machine.machineFingerprint,
        displayName: hostname(),
        platform: `${platform()} ${release()}`.slice(0, 80),
        version: CLI_VERSION,
    };
    println(c.dim(opts.relink ? "Re-linking this Mac to your Aurelius..." : "Linking this Mac to your Aurelius..."));
    try {
        let result;
        if (codeArg) {
            result = parsePairingResult(await postJson(fetchImpl, apiUrl(apiBase, "/v1/aurelius/bridge/pairing/complete"), {
                code: codeArg,
                ...meta,
            }));
        }
        else {
            const loadToken = opts.loadFirebaseToken ?? loadFreshFirebaseIdToken;
            let token = opts.firebaseToken ?? (await loadToken());
            if (!token) {
                println(c.dim("Not signed in - opening your browser to sign in to Bench..."));
                try {
                    const login = opts.login ?? loginFlow;
                    loginIdentity = await login();
                    if (opts.account === undefined) {
                        account = (await loadAccount()) ?? account;
                    }
                }
                catch (err) {
                    eprintln(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}\n` +
                        "Or pair with a code: bench link <8-digit-code>");
                    return 1;
                }
                token = opts.firebaseToken ?? (await loadToken());
            }
            if (!token) {
                eprintln("Could not obtain a Bench sign-in. Use `bench link <8-digit-code>` instead.");
                return 1;
            }
            result = parsePairingResult(await postJson(fetchImpl, apiUrl(apiBase, "/v1/aurelius/bridge/pairing/self"), {
                ...meta,
                ...(account?.instanceId ? { instanceId: account.instanceId } : {}),
            }, { Authorization: `Bearer ${token}` }));
        }
        const principal = principalForCredential(account, loginIdentity, result);
        const credentialPath = await writeBridgeCredential(buildCredential({
            result,
            principal,
            bridgeBaseUrl: bridgeBaseUrlFromApiBase(apiBase),
            now: opts.now?.() ?? new Date(),
        }), { homeDir: opts.homeDir });
        println(c.green("Linked. The Aurelius bridge credential is installed."));
        println(c.dim(`  credential -> ${credentialPath}`));
        println(c.dim("  The bridge listener will connect once it is running."));
        return 0;
    }
    catch (err) {
        eprintln(`Pairing failed: ${err instanceof Error ? err.message : String(err)}`);
        return exitCodeFor(err);
    }
}
export const __testing = {
    bridgeAgentDir,
    bridgeBaseUrlFromApiBase,
    bridgeCredentialPath,
    normalizePrincipal,
    parsePairingResult,
    sanitizeMachineId,
};
