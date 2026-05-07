// State file integration (SPEC §8).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("round-trip a State shape preserves recentAgents LRU order", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "benchagi-test-"));
    try {
        const path = join(tmp, "state.json");
        const state = {
            version: 1,
            defaultAgent: "kestrel-aurelius",
            recentAgents: ["kestrel-aurelius", "cole", "ember"],
            perAgent: {
                cole: { liveness: "batch" },
            },
        };
        await writeFile(path, JSON.stringify(state, null, 2));
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.defaultAgent, "kestrel-aurelius");
        assert.deepEqual(parsed.recentAgents, ["kestrel-aurelius", "cole", "ember"]);
        assert.equal(parsed.perAgent.cole?.liveness, "batch");
    }
    finally {
        await rm(tmp, { recursive: true, force: true });
    }
});
