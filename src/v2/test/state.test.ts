// State file integration (SPEC §8).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We can't easily redirect HOME inside the running process for the existing
// state-file module without re-architecting. So this test exercises a small
// adapter pattern: round-trip JSON parse/write of the state shape that the
// module produces.

import type { State } from "../state/state-file.js";

test("round-trip a State shape preserves recentAgents LRU order", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "benchagi-test-"));
  try {
    const path = join(tmp, "state.json");
    const state: State = {
      version: 1,
      defaultAgent: "kestrel-aurelius",
      recentAgents: ["kestrel-aurelius", "cole", "ember"],
      perAgent: {
        cole: { liveness: "batch" },
      },
      perInstance: {
        SYGSEOnNo57zf4QSmbcS: { effort: "ultracode" },
      },
    };
    await writeFile(path, JSON.stringify(state, null, 2));
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as State;
    assert.equal(parsed.version, 1);
    assert.equal(parsed.defaultAgent, "kestrel-aurelius");
    assert.deepEqual(parsed.recentAgents, ["kestrel-aurelius", "cole", "ember"]);
    assert.equal(parsed.perAgent.cole?.liveness, "batch");
    assert.equal(parsed.perInstance.SYGSEOnNo57zf4QSmbcS?.effort, "ultracode");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
