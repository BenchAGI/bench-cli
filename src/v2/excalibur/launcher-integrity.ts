import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CLI_VERSION } from "../commands/version.js";
import { EXCALIBUR_EXPECTED_DIGESTS } from "./contract-baseline.js";

export const EXCALIBUR_LAUNCHER_SCHEMA = "excalibur.canonical-launcher.v1" as const;
export const EXCALIBUR_CANONICAL_APP_NAME = "Excalibur One Surface.app" as const;

export type CanonicalLauncherManifest = {
  schemaVersion: typeof EXCALIBUR_LAUNCHER_SCHEMA;
  surface: "excalibur-one-surface";
  cliVersion: string;
  cliEntry: "runtime/cli/bin/excalibur.mjs";
  nodePath: "runtime/node";
  launchCommandDigest: string;
  requiredDigests: { protocol: string; manifest: string; routing: string };
  healthGate: "doctor --launch-check";
  bundleIntegrityGate: "codesign --verify --deep --strict";
  selfContainedRuntime: true;
  sidecarRequired: true;
  directProviderLaunch: false;
};

export type LauncherInspection = {
  appPath: string;
  manifestPath: string;
  classification: "canonical" | "legacy_or_unverified" | "invalid";
  issues: string[];
};

export type BundledRuntimeClosure = {
  runtimeRoot: string;
  nodeSha256: string;
  cliEntrySha256: string;
  symlinkCount: number;
};

export type ExpectedBundledRuntimeDigests = {
  nodeSha256: string;
  cliEntrySha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseCanonicalLauncherManifest(value: unknown): CanonicalLauncherManifest {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "surface", "cliVersion", "cliEntry", "nodePath",
    "launchCommandDigest", "requiredDigests", "healthGate", "bundleIntegrityGate",
    "selfContainedRuntime", "sidecarRequired", "directProviderLaunch",
  ]) || value.schemaVersion !== EXCALIBUR_LAUNCHER_SCHEMA
      || value.surface !== "excalibur-one-surface"
      || value.cliVersion !== CLI_VERSION
      || value.cliEntry !== "runtime/cli/bin/excalibur.mjs"
      || value.nodePath !== "runtime/node"
      || typeof value.launchCommandDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.launchCommandDigest)
      || !isRecord(value.requiredDigests)
      || !exactKeys(value.requiredDigests, ["protocol", "manifest", "routing"])
      || value.requiredDigests.protocol !== EXCALIBUR_EXPECTED_DIGESTS.protocol
      || value.requiredDigests.manifest !== EXCALIBUR_EXPECTED_DIGESTS.manifest
      || value.requiredDigests.routing !== EXCALIBUR_EXPECTED_DIGESTS.routing
      || value.healthGate !== "doctor --launch-check"
      || value.bundleIntegrityGate !== "codesign --verify --deep --strict"
      || value.selfContainedRuntime !== true
      || value.sidecarRequired !== true
      || value.directProviderLaunch !== false) {
    throw new Error("launcher manifest does not match the canonical CLI, contract digests, and sidecar-only launch policy");
  }
  return value as CanonicalLauncherManifest;
}

async function readPrivateBoundedJson(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > 32 * 1024) {
      throw new Error("launcher manifest is not a bounded regular file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximum) {
      throw new Error("launcher command is not a bounded regular file");
    }
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function insideOrEqual(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot)
    && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function hashSealedRuntimeFile(path: string, label: string, maximum: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximum
        || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
      throw new Error(`${label} must be a bounded, executable, non-mutable, single-link regular file`);
    }
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Verifies the copied launcher closure before it is signed. Relative links such
 * as node_modules/.bin entries are allowed only when their final realpath stays
 * inside the copied runtime; absolute, broken, and escaping links are rejected.
 */
export async function verifyBundledRuntimeClosure(
  runtimeRoot: string,
  expected?: ExpectedBundledRuntimeDigests,
): Promise<BundledRuntimeClosure> {
  if (!isAbsolute(runtimeRoot) || /[\u0000-\u001f\u007f]/.test(runtimeRoot)) {
    throw new Error("bundled runtime root must be an absolute path");
  }
  const rootInfo = await lstat(runtimeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("bundled runtime root must be a real directory");
  }
  const canonicalRoot = await realpath(runtimeRoot);
  const lexicalRoot = resolve(runtimeRoot);
  const nodePath = join(runtimeRoot, "node");
  const cliEntryPath = join(runtimeRoot, "cli", "bin", "excalibur.mjs");
  const [nodeSha256, cliEntrySha256] = await Promise.all([
    hashSealedRuntimeFile(nodePath, "bundled Node runtime", 512 * 1024 * 1024),
    hashSealedRuntimeFile(cliEntryPath, "bundled CLI entry", 16 * 1024 * 1024),
  ]);
  if (expected && (nodeSha256 !== expected.nodeSha256 || cliEntrySha256 !== expected.cliEntrySha256)) {
    throw new Error("bundled Node or CLI entry bytes do not match the canonical source copy");
  }

  let visited = 0;
  let symlinkCount = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > 250_000) throw new Error("bundled runtime closure exceeds the audit entry bound");
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        symlinkCount += 1;
        const linkTarget = await readlink(path);
        if (isAbsolute(linkTarget)) {
          throw new Error(`bundled runtime contains an absolute symlink: ${path}`);
        }
        const lexicalTarget = resolve(dirname(path), linkTarget);
        if (!insideOrEqual(lexicalRoot, lexicalTarget)) {
          throw new Error(`bundled runtime contains a lexically escaping symlink: ${path}`);
        }
        const resolvedTarget = await realpath(path).catch(() => null);
        if (!resolvedTarget || !insideOrEqual(canonicalRoot, resolvedTarget)) {
          throw new Error(`bundled runtime contains a broken or escaping symlink: ${path}`);
        }
        continue;
      }
      if (info.isDirectory()) await walk(path);
    }
  };
  await walk(runtimeRoot);
  return { runtimeRoot: canonicalRoot, nodeSha256, cliEntrySha256, symlinkCount };
}

