// Tests for the EADDRINUSE retry-once behavior in firebase-direct
// (V1.1 — Item 6, ADR-002). The full loginFlow needs a real OS
// socket + browser to exercise; these tests target only the
// retry-orchestration helper, which is pure.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAddrInUseError, retryOnAddrInUse, } from "../auth/firebase-direct.js";
function addrInUseError() {
    const err = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8421");
    err.code = "EADDRINUSE";
    return err;
}
test("isAddrInUseError detects code: 'EADDRINUSE'", () => {
    assert.equal(isAddrInUseError(addrInUseError()), true);
    assert.equal(isAddrInUseError(new Error("other")), false);
    assert.equal(isAddrInUseError(null), false);
    assert.equal(isAddrInUseError(undefined), false);
    assert.equal(isAddrInUseError("EADDRINUSE"), false);
});
test("retryOnAddrInUse: first attempt succeeds — no retry", async () => {
    let calls = 0;
    const attempt = async (_opts) => {
        calls += 1;
        return "ok";
    };
    const result = await retryOnAddrInUse(attempt, {});
    assert.equal(result, "ok");
    assert.equal(calls, 1);
});
test("retryOnAddrInUse: EADDRINUSE on first attempt → retries once", async () => {
    let calls = 0;
    const attempt = async (_opts) => {
        calls += 1;
        if (calls === 1)
            throw addrInUseError();
        return "ok";
    };
    const result = await retryOnAddrInUse(attempt, {});
    assert.equal(result, "ok");
    assert.equal(calls, 2);
});
test("retryOnAddrInUse: EADDRINUSE twice → throws (no second retry)", async () => {
    let calls = 0;
    const attempt = async (_opts) => {
        calls += 1;
        throw addrInUseError();
    };
    await assert.rejects(() => retryOnAddrInUse(attempt, {}), /EADDRINUSE/);
    assert.equal(calls, 2);
});
test("retryOnAddrInUse: non-EADDRINUSE error → throws without retry", async () => {
    let calls = 0;
    const attempt = async (_opts) => {
        calls += 1;
        throw new Error("CSRF state mismatch");
    };
    await assert.rejects(() => retryOnAddrInUse(attempt, {}), /CSRF state mismatch/);
    assert.equal(calls, 1);
});
test("retryOnAddrInUse: explicit port + EADDRINUSE → throws without retry", async () => {
    // The caller asked for a specific port; we honor that and don't
    // silently switch ports on collision.
    let calls = 0;
    const attempt = async (_opts) => {
        calls += 1;
        throw addrInUseError();
    };
    await assert.rejects(() => retryOnAddrInUse(attempt, { port: 8421 }), /EADDRINUSE/);
    assert.equal(calls, 1);
});
test("retryOnAddrInUse: retry uses a different port than the first attempt", async () => {
    const portsUsed = [];
    const attempt = async (opts) => {
        portsUsed.push(opts.port);
        if (portsUsed.length === 1)
            throw addrInUseError();
        return "ok";
    };
    await retryOnAddrInUse(attempt, {});
    assert.equal(portsUsed.length, 2);
    // First attempt: caller passed no port (undefined).
    assert.equal(portsUsed[0], undefined);
    // Second attempt: retry layer assigned a fresh random port.
    assert.equal(typeof portsUsed[1], "number");
    assert.ok(portsUsed[1] >= 8000 && portsUsed[1] < 10_000);
});
