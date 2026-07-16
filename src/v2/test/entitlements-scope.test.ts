import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EntitlementResolutionError,
  resolveEntitledAgents,
} from "../launcher/entitlements.js";
import type { Account } from "../launcher/account.js";
import type { StateScope } from "../state/scope.js";

const account: Account = { apiBase: "https://example.test", token: "bench_test", instanceId: "instance-1" };
const scope = (principalHash: string): StateScope => ({
  principalId: principalHash,
  principalHash,
  instanceId: "instance-1",
  authenticated: true,
});

test("authenticated entitlements use only an exact fresh scoped cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-entitlements-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: dir };
  const principalA = scope("principal-a");
  const liveFetch: typeof fetch = async () => new Response(JSON.stringify({
    instanceId: "instance-1",
    agents: [{ agentId: "excalibur-conductor", name: "Excalibur", role: "conductor", active: true }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  const live = await resolveEntitledAgents({
    env,
    account,
    firebaseToken: null,
    scope: principalA,
    fetchFn: liveFetch,
    now: () => 1_000_000,
  });
  assert.equal(live?.[0]?.agentId, "excalibur-conductor");

  const failedFetch: typeof fetch = async () => new Response("unavailable", { status: 503 });
  const cached = await resolveEntitledAgents({
    env,
    account,
    firebaseToken: null,
    scope: principalA,
    fetchFn: failedFetch,
    now: () => 1_001_000,
  });
  assert.equal(cached?.[0]?.agentId, "excalibur-conductor");

  await assert.rejects(
    resolveEntitledAgents({
      env,
      account,
      firebaseToken: null,
      scope: scope("principal-b"),
      fetchFn: failedFetch,
      now: () => 1_001_000,
    }),
    EntitlementResolutionError,
  );
});

test("an instance-mismatched entitlement response fails closed even when authenticated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-entitlements-mismatch-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: dir };
  await assert.rejects(
    resolveEntitledAgents({
      env,
      account,
      firebaseToken: null,
      scope: scope("principal-a"),
      fetchFn: async () => new Response(JSON.stringify({ instanceId: "instance-2", agents: [] }), { status: 200 }),
    }),
    /does not match/,
  );
});

test("authenticated entitlements reject a response that omits its server-bound instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-entitlements-unscoped-"));
  await assert.rejects(
    resolveEntitledAgents({
      env: { ...process.env, EXCALIBUR_STATE_DIR: dir },
      account,
      firebaseToken: null,
      scope: scope("principal-a"),
      fetchFn: async () => new Response(JSON.stringify({ agents: [] }), { status: 200 }),
    }),
    /explicitly bind entitlements/,
  );
});

test("authenticated entitlements refuse an unbound instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-entitlements-unbound-"));
  await assert.rejects(
    resolveEntitledAgents({
      env: { ...process.env, EXCALIBUR_STATE_DIR: dir },
      account: { ...account, instanceId: undefined },
      firebaseToken: null,
      scope: { ...scope("principal-a"), instanceId: "unbound" },
      fetchFn: async () => new Response(JSON.stringify({ instanceId: "instance-1", agents: [] }), { status: 200 }),
    }),
    /not bound/,
  );
});
