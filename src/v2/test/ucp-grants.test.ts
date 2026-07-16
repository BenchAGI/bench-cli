import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GrantStore } from "../ucp/grants.js";

const REQUEST_DIGEST = "a".repeat(64);
const SOURCE_RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

test("grants are exact-effect, explicit, owner-private, and expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-grants-"));
  let now = new Date("2026-07-14T12:00:00.000Z");
  const store = new GrantStore(
    { ...process.env, EXCALIBUR_UCP_STATE_DIR: root },
    () => now,
  );
  const grant = await store.issue({
    mode: "publish-draft",
    effectIds: ["test.publish_draft"],
    requestDigest: REQUEST_DIGEST,
    sourceReceiptId: SOURCE_RECEIPT_ID,
    ttlSeconds: 900,
    missionSecretBundle: false,
    purpose: "Publish one reviewed draft PR",
  });
  const auth = await store.authorize("test.publish_draft", ["publish-draft"], [grant.grantId], REQUEST_DIGEST);
  assert.equal(auth.grants[0]?.missionSecretBundle, false);
  await assert.rejects(
    store.authorize("test.publish_draft", ["publish-draft"], [grant.grantId], "b".repeat(64)),
    /explicit publish-draft grant/,
  );
  await assert.rejects(store.authorize("bench.cs.grant", ["mutate-tenant"], [grant.grantId], REQUEST_DIGEST), /explicit mutate-tenant grant/);
  now = new Date("2026-07-14T12:15:01.000Z");
  await assert.rejects(store.authorize("test.publish_draft", ["publish-draft"], [grant.grantId], REQUEST_DIGEST), /missing, expired, or unsafe/);
});

test("grant TTL above fifteen minutes is denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-grants-"));
  await assert.rejects(new GrantStore({ ...process.env, EXCALIBUR_UCP_STATE_DIR: root }).issue({
    mode: "mutate-tenant",
    effectIds: ["bench.cs.grant"],
    requestDigest: REQUEST_DIGEST,
    sourceReceiptId: SOURCE_RECEIPT_ID,
    ttlSeconds: 901,
    missionSecretBundle: false,
    purpose: "test invalid TTL",
  }), /between 1 and 900/);
});

test("durable mission bundles remain disabled without a tamper-resistant broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-grants-"));
  await assert.rejects(new GrantStore({ ...process.env, EXCALIBUR_UCP_STATE_DIR: root }).issue({
    mode: "publish-draft",
    effectIds: ["test.publish_draft"],
    requestDigest: REQUEST_DIGEST,
    sourceReceiptId: SOURCE_RECEIPT_ID,
    ttlSeconds: 60,
    missionSecretBundle: true,
    purpose: "test unavailable bundle",
  }), /tamper-resistant broker/);
});

test("an edited grant cannot widen its original fifteen-minute authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-grants-"));
  const now = new Date("2026-07-14T12:00:00.000Z");
  const store = new GrantStore(
    { ...process.env, EXCALIBUR_UCP_STATE_DIR: root },
    () => now,
  );
  const grant = await store.issue({
    mode: "publish-draft",
    effectIds: ["test.publish_draft"],
    requestDigest: REQUEST_DIGEST,
    sourceReceiptId: SOURCE_RECEIPT_ID,
    ttlSeconds: 60,
    missionSecretBundle: false,
    purpose: "Publish one reviewed draft PR",
  });
  const path = join(root, "state", "grants", `${grant.grantId}.json`);
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.expiresAt = "2099-01-01T00:00:00.000Z";
  await writeFile(path, `${JSON.stringify(edited)}\n`, { mode: 0o600 });
  await assert.rejects(
    store.authorize("test.publish_draft", ["publish-draft"], [grant.grantId], REQUEST_DIGEST),
    /missing, expired, or unsafe/,
  );
});
