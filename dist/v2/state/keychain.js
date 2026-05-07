// Keychain wrapper — ADR-003.
// keytar with a degraded encrypted-file fallback when libsecret missing
// on Linux. Mac always has Keychain available.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
const SERVICE = "benchagi-cli";
const ACCOUNT = "firebase";
const FALLBACK_DIR = join(homedir(), ".config", "benchagi");
const FALLBACK_PATH = join(FALLBACK_DIR, "secrets.bin");
const FALLBACK_SALT_PATH = join(FALLBACK_DIR, "secrets.salt");
let keytarLoad = null;
async function loadKeytar() {
    if (!keytarLoad) {
        keytarLoad = async () => {
            try {
                const mod = await import("keytar");
                // Touch a method to trigger native binding load.
                await mod.findCredentials(SERVICE).catch(() => null);
                return mod;
            }
            catch {
                return null;
            }
        };
    }
    return keytarLoad();
}
async function fallbackKey() {
    await mkdir(FALLBACK_DIR, { recursive: true, mode: 0o700 });
    let salt;
    try {
        const raw = await readFile(FALLBACK_SALT_PATH);
        salt = Buffer.from(raw);
    }
    catch {
        salt = randomBytes(16);
        await writeFile(FALLBACK_SALT_PATH, salt, { mode: 0o600 });
    }
    // Per-machine derivation; not real security, just light obfuscation.
    return scryptSync(homedir() + ":" + process.platform, salt, 32);
}
async function fallbackWrite(data) {
    await mkdir(FALLBACK_DIR, { recursive: true, mode: 0o700 });
    const key = await fallbackKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([iv, tag, enc]);
    await writeFile(FALLBACK_PATH, out, { mode: 0o600 });
    await chmod(FALLBACK_PATH, 0o600).catch(() => { });
}
async function fallbackRead() {
    try {
        const buf = await readFile(FALLBACK_PATH);
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const enc = buf.subarray(28);
        const key = await fallbackKey();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
        return dec.toString("utf8");
    }
    catch {
        return null;
    }
}
async function fallbackDelete() {
    const { unlink } = await import("node:fs/promises");
    await unlink(FALLBACK_PATH).catch(() => { });
}
export async function saveCreds(creds) {
    const json = JSON.stringify(creds);
    const keytar = await loadKeytar();
    if (keytar) {
        try {
            await keytar.setPassword(SERVICE, ACCOUNT, json);
            return;
        }
        catch {
            // Fall through to encrypted-file fallback.
        }
    }
    await fallbackWrite(json);
}
export async function loadCreds() {
    const keytar = await loadKeytar();
    if (keytar) {
        try {
            const v = await keytar.getPassword(SERVICE, ACCOUNT);
            if (v)
                return JSON.parse(v);
        }
        catch {
            // Fall through.
        }
    }
    const v = await fallbackRead();
    return v ? JSON.parse(v) : null;
}
export async function deleteCreds() {
    const keytar = await loadKeytar();
    if (keytar) {
        try {
            await keytar.deletePassword(SERVICE, ACCOUNT);
        }
        catch {
            // ignore
        }
    }
    await fallbackDelete();
}
