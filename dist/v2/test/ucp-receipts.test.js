import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newReceiptId, ReceiptStore, requestDigest } from "../ucp/receipts.js";
import { UCP_SCHEMA_VERSION } from "../ucp/types.js";
function receipt(secret) {
    const now = new Date().toISOString();
    return {
        schemaVersion: UCP_SCHEMA_VERSION,
        receiptId: newReceiptId(),
        effectId: "bench.health",
        effectClass: "bench-read",
        requestDigest: requestDigest({ canary: secret }),
        status: "succeeded",
        dryRun: false,
        startedAt: now,
        completedAt: now,
        principal: "operator",
        capabilityModes: ["observe", "secret-use"],
        grantIds: [],
        secretUses: [{
                reference: "op://Operator/Bench Chassis API/api-key",
                purpose: "authenticated health read",
                presence: "per_access",
                ttlSeconds: 0,
            }],
        summary: "Authenticated health read completed",
        details: { httpStatus: 200 },
        denialCode: null,
    };
}
test("UCP receipts contain a request digest and secret reference, never request secret material", async () => {
    const root = await mkdtemp(join(tmpdir(), "ucp-receipts-"));
    const env = { ...process.env, EXCALIBUR_UCP_STATE_DIR: root };
    const canary = "unit-test-secret-material-do-not-persist";
    const store = new ReceiptStore(env);
    const value = receipt(canary);
    const path = await store.write(value);
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, new RegExp(canary));
    assert.match(raw, /op:\/\/Operator\/Bench Chassis API\/api-key/);
    assert.match(raw, new RegExp(value.requestDigest));
    assert.equal((await stat(path)).mode & 0o077, 0);
});
test("UCP receipt writer rejects secret-bearing detail keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "ucp-receipts-"));
    const value = receipt("not-written");
    value.details = { apiToken: "must-not-write" };
    await assert.rejects(new ReceiptStore({ ...process.env, EXCALIBUR_UCP_STATE_DIR: root }).write(value), /disallowed receipt field/);
});
test("receipt reads reject owner-edited records with invalid provenance timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "ucp-receipts-"));
    const store = new ReceiptStore({ ...process.env, EXCALIBUR_UCP_STATE_DIR: root });
    const value = receipt("not-written");
    value.status = "dry_run";
    value.dryRun = true;
    const path = await store.write(value);
    const edited = JSON.parse(await readFile(path, "utf8"));
    edited.completedAt = "not-a-timestamp";
    await writeFile(path, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await store.list(), []);
});
