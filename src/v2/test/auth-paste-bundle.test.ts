// Regression for `benchagi auth login --paste` — the escape hatch for when the
// browser isn't on the same machine as the CLI (the loopback handoff to
// 127.0.0.1:<port> can't be reached). It persists the same sign-in bundle the
// auth page produces, reusing the loopback path's validation.
//
// Test isolation: like firebase-direct-pna.test.ts, we NEVER call `saveCreds`
// (it writes the real macOS Keychain). We test the pure validator directly and
// only the error branch of `loginWithPastedCredsBundle`, which rejects before
// it ever reaches `saveCreds`.
//
// Run: npm run build && node --test dist/v2/test/auth-paste-bundle.test.js

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseFirebaseCredsBundle,
  loginWithPastedCredsBundle,
} from "../auth/firebase-direct.js";

const VALID = {
  idToken: "eyJ.fake.jwt",
  refreshToken: "refresh-abc",
  uid: "uid-123",
  email: "kenley@briggsroofing.com",
  expiresAt: 1_900_000_000_000,
};

test("parseFirebaseCredsBundle accepts a complete bundle", () => {
  const result = parseFirebaseCredsBundle(JSON.stringify(VALID));
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(result.creds, VALID);
  }
});

test("parseFirebaseCredsBundle rejects invalid JSON", () => {
  const result = parseFirebaseCredsBundle("not json {");
  assert.deepEqual(result, { kind: "err", error: "invalid JSON" });
});

test("parseFirebaseCredsBundle rejects a bundle missing fields", () => {
  const { refreshToken: _omit, ...partial } = VALID;
  const result = parseFirebaseCredsBundle(JSON.stringify(partial));
  assert.deepEqual(result, { kind: "err", error: "missing fields" });
});

test("parseFirebaseCredsBundle rejects a wrong-typed expiresAt", () => {
  const result = parseFirebaseCredsBundle(JSON.stringify({ ...VALID, expiresAt: "soon" }));
  assert.deepEqual(result, { kind: "err", error: "missing fields" });
});

test("loginWithPastedCredsBundle throws on an invalid bundle (never reaches the keychain)", async () => {
  await assert.rejects(
    () => loginWithPastedCredsBundle("{ not valid"),
    /invalid JSON/,
  );
  await assert.rejects(
    () => loginWithPastedCredsBundle(JSON.stringify({ idToken: "x" })),
    /missing fields/,
  );
});
