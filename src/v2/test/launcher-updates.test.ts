// Tests for the launcher's update-on-launch client.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkForUpdate, compareSemver, parseSemver, updateBanner } from "../launcher/updates.js";

test("parseSemver tolerates v-prefix and rejects junk", () => {
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("1.0.0"), [1, 0, 0]);
  assert.equal(parseSemver("garbage"), null);
});

test("compareSemver orders and never false-positives on junk", () => {
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("2.0.0", "2.0.0"), 0);
  assert.equal(compareSemver("1.0.0", "not-a-version"), 0);
});

test("checkForUpdate is graceful with no manifest URL", async () => {
  const r = await checkForUpdate({ currentVersion: "1.0.0", manifestUrl: undefined });
  assert.equal(r.available, false);
  assert.equal(r.reason, "no-manifest-url");
});

test("checkForUpdate never throws when the endpoint is unreachable", async () => {
  const r = await checkForUpdate({ currentVersion: "1.0.0", manifestUrl: "http://127.0.0.1:1/manifest.json", timeoutMs: 600 });
  assert.equal(r.available, false);
  assert.ok(r.reason);
});

test("updateBanner renders only when available", () => {
  assert.equal(updateBanner({ available: false }), "");
  assert.match(updateBanner({ available: true, current: "1.0.0", latest: "1.1.0", notes: "x" }), /1\.0\.0 → 1\.1\.0/);
  assert.match(updateBanner({ available: true, required: true, current: "1.0.0", latest: "2.0.0" }), /REQUIRED/);
});
