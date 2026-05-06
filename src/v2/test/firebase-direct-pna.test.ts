// PNA (Private Network Access) preflight regression for the
// Firebase Direct browser-handoff listener.
//
// Background: Chrome 130+ enforces PNA. When `https://benchagi.com/auth/cli`
// (a public origin) tries to POST to `http://127.0.0.1:<port>` (the
// listener), Chrome sends an additional `OPTIONS` preflight with
// `Access-Control-Request-Private-Network: true`. Without our explicit
// `Access-Control-Allow-Private-Network: true` consent header on the
// preflight response, Chrome blocks the POST before it ever reaches us
// — the user sees "Permission was denied for this request to access the
// loopback address space" and `benchagi auth login` silently times out.
//
// This test pins three behaviors of the listener's OPTIONS handler:
//   1. PNA-requesting preflight from the allowed origin is consented to.
//   2. Non-PNA preflight from the allowed origin is acknowledged WITHOUT
//      advertising PNA support (keep the surface tight).
//   3. PNA-requesting preflight from any other origin is rejected (403),
//      with no consent header — origin gate runs before the PNA branch.
//
// We exercise the real `loginFlowAttempt` so the listener under test is
// the production code path. The test's `openBrowser` callback drives the
// HTTP requests and (for the success cases) POSTs a valid body to
// resolve loginFlowAttempt's outer promise, otherwise the test would
// hang for the listener's full 90s timeout.
//
// Run via the v2 build:
//   npm run build && node --test dist/v2/test/firebase-direct-pna.test.js

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loginFlow } from "../auth/firebase-direct.js";

const ALLOWED_ORIGIN = "https://benchagi.com";
const ATTACKER_ORIGIN = "https://attacker.example.com";

interface PreflightResult {
  status: number;
  headers: Record<string, string>;
}

async function preflight(
  port: number,
  state: string,
  origin: string,
  withPna: boolean,
): Promise<PreflightResult> {
  const url = `http://127.0.0.1:${port}/cli-callback?state=${encodeURIComponent(state)}`;
  const headers: Record<string, string> = {
    Origin: origin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type",
  };
  if (withPna) headers["Access-Control-Request-Private-Network"] = "true";
  const resp = await fetch(url, { method: "OPTIONS", headers });
  const out: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return { status: resp.status, headers: out };
}

async function postValidBody(port: number, state: string): Promise<void> {
  // Resolves loginFlow so the test doesn't hang on the 90s timeout. Body
  // must satisfy the listener's strict field validation in handle().
  const url = `http://127.0.0.1:${port}/cli-callback?state=${encodeURIComponent(state)}`;
  await fetch(url, {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      idToken: "fake-id-token",
      refreshToken: "fake-refresh-token",
      uid: "test-uid",
      email: "test@example.com",
      expiresAt: Date.now() + 3_600_000,
    }),
  });
}

function pickPort(): number {
  // Within the [8000, 10000) range the listener uses; far enough from
  // common dev ports to avoid collisions during local test runs.
  return 8000 + Math.floor(Math.random() * 2_000);
}

async function withListener<T>(
  fn: (port: number, capturedState: string) => Promise<T>,
): Promise<T> {
  let captured = "";
  const port = pickPort();
  const result: { value?: T; error?: unknown } = {};
  // Crank the timeout DOWN so misbehaving tests fail fast. Production
  // default is 90s; we don't need anywhere near that for these tests.
  const flow = loginFlow({
    port,
    timeoutMs: 5_000,
    openBrowser: async (url) => {
      const u = new URL(url);
      captured = u.searchParams.get("state") ?? "";
      try {
        result.value = await fn(port, captured);
      } catch (err) {
        result.error = err;
      } finally {
        // Always resolve loginFlow so the test doesn't hang on the
        // listener timeout. Use the real captured state so the body
        // POST passes the constant-time-equal check.
        try {
          await postValidBody(port, captured);
        } catch {
          // ignore — the listener may already have closed
        }
      }
    },
  });
  await flow.catch(() => {
    // loginFlow may reject if our POST raced with timeout/close. The
    // assertions inside `fn` are what matters.
  });
  if (result.error) throw result.error;
  return result.value as T;
}

test("PNA preflight from allowed origin echoes Access-Control-Allow-Private-Network", async () => {
  const result = await withListener(async (port, state) => {
    return await preflight(port, state, ALLOWED_ORIGIN, /*withPna*/ true);
  });
  assert.equal(result.status, 204);
  assert.equal(result.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(result.headers["access-control-allow-methods"], "POST");
  assert.equal(
    result.headers["access-control-allow-private-network"],
    "true",
    "PNA-requesting preflight from the allowed origin must echo the consent header",
  );
});

test("non-PNA preflight from allowed origin does NOT advertise Allow-Private-Network", async () => {
  const result = await withListener(async (port, state) => {
    return await preflight(port, state, ALLOWED_ORIGIN, /*withPna*/ false);
  });
  assert.equal(result.status, 204);
  assert.equal(result.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(
    result.headers["access-control-allow-private-network"],
    undefined,
    "non-PNA preflight should not opt-in to PNA — keeps the surface tight",
  );
});

test("PNA preflight from non-allowed origin is rejected with 403 and no consent header", async () => {
  const result = await withListener(async (port, state) => {
    return await preflight(port, state, ATTACKER_ORIGIN, /*withPna*/ true);
  });
  assert.equal(result.status, 403);
  assert.equal(
    result.headers["access-control-allow-private-network"],
    undefined,
    "wrong-origin preflight must not echo PNA consent — origin gate runs first",
  );
});
