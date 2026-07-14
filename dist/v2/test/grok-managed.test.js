import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectGrokProvider, prepareManagedGrok } from "../excalibur/grok-managed.js";
test("managed Grok preflight creates an isolated deny-by-default provider home", async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-grok-"));
    const sourceHome = join(root, "source-grok");
    const binDir = join(sourceHome, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir, { recursive: true }));
    const binary = join(binDir, "grok");
    await writeFile(binary, "#!/bin/sh\necho 'grok 9.9.9 (test)'\n", "utf8");
    await chmod(binary, 0o755);
    await writeFile(join(sourceHome, "models_cache.json"), JSON.stringify({ models: [{ id: "grok-4.5" }] }));
    await writeFile(join(sourceHome, "auth.json"), JSON.stringify({ access_token: "secret" }), { mode: 0o600 });
    const env = {
        ...process.env,
        EXCALIBUR_GROK_SOURCE_HOME: sourceHome,
        EXCALIBUR_GROK_BIN: binary,
        EXCALIBUR_STATE_DIR: join(root, "state"),
    };
    const scope = {
        principalId: "principal-a",
        principalHash: "principal-a",
        instanceId: "instance-1",
        authenticated: true,
    };
    const inspection = await inspectGrokProvider({ env, scope });
    assert.equal(inspection.ready, true);
    const prepared = await prepareManagedGrok({ env, scope });
    const config = await readFile(join(prepared.managedHome, "config.toml"), "utf8");
    const requirements = await readFile(join(prepared.managedHome, "requirements.toml"), "utf8");
    assert.match(config, /enabled = false/);
    assert.match(config, /action = "deny", tool = "bash"/);
    assert.match(requirements, /disable_bypass_permissions_mode = true/);
    assert.equal((await stat(join(prepared.managedHome, "auth.json"))).mode & 0o777, 0o600);
    assert.notEqual(prepared.managedHome, sourceHome);
});
