import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CLI_VERSION } from "../commands/version.js";
import { EXCALIBUR_EXPECTED_DIGESTS } from "../excalibur/contract-baseline.js";
import {
  EXCALIBUR_LAUNCHER_SCHEMA,
  inspectExcaliburLaunchers,
  parseCanonicalLauncherManifest,
  verifyCanonicalLauncherManifest,
} from "../excalibur/launcher-integrity.js";
import {
  EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA,
  runOrchestraCommand,
} from "../excalibur/orchestra-broker.js";

const execFileAsync = promisify(execFile);

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const cliEntry = join(repositoryRoot, "bin", "excalibur.mjs");
const launchCommand = `#!/usr/bin/env bash
RESOURCE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$(cd "$RESOURCE_DIR/../.." && pwd)"
CLI_NODE="$RESOURCE_DIR/runtime/node"
CLI_ENTRY="$RESOURCE_DIR/runtime/cli/bin/excalibur.mjs"
if ! /usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"; then exit 1; fi
if ! "$CLI_NODE" "$CLI_ENTRY" doctor --launch-check; then exit 1; fi
exec "$CLI_NODE" "$CLI_ENTRY"
`;
const launchCommandDigest = createHash("sha256").update(launchCommand).digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalDigest(value: unknown): string {
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

async function writeSyntheticRuntime(resources: string): Promise<string> {
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
  await assert.rejects(
    verifyCanonicalLauncherManifest(path, cliEntry),
    /does not match the manifest-bound sidecar doctor gate/,
  );
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
  await writeFile(
    join(canonical, "Contents", "Resources", "excalibur-launcher.json"),
    JSON.stringify(manifest()),
  );
  await writeFile(join(canonical, "Contents", "Resources", "launch.command"), launchCommand, { mode: 0o755 });
  const inspections = await inspectExcaliburLaunchers({ EXCALIBUR_APP_DIR: root }, bundledEntry);
  assert.equal(inspections.find((item) => item.appPath === canonical)?.classification, "canonical");
  const old = inspections.find((item) => item.appPath === legacy);
  assert.equal(old?.classification, "legacy_or_unverified");
  assert.match(old?.issues.join(" ") || "", /legacy Native\/Aurelius preview/);
});

test("packaged launcher has no PATH or direct-provider fallback and gates every click with doctor", async () => {
  const script = await readFile(join(repositoryRoot, "scripts", "make-excalibur-app.sh"), "utf8");
  assert.match(script, /doctor --launch-check/);
  assert.match(script, /directProviderLaunch: false/);
  assert.match(script, /bin\/excalibur\.mjs/);
  assert.doesNotMatch(script, /command -v excalibur/);
  assert.doesNotMatch(script, /exec (?:grok|claude|codex|benchagi|bench)\b/);
  assert.match(script, /unset EXCALIBUR_ORCHESTRA_CONFIG/);
  assert.match(script, /resolveOrchestraBrokerConfig/);
  assert.match(script, /RUNTIME\/cli\/node_modules/);
  assert.match(script, /codesign --verify --deep --strict/);
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
  const command = await readFile(join(resources, "launch.command"), "utf8");
  const canonicalConfig = await realpath(config);
  assert.match(command, /doctor --launch-check/);
  assert.match(command, new RegExp(`export EXCALIBUR_ORCHESTRA_CONFIG=${canonicalConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await assert.rejects(access(join(resources, "orchestra-config.json")));
  await verifyCanonicalLauncherManifest(
    join(resources, "excalibur-launcher.json"),
    join(resources, "runtime", "cli", "bin", "excalibur.mjs"),
  );

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
