import { loadCreds, saveCreds } from "../state/keychain.js";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
function resolveFirebaseApiKey() {
    return (process.env.BENCHAGI_FIREBASE_API_KEY ||
        process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
        process.env.FIREBASE_API_KEY ||
        null);
}
function isUsableToken(creds, now = Date.now()) {
    return creds.expiresAt > now + REFRESH_SKEW_MS;
}
async function refreshCreds(creds, apiKey) {
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
    });
    const res = await fetch(`${SECURE_TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });
    const payload = (await res.json().catch(() => null));
    if (!res.ok || !payload?.id_token || !payload.refresh_token || !payload.expires_in) {
        throw new Error(`Firebase token refresh failed with HTTP ${res.status}`);
    }
    const expiresInMs = Math.max(0, Number(payload.expires_in) || 0) * 1000;
    return {
        idToken: payload.id_token,
        refreshToken: payload.refresh_token,
        uid: payload.user_id || creds.uid,
        email: creds.email,
        expiresAt: Date.now() + expiresInMs,
    };
}
/**
 * Load a Firebase ID token for cloud-bound CLI calls. The token is opaque to
 * the gateway; it is forwarded only to Bench cloud.
 */
export async function loadFreshFirebaseIdToken() {
    const creds = await loadCreds();
    if (!creds) {
        return null;
    }
    if (isUsableToken(creds)) {
        return creds.idToken;
    }
    const apiKey = resolveFirebaseApiKey();
    if (!apiKey) {
        return creds.expiresAt > Date.now() ? creds.idToken : null;
    }
    try {
        const refreshed = await refreshCreds(creds, apiKey);
        await saveCreds(refreshed);
        return refreshed.idToken;
    }
    catch {
        return creds.expiresAt > Date.now() ? creds.idToken : null;
    }
}
export const __testing = {
    isUsableToken,
    resolveFirebaseApiKey,
};
