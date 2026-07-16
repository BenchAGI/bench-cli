import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GateKeeper } from "../ucp/gatekeeper.js";
import { collectSessionHealthCard } from "../ucp/health.js";

class MetadataOnlyGateKeeper extends GateKeeper {
  override async status(): Promise<{ installed: boolean; userPresence: boolean }> {
    return { installed: true, userPresence: true };
  }
}

test("boot health uses metadata/public probes and never invokes ambient gh or OpenClaw auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "ucp-health-"));
  const bin = join(home, "bin");
  await mkdir(bin, { mode: 0o700 });
  for (const name of ["gh", "openclaw"]) {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nprintf called >${join(home, `${name}-called`)}\n`, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const card = await collectSessionHealthCard({
    env: { ...process.env, HOME: home, PATH: bin },
    gatekeeper: new MetadataOnlyGateKeeper(),
    grants: { getOpen: async () => [] } as never,
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  await assert.rejects(access(join(home, "gh-called")));
  await assert.rejects(access(join(home, "openclaw-called")));
  assert.ok(card.blockers.includes("openclaw.gateway"));
  assert.ok(card.blockers.includes("github.user"));
  assert.match(card.lines.find((line) => line.id === "openclaw.gateway")?.summary || "", /identity\/auth not consumed/);
});
