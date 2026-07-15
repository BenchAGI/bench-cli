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

test("active protected intent and unsupported schema fields remain denied", () => {
  assert.throws(() => createSeatPacket({ ...boundedInput(), goal: "Deploy this and merge the PR." }), /protected external effect/);
  assert.throws(() => createSeatPacket({ ...boundedInput(), proof: ["git push origin main"] }), /protected external effect/);
  assert.throws(() => createSeatPacket({ ...boundedInput(), repoPaths: ["/Users/operator/.ssh"] }), /credential or key-store/);
  assert.throws(() => createSeatPacket({ ...boundedInput(), credentials: ["op://vault/item/field"] }), /unsupported fields/);
  assert.throws(() => createSeatPacket({ ...boundedInput(), maxFiles: 500 }), /1 to 50/);
});

test("frozen packet validation rechecks intent and the bounded expiry after digest verification", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  const packet = createSeatPacket(boundedInput(), now);
  const rehash = <T extends typeof packet>(value: T): T => {
    const { packetDigest: _oldDigest, ...unsigned } = value;
    return { ...value, packetDigest: requestDigest(unsigned) };
  };
  assert.throws(
    () => validateSeatPacket(rehash({ ...packet, goal: "git push origin main" }), now),
    /protected external effect/,
  );
  assert.throws(
    () => validateSeatPacket(rehash({ ...packet, expiresAt: "not-a-date" }), now),
    /invalid or expired/,
  );
  assert.throws(
    () => validateSeatPacket(rehash({ ...packet, expiresAt: "2099-01-01T00:00:00.000Z" }), now),
    /exceeds the next 24 hours/,
  );
});
