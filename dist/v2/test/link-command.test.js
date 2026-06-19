import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandLink, __testing } from "../commands/link.js";
const MACHINE = {
    machineId: "mac-test-123",
    machineFingerprint: "fingerprint-test-abc",
};
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
function parseFetchCall(input, init) {
    const headers = new Headers(init?.headers);
    return {
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        authorization: headers.get("authorization"),
    };
}
async function tempHome() {
    return await mkdtemp(path.join(os.tmpdir(), "benchagi-link-test-"));
}
test("benchagi link <code> stores canonical private bridge credentials", async () => {
    const homeDir = await tempHome();
    const calls = [];
    const fetchImpl = async (input, init) => {
        const call = parseFetchCall(input, init);
        calls.push(call);
        return jsonResponse({
            tenantId: "tenant-code",
            principalUid: "uid-code",
            machineId: call.body.machineId,
            token: "bridge-token-code",
            expiresAt: "2027-01-01T00:00:00.000Z",
        });
    };
    try {
        const code = await commandLink(["12345678"], {
            account: {
                apiBase: "http://127.0.0.1:31337/api",
                user: { email: "jim.johnson@example.com" },
            },
            fetchImpl,
            homeDir,
            machineIdentity: MACHINE,
            now: () => new Date("2026-06-16T12:00:00.000Z"),
        });
        assert.equal(code, 0);
        assert.equal(calls.length, 1);
        assert.equal(new URL(calls[0].url).pathname, "/api/v1/aurelius/bridge/pairing/complete");
        assert.equal(calls[0].authorization, null);
        assert.equal(calls[0].body.code, "12345678");
        assert.equal(calls[0].body.machineId, MACHINE.machineId);
        assert.equal(calls[0].body.machineFingerprint, MACHINE.machineFingerprint);
        const principal = "jim.johnson-example.com";
        const credentialPath = __testing.bridgeCredentialPath({ principal, homeDir });
        const credential = JSON.parse(await readFile(credentialPath, "utf8"));
        assert.equal(credential.version, "presence-vault-v1.4");
        assert.equal(credential.principal, principal);
        assert.equal(credential.bridgeBaseUrl, "http://127.0.0.1:31337");
        assert.equal(credential.tenantId, "tenant-code");
        assert.equal(credential.uid, "uid-code");
        assert.equal(credential.machineId, MACHINE.machineId);
        assert.equal(credential.token, "bridge-token-code");
        assert.equal(credential.channel, "vault-chat");
        assert.equal(credential.issuedAt, "2026-06-16T12:00:00.000Z");
        assert.equal((await stat(__testing.bridgeAgentDir({ principal, homeDir }))).mode & 0o777, 0o700);
        assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    }
    finally {
        await rm(homeDir, { recursive: true, force: true });
    }
});
test("benchagi link zero-touch posts a Firebase token and instance id", async () => {
    const homeDir = await tempHome();
    const calls = [];
    const fetchImpl = async (input, init) => {
        const call = parseFetchCall(input, init);
        calls.push(call);
        return jsonResponse({
            tenantId: "tenant-self",
            principalUid: "uid-self",
            machineId: call.body.machineId,
            token: "bridge-token-self",
            expiresAt: "2027-02-01T00:00:00.000Z",
        });
    };
    try {
        const code = await commandLink([], {
            account: {
                apiBase: "http://127.0.0.1:4242/api",
                instanceId: "inst-1",
                user: { email: "operator@example.com" },
            },
            firebaseToken: "firebase-id-token",
            fetchImpl,
            homeDir,
            machineIdentity: MACHINE,
        });
        assert.equal(code, 0);
        assert.equal(calls.length, 1);
        assert.equal(new URL(calls[0].url).pathname, "/api/v1/aurelius/bridge/pairing/self");
        assert.equal(calls[0].authorization, "Bearer firebase-id-token");
        assert.equal(calls[0].body.instanceId, "inst-1");
        assert.equal(calls[0].body.machineId, MACHINE.machineId);
        const credential = JSON.parse(await readFile(__testing.bridgeCredentialPath({ principal: "operator-example.com", homeDir }), "utf8"));
        assert.equal(credential.token, "bridge-token-self");
        assert.equal(credential.tenantId, "tenant-self");
        assert.equal(credential.uid, "uid-self");
    }
    finally {
        await rm(homeDir, { recursive: true, force: true });
    }
});
test("benchagi link refuses malformed pairing responses without writing credentials", async () => {
    const homeDir = await tempHome();
    const fetchImpl = async () => jsonResponse({
        tenantId: "tenant-bad",
        principalUid: "uid-bad",
        machineId: MACHINE.machineId,
        expiresAt: "2027-01-01T00:00:00.000Z",
    });
    try {
        const code = await commandLink(["12345678"], {
            account: { apiBase: "http://127.0.0.1:5252/api", user: { email: "bad@example.com" } },
            fetchImpl,
            homeDir,
            machineIdentity: MACHINE,
        });
        assert.equal(code, 1);
        assert.equal(existsSync(__testing.bridgeCredentialPath({ principal: "bad-example.com", homeDir })), false);
    }
    finally {
        await rm(homeDir, { recursive: true, force: true });
    }
});
