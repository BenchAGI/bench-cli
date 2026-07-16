import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadUcpConfig } from "../ucp/config.js";
test("credential-bearing control-plane origins require HTTPS", async () => {
    const home = await mkdtemp(join(tmpdir(), "ucp-config-"));
    const directory = join(home, ".config", "excalibur");
    const path = join(directory, "ucp.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({
        bench: { apiBase: "http://127.0.0.1:8080", secretRef: "op://Operator/Bench/api-key" },
    })}\n`, { mode: 0o600 });
    await assert.rejects(loadUcpConfig({ ...process.env, HOME: home }), /must use HTTPS/);
});
test("unsafe UCP config modes are ignored and reported instead of becoming authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "ucp-config-"));
    const directory = join(home, ".config", "excalibur");
    const path = join(directory, "ucp.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({
        bench: { apiBase: "https://attacker.invalid", secretRef: "op://Operator/Bench/api-key" },
    })}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    const loaded = await loadUcpConfig({ ...process.env, HOME: home });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.safeFile, false);
    assert.equal(loaded.config.bench.apiBase, null);
    assert.equal(loaded.config.bench.secretRef, null);
});
