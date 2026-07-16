import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSeatPacket, readFrozenPacket, validateSeatPacket, writeFrozenPacket } from "../ucp/packet.js";
import { requestDigest } from "../ucp/receipts.js";
function boundedInput() {
    return {
        goal: "Implement the typed health-card vertical slice and its tests.",
        repoPaths: ["/private/work/bench-cli"],
        nonGoals: ["Do not merge, deploy, send, or access credentials."],
        proof: ["Run npm test and report the bounded result."],
        maxFiles: 8,
    };
}
test("bounded seat packet freezes with effects none, credentials forbidden, and a verified digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ucp-packet-"));
    const path = join(root, "packet.json");
    const packet = createSeatPacket(boundedInput());
    assert.equal(packet.effects, "none");
    assert.equal(packet.credentials, "forbidden");
    await writeFrozenPacket(path, packet);
    assert.deepEqual(await readFrozenPacket(path), packet);
    assert.equal((await stat(path)).mode & 0o077, 0);
});
test("discussion of protected commands is allowed while effect and credential fields remain impossible", () => {
    const packet = createSeatPacket({
        ...boundedInput(),
        goal: "Document why gh pr create is forbidden from an effects-none seat.",
        proof: ["Explain why git push origin main must remain outside this packet."],
    });
    assert.match(packet.goal, /gh pr create/);
    assert.match(packet.proof[0] || "", /git push/);
    assert.equal(packet.effects, "none");
    assert.throws(() => createSeatPacket({ ...boundedInput(), repoPaths: ["/Users/operator/.ssh"] }), /credential or key-store/);
    assert.throws(() => createSeatPacket({ ...boundedInput(), credentials: ["op://vault/item/field"] }), /unsupported fields/);
    assert.throws(() => createSeatPacket({ ...boundedInput(), effects: "mail.send" }), /unsupported fields/);
    assert.throws(() => createSeatPacket({ ...boundedInput(), maxFiles: 500 }), /1 to 50/);
});
test("frozen packet validation accepts documentary prose but rechecks structural locks and expiry", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const packet = createSeatPacket(boundedInput(), now);
    const rehash = (value) => {
        const { packetDigest: _oldDigest, ...unsigned } = value;
        return { ...value, packetDigest: requestDigest(unsigned) };
    };
    const documentary = rehash({ ...packet, goal: "Document why git push origin main is forbidden." });
    assert.equal(validateSeatPacket(documentary, now).goal, documentary.goal);
    assert.throws(() => validateSeatPacket(rehash({ ...packet, effects: "mail.send" }), now), /schema is invalid/);
    assert.throws(() => validateSeatPacket(rehash({ ...packet, expiresAt: "not-a-date" }), now), /invalid or expired/);
    assert.throws(() => validateSeatPacket(rehash({ ...packet, expiresAt: "2099-01-01T00:00:00.000Z" }), now), /exceeds the next 24 hours/);
});
