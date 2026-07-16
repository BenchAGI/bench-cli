import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CLI_VERSION } from "../commands/version.js";
import { EXCALIBUR_EXPECTED_DIGESTS } from "../excalibur/contract-baseline.js";
import { EXCALIBUR_LAUNCHER_SCHEMA, inspectExcaliburLaunchers, parseCanonicalLauncherManifest, verifyBundledRuntimeClosure, verifyCanonicalLauncherManifest, } from "../excalibur/launcher-integrity.js";
import { EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA, runOrchestraCommand, } from "../excalibur/orchestra-broker.js";
const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const cliEntry = join(repositoryRoot, "bin", "excalibur.mjs");
const launchCommand = `#!/bin/bash
RESOURCE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$(cd "$RESOURCE_DIR/../.." && pwd)"
CLI_NODE="$RESOURCE_DIR/runtime/node"
CLI_ENTRY="$RESOURCE_DIR/runtime/cli/bin/excalibur.mjs"
if ! /usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"; then exit 1; fi
if ! "$CLI_NODE" "$CLI_ENTRY" doctor --launch-check; then exit 1; fi
exec "$CLI_NODE" "$CLI_ENTRY"
`;
const launchCommandDigest = createHash("sha256").update(launchCommand).digest("hex");
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function canonicalDigest(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function manifest() {
    return {
        schemaVersion: EXCALIBUR_LAUNCHER_SCHEMA,
        surface: "excalibur-one-surface",
        cliVersion: CLI_VERSION,
        cliEntry: "runtime/cli/bin/excalibur.mjs",
        nodePath: "runtime/node",
        launchCommandDigest,
        requiredDigests: { ...EXCALIBUR_EXPECTED_DIGESTS },
        healthGate: "doctor --launch-check",
        bundleIntegrityGate: "codesign --verify --deep --strict",
        selfContainedRuntime: true,
        sidecarRequired: true,
        directProviderLaunch: false,
    };
}
async function writeSyntheticRuntime(resources) {
    const bin = join(resources, "runtime", "cli", "bin");
    await mkdir(bin, { recursive: true });
    const entry = join(bin, "excalibur.mjs");
    const node = join(resources, "runtime", "node");
    await writeFile(entry, "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(entry, 0o755);
    await chmod(node, 0o755);
    return await realpath(entry);
}
async function createAuditableRuntime(prefix) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const resources = join(root, "Excalibur One Surface.app", "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeSyntheticRuntime(resources);
    return { root, runtime: join(resources, "runtime") };
}
test("bundled runtime closure permits relative internal node_modules links", async () => {
    const { runtime } = await createAuditableRuntime("excalibur-runtime-links-");
    const packageBin = join(runtime, "cli", "node_modules", "fixture", "bin");
    const dotBin = join(runtime, "cli", "node_modules", ".bin");
    await Promise.all([mkdir(packageBin, { recursive: true }), mkdir(dotBin, { recursive: true })]);
    await writeFile(join(packageBin, "fixture.js"), "export {};\n", { mode: 0o644 });
    await symlink("../fixture/bin/fixture.js", join(dotBin, "fixture"));
    const verified = await verifyBundledRuntimeClosure(runtime);
    assert.equal(verified.symlinkCount, 1);
});
test("bundled runtime closure rejects absolute, escaping, chained, and dangling links", async (t) => {
    await t.test("absolute", async () => {
        const { runtime } = await createAuditableRuntime("excalibur-runtime-absolute-");
        await symlink(process.execPath, join(runtime, "cli", "absolute-link"));
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /absolute symlink/);
    });
    await t.test("relative escape", async () => {
        const { root, runtime } = await createAuditableRuntime("excalibur-runtime-escape-");
        const outside = join(root, "outside.js");
        const linkPath = join(runtime, "cli", "escaping-link");
        await writeFile(outside, "outside\n");
        await symlink(relative(dirname(linkPath), outside), linkPath);
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /lexically escaping symlink/);
    });
    await t.test("canonical chain escape", async () => {
        const { root, runtime } = await createAuditableRuntime("excalibur-runtime-chain-");
        const outside = join(root, "outside.js");
        const chainTarget = join(runtime, "cli", "chain-target");
        const chainEntry = join(runtime, "cli", "chain-entry");
        await writeFile(outside, "outside\n");
        await symlink(relative(dirname(chainTarget), outside), chainTarget);
        await symlink("chain-target", chainEntry);
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /escaping symlink/);
    });
    await t.test("dangling", async () => {
        const { runtime } = await createAuditableRuntime("excalibur-runtime-dangling-");
        await symlink("missing-target", join(runtime, "cli", "dangling-link"));
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /broken or escaping symlink/);
    });
});
test("bundled Node and CLI entry must be sealed regular single-link files", async (t) => {
    await t.test("mutable Node", async () => {
        const { runtime } = await createAuditableRuntime("excalibur-runtime-mutable-");
        await chmod(join(runtime, "node"), 0o777);
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /non-mutable, single-link regular file/);
    });
    await t.test("symlinked Node", async () => {
        const { runtime } = await createAuditableRuntime("excalibur-runtime-node-link-");
        const node = join(runtime, "node");
        await unlink(node);
        await symlink("cli/bin/excalibur.mjs", node);
        await assert.rejects(verifyBundledRuntimeClosure(runtime));
    });
    await t.test("hard-linked entry", async () => {
        const { runtime } = await createAuditableRuntime("excalibur-runtime-hardlink-");
        const entry = join(runtime, "cli", "bin", "excalibur.mjs");
        await link(entry, join(runtime, "cli", "bin", "entry-alias.mjs"));
        await assert.rejects(verifyBundledRuntimeClosure(runtime), /single-link regular file/);
    });
});
test("canonical launcher manifest binds exact CLI, digests, sidecar gate, and no provider fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-launcher-"));
    const resources = join(root, "Excalibur One Surface.app", "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    const bundledEntry = await writeSyntheticRuntime(resources);
    const path = join(resources, "excalibur-launcher.json");
    await writeFile(join(resources, "launch.command"), launchCommand, { mode: 0o755 });
    await writeFile(path, JSON.stringify(manifest()), { mode: 0o644 });
    const verified = await verifyCanonicalLauncherManifest(path, bundledEntry);
    assert.equal(verified.directProviderLaunch, false);
    assert.equal(verified.healthGate, "doctor --launch-check");
    assert.throws(() => parseCanonicalLauncherManifest({
        ...manifest(),
        directProviderLaunch: true,
    }), /does not match the canonical CLI/);
    assert.throws(() => parseCanonicalLauncherManifest({
        ...manifest(),
        requiredDigests: { ...EXCALIBUR_EXPECTED_DIGESTS, manifest: "0".repeat(64) },
    }), /does not match the canonical CLI/);
    await writeFile(join(resources, "launch.command"), "#!/bin/sh\nexec grok\n", { mode: 0o755 });
    await assert.rejects(verifyCanonicalLauncherManifest(path, cliEntry), /does not match the manifest-bound sidecar doctor gate/);
});
test("launcher discovery calls the old CLI Preview noncanonical and recognizes only sealed bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-apps-"));
    const legacy = join(root, "Excalibur CLI Preview.app");
    const canonical = join(root, "Excalibur One Surface.app");
    await Promise.all([
        mkdir(join(legacy, "Contents", "Resources"), { recursive: true }),
        mkdir(join(canonical, "Contents", "Resources"), { recursive: true }),
    ]);
    const bundledEntry = await writeSyntheticRuntime(join(canonical, "Contents", "Resources"));
    await writeFile(join(canonical, "Contents", "Resources", "excalibur-launcher.json"), JSON.stringify(manifest()));
    await writeFile(join(canonical, "Contents", "Resources", "launch.command"), launchCommand, { mode: 0o755 });
    const inspections = await inspectExcaliburLaunchers({ EXCALIBUR_APP_DIR: root }, bundledEntry);
    assert.equal(inspections.find((item) => item.appPath === canonical)?.classification, "canonical");
    const old = inspections.find((item) => item.appPath === legacy);
    assert.equal(old?.classification, "legacy_or_unverified");
    assert.match(old?.issues.join(" ") || "", /legacy Native\/Aurelius preview/);
});
test("packaged launcher has no PATH or direct-provider fallback and gates every click with doctor", async () => {
    const script = await readFile(join(repositoryRoot, "scripts", "make-excalibur-app.sh"), "utf8");
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /<<LAUNCH\n#!\/bin\/bash\n/);
    assert.match(script, /doctor --launch-check/);
    assert.match(script, /directProviderLaunch: false/);
    assert.match(script, /bin\/excalibur\.mjs/);
    assert.doesNotMatch(script, /command -v excalibur/);
    assert.doesNotMatch(script, /exec (?:grok|claude|codex|benchagi|bench)\b/);
    assert.match(script, /unset EXCALIBUR_ORCHESTRA_CONFIG/);
    assert.match(script, /resolveOrchestraBrokerConfig/);
    assert.match(script, /RUNTIME\/cli\/node_modules/);
    assert.match(script, /codesign --verify --deep --strict/);
    assert.match(script, /verifyBundledRuntimeClosure/);
    assert.match(script, /mktemp -d "\$APP_DIR\/\.excalibur-app-stage\.XXXXXX"/);
    assert.doesNotMatch(script, /codesign --force --deep --sign - "\$APP"[^\n]*\|\| true/);
    const signAt = script.indexOf('/usr/bin/codesign --force --deep --sign - "$APP"');
    const stagedVerifyAt = script.indexOf('/usr/bin/codesign --verify --deep --strict "$APP"');
    const moveAt = script.indexOf('if ! mv "$APP" "$TARGET_APP"');
    assert.ok(signAt >= 0 && stagedVerifyAt > signAt && moveAt > stagedVerifyAt);
});
test("packager rejects a symlinked CLI_NODE before executing or copying it", {
    skip: process.platform !== "darwin",
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-symlinked-node-"));
    const nodeLink = join(root, "node-link");
    await symlink(process.execPath, nodeLink);
    await assert.rejects(execFileAsync("/bin/bash", [join(repositoryRoot, "scripts", "make-excalibur-app.sh")], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            EXCALIBUR_APP_DIR: join(root, "apps"),
            EXCALIBUR_CLI_NODE: nodeLink,
            EXCALIBUR_CLI_ENTRY: cliEntry,
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    }), /EXCALIBUR_CLI_NODE must not be a symlink/);
});
test("packager rejects mutable and multiply-linked CLI_NODE inputs before execution", {
    skip: process.platform !== "darwin",
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-unsafe-node-"));
    const mutableNode = join(root, "mutable-node");
    await writeFile(mutableNode, "#!/bin/sh\nexit 99\n", { mode: 0o777 });
    await chmod(mutableNode, 0o777);
    const invoke = async (nodePath) => await execFileAsync("/bin/bash", [join(repositoryRoot, "scripts", "make-excalibur-app.sh")], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            EXCALIBUR_APP_DIR: join(root, "apps"),
            EXCALIBUR_CLI_NODE: nodePath,
            EXCALIBUR_CLI_ENTRY: cliEntry,
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    });
    await assert.rejects(invoke(mutableNode), /must not be group\/world writable/);
    const linkedNode = join(root, "linked-node");
    const linkedAlias = join(root, "linked-node-alias");
    await writeFile(linkedNode, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await chmod(linkedNode, 0o755);
    await link(linkedNode, linkedAlias);
    await assert.rejects(invoke(linkedNode), /must be a single-link file/);
});
test("staged canonical app path-binds a validated orchestra config without copying it", {
    skip: process.platform !== "darwin",
}, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "excalibur-staged-app-")));
    const packageDirectory = join(root, "pattern-a-package");
    const appDirectory = join(root, "apps");
    const stateDirectory = join(root, "state");
    const broker = join(packageDirectory, "pattern-a-broker");
    const config = join(packageDirectory, "orchestra-config.json");
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(stateDirectory, { mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const resourceSetDigest = "e".repeat(64);
    const attested = {
        schema: "excalibur-pattern-a-publication-verifier-preflight-result-v1",
        available: true,
        stateRootRealpath: await realpath(stateDirectory),
        resourceSetDigest,
    };
    const preflight = JSON.stringify({ ...attested, attestationDigest: canonicalDigest(attested) })
        .replace(/'/g, `'"'"'`);
    const brokerBytes = `#!/bin/sh
if [ "$1" = "status" ] && [ "$#" -eq 1 ]; then
  cat >/dev/null
  printf '%s\\n' '${preflight}'
else
  printf '%s\\n' '{"schemaVersion":"excalibur.pattern-a-broker-result.v1","missionId":"mission-stage","missionDigest":"${"d".repeat(64)}","state":"ready","receiptCounts":{"total":2}}'
fi
`;
    await writeFile(broker, brokerBytes, { mode: 0o700 });
    await chmod(broker, 0o700);
    await writeFile(config, JSON.stringify({
        schemaVersion: EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA,
        brokerExecutable: broker,
        brokerSha256: createHash("sha256").update(brokerBytes).digest("hex"),
        resourceSetDigest,
        stateRoot: await realpath(stateDirectory),
    }), { mode: 0o600 });
    await execFileAsync("/bin/bash", [join(repositoryRoot, "scripts", "make-excalibur-app.sh")], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            EXCALIBUR_APP_DIR: appDirectory,
            EXCALIBUR_CLI_NODE: process.execPath,
            EXCALIBUR_CLI_ENTRY: cliEntry,
            EXCALIBUR_ORCHESTRA_CONFIG: config,
        },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    const app = join(appDirectory, "Excalibur One Surface.app");
    const resources = join(app, "Contents", "Resources");
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const bundledNodeInfo = await lstat(join(resources, "runtime", "node"));
    const bundledEntryInfo = await lstat(join(resources, "runtime", "cli", "bin", "excalibur.mjs"));
    assert.equal(bundledNodeInfo.isFile(), true);
    assert.equal(bundledNodeInfo.isSymbolicLink(), false);
    assert.equal(bundledNodeInfo.nlink, 1);
    assert.equal(bundledEntryInfo.isFile(), true);
    assert.equal(bundledEntryInfo.isSymbolicLink(), false);
    assert.equal(bundledEntryInfo.nlink, 1);
    const command = await readFile(join(resources, "launch.command"), "utf8");
    assert.match(command, /^#!\/bin\/bash\n/);
    const canonicalConfig = await realpath(config);
    assert.match(command, /doctor --launch-check/);
    assert.match(command, new RegExp(`export EXCALIBUR_ORCHESTRA_CONFIG=${canonicalConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await assert.rejects(access(join(resources, "orchestra-config.json")));
    await verifyCanonicalLauncherManifest(join(resources, "excalibur-launcher.json"), join(resources, "runtime", "cli", "bin", "excalibur.mjs"));
    const lines = await runOrchestraCommand(["status", "mission-stage"], {
        env: {
            HOME: root,
            PATH: process.env.PATH,
            EXCALIBUR_ORCHESTRA_CONFIG: canonicalConfig,
        },
    });
    assert.match(lines.join("\n"), /mission-stage · ready/);
    assert.match(lines.join("\n"), /total 2/);
});
