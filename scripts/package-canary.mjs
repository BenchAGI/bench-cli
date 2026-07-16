#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const commandNames = ["bench", "benchagi", "excalibur"];

async function runNpm(args, options = {}) {
  const npmEntry = process.env.npm_execpath;
  const command = npmEntry ? process.execPath : "npm";
  const commandArgs = npmEntry ? [npmEntry, ...args] : args;
  return await execFileAsync(command, commandArgs, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

async function runEntry(entry, env) {
  return await execFileAsync(entry, ["version"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024,
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "excalibur-package-canary-"));
try {
  const packDirectory = join(temporaryRoot, "pack");
  const prefix = join(temporaryRoot, "prefix");
  const home = join(temporaryRoot, "home");
  await mkdir(packDirectory, { recursive: true });
  const { stdout } = await runNpm([
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDirectory,
  ]);
  const metadata = JSON.parse(stdout)[0];
  assert.equal(metadata.name, packageJson.name);
  assert.equal(metadata.version, packageJson.version);

  const packedFiles = new Map(metadata.files.map((file) => [file.path, file]));
  for (const name of commandNames) {
    const file = packedFiles.get(`bin/${name}.mjs`);
    assert.ok(file, `packed tarball is missing bin/${name}.mjs`);
    assert.equal(file.mode, 0o755, `packed bin/${name}.mjs must be mode 0755`);
  }

  const tarball = join(packDirectory, metadata.filename);
  await runNpm([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    tarball,
  ], { env: { ...process.env, HOME: home } });

  for (const name of commandNames) {
    const entry = join(prefix, "bin", name);
    assert.notEqual((await stat(entry)).mode & 0o111, 0, `${name} install entry is not executable`);
    const result = await runEntry(entry, {
      ...process.env,
      HOME: home,
      PATH: `${join(prefix, "bin")}:${process.env.PATH || ""}`,
    });
    assert.match(result.stdout, new RegExp(packageJson.version.replaceAll(".", "\\.")));
  }

  console.log(`package-canary: ${packageJson.name}@${packageJson.version} · bench, benchagi, excalibur verified`);
  console.log("package-canary: temporary prefix only · no global install, publish, or desktop mutation");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
