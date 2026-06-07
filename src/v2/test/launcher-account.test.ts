// Tests for launcher account/env-token handling.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasAccountToken, loadAccount, resolveApiBase } from "../launcher/account.js";

test("loadAccount recognizes env API token without requiring BENCHAGI_API_BASE", async () => {
  const account = await loadAccount({ BENCHAGI_TOKEN: "bench_test_token" } as NodeJS.ProcessEnv);
  assert.equal(account?.token, "bench_test_token");
  assert.equal(resolveApiBase(account, {} as NodeJS.ProcessEnv), "https://benchagi.com/api");
  assert.equal(hasAccountToken(account), true);
});

test("hasAccountToken rejects missing and blank tokens", () => {
  assert.equal(hasAccountToken(null), false);
  assert.equal(hasAccountToken({ token: "" }), false);
  assert.equal(hasAccountToken({ token: "   " }), false);
});
