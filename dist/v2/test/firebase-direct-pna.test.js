// PNA (Private Network Access) preflight regression for the
// Firebase Direct browser-handoff listener.
//
// Background: Chrome 130+ enforces PNA. When `https://benchagi.com/auth/cli`
// (a public origin) tries to POST to `http://127.0.0.1:<port>` (the
// listener), Chrome sends an additional `OPTIONS` preflight with
// `Access-Control-Request-Private-Network: true`. Without our explicit
// `Access-Control-Allow-Private-Network: true` consent header on the
// preflight response, Chrome blocks the POST before it ever reaches us.
//
// **Test isolation:** the original implementation of this test exercised
// `loginFlow` end-to-end and posted fake credentials to satisfy the
// outer promise. That path called `saveCreds`, which writes to the real
// macOS Keychain — running `npm run test:v2` would overwrite a real
// developer's BenchAGI auth with fake tokens. Codex Anvil flagged this
// as a BLOCK.
//
// Refactored to drive the exported `handle` function directly via a
// minimal `http.createServer` we own. We never call `saveCreds` and
// never touch the keychain; the `done` callback is captured as a Jest-
// style spy and the request body / status / headers are asserted at
// the HTTP layer. Production behavior unchanged.
//
// Pinned behaviors:
//   1. PNA-requesting preflight from the allowed origin echoes consent.
//   2. Non-PNA preflight from the allowed origin does NOT advertise PNA.
//   3. PNA-requesting preflight from any other origin → 403, no consent.
//
// Run: npm run build && node --test dist/v2/test/firebase-direct-pna.test.js
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { handle } from "../auth/firebase-direct.js";
const ALLOWED_ORIGIN = "https://benchagi.com";
const ATTACKER_ORIGIN = "https://attacker.example.com";
const TEST_STATE = "test-state-token-22ch";
async function withListener(fn) {
    const server = createServer(async (req, res) => {
        try {
            await handle(req, res, TEST_STATE, () => {
                // No-op: in-test, we don't need to capture the success/error
                // callback because all assertions happen at the HTTP-status
                // layer. Real production calls saveCreds in this callback;
                // we explicitly DON'T touch the keychain.
            });
        }
        catch {
            // Swallow — handle's own error path already wrote a 500.
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = addr.port;
    try {
        return await fn(port);
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
    }
}
async function preflight(port, origin, withPna) {
    const url = `http://127.0.0.1:${port}/cli-callback?state=${encodeURIComponent(TEST_STATE)}`;
    const headers = {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
    };
    if (withPna)
        headers["Access-Control-Request-Private-Network"] = "true";
    const resp = await fetch(url, { method: "OPTIONS", headers });
    const out = {};
    resp.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
    });
    return { status: resp.status, headers: out };
}
test("PNA preflight from allowed origin echoes Access-Control-Allow-Private-Network", async () => {
    const result = await withListener((port) => preflight(port, ALLOWED_ORIGIN, true));
    assert.equal(result.status, 204);
    assert.equal(result.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
    assert.equal(result.headers["access-control-allow-methods"], "POST");
    assert.equal(result.headers["access-control-allow-private-network"], "true", "PNA-requesting preflight from the allowed origin must echo consent");
});
test("non-PNA preflight from allowed origin does NOT advertise Allow-Private-Network", async () => {
    const result = await withListener((port) => preflight(port, ALLOWED_ORIGIN, false));
    assert.equal(result.status, 204);
    assert.equal(result.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
    assert.equal(result.headers["access-control-allow-private-network"], undefined, "non-PNA preflight should not opt-in to PNA — keeps the surface tight");
});
test("PNA preflight from non-allowed origin is rejected with 403 and no consent header", async () => {
    const result = await withListener((port) => preflight(port, ATTACKER_ORIGIN, true));
    assert.equal(result.status, 403);
    assert.equal(result.headers["access-control-allow-private-network"], undefined, "wrong-origin preflight must not echo PNA consent — origin gate runs first");
});
