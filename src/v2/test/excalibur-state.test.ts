import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadExcaliburState,
  scopedStatePath,
  setSelectedContext,
} from "../excalibur/scoped-state.js";
import { safeScopeSegment, type StateScope } from "../state/scope.js";

const scope = (principalHash: string, instanceId: string): StateScope => ({
  principalId: principalHash,
  principalHash,
  instanceId,
  authenticated: true,
});

test("legacy state migrates without mutation into a private principal/instance scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-state-"));
  const legacy = join(dir, "legacy.json");
  const legacyRaw = `${JSON.stringify({ defaultAgent: "aurelius", recentAgents: ["aurelius"] }, null, 2)}\n`;
  await writeFile(legacy, legacyRaw, "utf8");
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(dir, "state") };
  const a = scope("principal-a", "instance-1");
  const b = scope("principal-b", "instance-1");

  const migrated = await loadExcaliburState({ scope: a, env, legacyStatePath: legacy });
  assert.equal(migrated.selectedContext, "operator-local");
  assert.deepEqual(migrated.legacyPreferences, { defaultAgent: "aurelius", recentAgents: ["aurelius"] });
  assert.equal(await readFile(legacy, "utf8"), legacyRaw);
  assert.equal((await stat(scopedStatePath(a, env))).mode & 0o777, 0o600);
  assert.notEqual(scopedStatePath(a, env), scopedStatePath(b, env));

  await setSelectedContext("instance-1", { scope: a, env, legacyStatePath: legacy });
  assert.equal((await loadExcaliburState({ scope: a, env })).selectedContext, "instance-1");
  assert.equal((await loadExcaliburState({ scope: b, env, legacyStatePath: legacy })).selectedContext, "operator-local");
});

test("sanitized instance directory names remain collision resistant", () => {
  assert.notEqual(safeScopeSegment("customer/a"), safeScopeSegment("customer-a"));
});

test("corrupt or foreign session record shapes are discarded on read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-state-corrupt-"));
  const env = { ...process.env, EXCALIBUR_STATE_DIR: join(dir, "state") };
  const currentScope = scope("principal-a", "instance-1");
  const path = scopedStatePath(currentScope, env);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".."), { recursive: true }));
  await writeFile(path, JSON.stringify({
    version: 1,
    selectedContext: "operator-local",
    sessions: [{
      sessionId: "../../other-account",
      provider: "grok-acp",
      nativeSessionId: "../../session",
      model: "grok-4.5",
      contextId: "operator-local",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "closed",
    }],
    receipts: [],
  }));
  assert.equal((await loadExcaliburState({ scope: currentScope, env })).sessions.length, 0);
});