export async function verifyCanonicalLauncherManifest(
  manifestPath: string,
  expectedCliEntry?: string,
): Promise<CanonicalLauncherManifest> {
  if (!isAbsolute(manifestPath) || /[\u0000-\u001f\u007f]/.test(manifestPath)) {
    throw new Error("canonical launcher manifest path must be absolute");
  }
  if (!manifestPath.endsWith("/Contents/Resources/excalibur-launcher.json")) {
    throw new Error("canonical launcher manifest must live inside an app Resources directory");
  }
  const manifest = parseCanonicalLauncherManifest(await readPrivateBoundedJson(manifestPath));
  const resources = dirname(manifestPath);
  const [entry, node] = await Promise.all([
    realpath(join(resources, manifest.cliEntry)).catch(() => null),
    realpath(join(resources, manifest.nodePath)).catch(() => null),
  ]);
  if (!entry || !node) throw new Error("launcher pins a missing CLI entry or Node runtime");
  const [entryInfo, nodeInfo] = await Promise.all([stat(entry), stat(node)]);
  const runtimeRoot = await realpath(join(resources, "runtime")).catch(() => null);
  if (!runtimeRoot || !entryInfo.isFile() || !nodeInfo.isFile()
      || !entry.startsWith(`${runtimeRoot}/`) || !node.startsWith(`${runtimeRoot}/`)
      || !entry.endsWith("/bin/excalibur.mjs")) {
    throw new Error("launcher pins a non-file or non-canonical CLI entry");
  }
  await Promise.all([
    access(entry, constants.R_OK),
    access(node, constants.X_OK),
  ]);
  const launchCommand = await readBoundedFile(join(dirname(manifestPath), "launch.command"), 32 * 1024);
  const launchDigest = createHash("sha256").update(launchCommand).digest("hex");
  const launchText = launchCommand.toString("utf8");
  if (launchDigest !== manifest.launchCommandDigest
      || !launchText.includes("doctor --launch-check")
      || !launchText.includes('exec "$CLI_NODE" "$CLI_ENTRY"')
      || !launchText.includes('/usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"')
      || !launchText.includes('CLI_NODE="$RESOURCE_DIR/runtime/node"')
      || !launchText.includes('CLI_ENTRY="$RESOURCE_DIR/runtime/cli/bin/excalibur.mjs"')
      || /(?:command\s+-v\s+excalibur|exec\s+(?:grok|claude|codex|benchagi|bench)\b)/.test(launchText)) {
    throw new Error("launcher command does not match the manifest-bound sidecar doctor gate");
  }
  if (expectedCliEntry) {
    const expected = await realpath(expectedCliEntry).catch(() => resolve(expectedCliEntry));
    if (entry !== expected) throw new Error("launcher manifest pins a different Excalibur CLI entry");
  }
  return manifest;
}

async function inspectApp(appPath: string, expectedCliEntry?: string): Promise<LauncherInspection> {
  const manifestPath = join(appPath, "Contents", "Resources", "excalibur-launcher.json");
  try {
    await verifyCanonicalLauncherManifest(manifestPath, expectedCliEntry);
    return { appPath, manifestPath, classification: "canonical", issues: [] };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "no canonical One-Surface launcher manifest; this bundle may be the legacy Native/Aurelius preview"
      : (error as Error).message;
    return {
      appPath,
      manifestPath,
      classification: (error as NodeJS.ErrnoException).code === "ENOENT" ? "legacy_or_unverified" : "invalid",
      issues: [message],
    };
  }
}

export async function inspectExcaliburLaunchers(
  env: NodeJS.ProcessEnv = process.env,
  expectedCliEntry?: string,
): Promise<LauncherInspection[]> {
  const home = env.HOME || homedir();
  const roots = env.EXCALIBUR_APP_DIR
    ? [resolve(env.EXCALIBUR_APP_DIR)]
    : [join(home, "Applications"), "/Applications"];
  const apps = new Set<string>();
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 2_000)) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && /^Excalibur.*\.app$/i.test(entry.name)) {
        apps.add(join(root, entry.name));
      }
    }
  }
  return await Promise.all([...apps].sort().map((app) => inspectApp(app, expectedCliEntry)));
}
