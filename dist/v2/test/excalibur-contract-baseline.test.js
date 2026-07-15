import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXCALIBUR_ACTION_CAPABILITY_IDS, EXCALIBUR_ACTION_EXECUTOR_IDS, EXCALIBUR_CONTRACT_BASELINE, EXCALIBUR_EXPECTED_DIGESTS, EXCALIBUR_VIEW_CAPABILITY_IDS, } from "../excalibur/contract-baseline.js";
import { EXCALIBUR_CANONICAL_EXECUTOR_BY_ACTION, EXCALIBUR_DRAFT_PR_ACTION_ID, EXCALIBUR_DRAFT_PR_EXECUTOR_ID, } from "../excalibur/http-transport.js";
test("checked-in Excalibur contract baseline is complete and digest-pinned", () => {
    assert.equal(EXCALIBUR_CONTRACT_BASELINE.protocolVersion, "excalibur-control.v1");
    assert.equal(EXCALIBUR_CONTRACT_BASELINE.schemaVersion, "1.0.0");
    assert.match(EXCALIBUR_CONTRACT_BASELINE.sourceMirrorDigest, /^[a-f0-9]{64}$/);
    for (const digest of Object.values(EXCALIBUR_EXPECTED_DIGESTS)) {
        assert.match(digest, /^[a-f0-9]{64}$/);
    }
    assert.equal(new Set(EXCALIBUR_VIEW_CAPABILITY_IDS).size, EXCALIBUR_VIEW_CAPABILITY_IDS.length);
    assert.deepEqual(EXCALIBUR_ACTION_CAPABILITY_IDS, [
        "sales.whitespace.generate",
        "github.draft_pr.publish.v1",
    ]);
    assert.equal(Object.isFrozen(EXCALIBUR_ACTION_EXECUTOR_IDS), true);
    assert.deepEqual(EXCALIBUR_ACTION_EXECUTOR_IDS, {
        "sales.whitespace.generate": "bench.whitespace.field-only.v1",
        "github.draft_pr.publish.v1": "excalibur.sidecar.github-draft-pr.v1",
    });
    assert.equal(EXCALIBUR_CANONICAL_EXECUTOR_BY_ACTION, EXCALIBUR_ACTION_EXECUTOR_IDS);
    assert.equal(EXCALIBUR_DRAFT_PR_EXECUTOR_ID, EXCALIBUR_ACTION_EXECUTOR_IDS[EXCALIBUR_DRAFT_PR_ACTION_ID]);
});
test("generated CLI baseline has no drift from the canonical monorepo mirror", async (context) => {
    const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
    const mirror = process.env.EXCALIBUR_CONTRACT_MIRROR || resolve(repositoryRoot, "../excalibur-one-surface-mono/packages/excalibur-control-contracts/generated/excalibur-control-contracts.mjs");
    try {
        await access(mirror);
    }
    catch {
        context.skip("set EXCALIBUR_CONTRACT_MIRROR in standalone CI to enable cross-repository drift proof");
        return;
    }
    const exitCode = await new Promise((resolveExit, reject) => {
        const child = spawn(process.execPath, [
            resolve(repositoryRoot, "scripts/generate-excalibur-contract-baseline.mjs"),
            "--check",
            "--mirror",
            mirror,
        ], { cwd: repositoryRoot, stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", resolveExit);
    });
    assert.equal(exitCode, 0, "regenerate the CLI baseline from the canonical generated mirror");
});
