import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GateKeeper, type UserPresenceVerifier } from "../ucp/gatekeeper.js";

class FakePresence implements UserPresenceVerifier {
  calls = 0;
  async available(): Promise<boolean> { return true; }
  async verify(): Promise<void> { this.calls += 1; }
}

async function fakeOp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ucp-fake-op-"));
  const path = join(root, "op");
  await writeFile(path, `#!/bin/sh
set -eu
test "$1" = run
shift
case "$1" in --env-file=*) shift ;; *) exit 64 ;; esac
test "$1" = --
shift
IFS='=' read -r name reference <&3
test -n "$reference"
export "$name=synthetic-child-only-secret"
exec "$@"
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("GateKeeper requires user presence then injects a reference into exactly one child environment", async () => {
  const presence = new FakePresence();
  const gatekeeper = new GateKeeper(presence, await fakeOp());
  const result = await gatekeeper.runSecretCommand({
    effectId: "bench.health",
    secretRef: "op://Operator/Bench%20Chassis%20API/api-key",
    envName: "UCP_EFFECT_SECRET",
    purpose: "unit-test health access",
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ named: Boolean(process.env.UCP_EFFECT_SECRET), ambient: Boolean(process.env.UNRELATED_API_TOKEN) }))"],
    env: { ...process.env, UNRELATED_API_TOKEN: "must-not-enter-op-or-child" },
  });
  assert.equal(presence.calls, 1);
  assert.deepEqual(JSON.parse(result.process.stdout), { named: true, ambient: false });
  assert.equal(result.audit.presence, "per_access");
  assert.doesNotMatch(JSON.stringify(result.audit), /synthetic-child-only-secret/);
});
