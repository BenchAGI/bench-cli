import assert from "node:assert/strict";
import { test } from "node:test";
import { __testing } from "../excalibur/cli.js";
test("Excalibur preserves UCP effect and grant flags for the typed subcommand parser", () => {
    const effect = __testing.parseArgs([
        "effect", "worktree.prepare", "--request", "/private/request.json", "--dry-run", "--json",
    ]);
    assert.equal(effect.command, "effect");
    assert.deepEqual(effect.positional, [
        "worktree.prepare", "--request", "/private/request.json", "--dry-run", "--json",
    ]);
    const grant = __testing.parseArgs([
        "grant", "issue", "--mode", "mutate-tenant", "--effect", "bench.cs.grant", "--ttl", "900",
    ]);
    assert.equal(grant.command, "grant");
    assert.deepEqual(grant.positional.slice(0, 3), ["issue", "--mode", "mutate-tenant"]);
});
