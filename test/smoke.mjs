// Lightweight smoke tests. No third-party test runner — just node.
//
// Covers: argv parser, JSON extractor, banner filtering, alias resolution,
// end-to-end --help / version, agents --json against a live gateway,
// and shape checks for the new commands' help output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";

import { parseArgs } from "../src/lib/args.mjs";
import { extractJson, cleanStderr } from "../src/lib/openclaw.mjs";
import { resolveAgentId } from "../src/lib/agents.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, "../bin/bench.mjs");
const PKG = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    failed += 1;
  }
}

console.log("smoke: bench-cli");

await test("parseArgs handles flags + positionals", () => {
  const out = parseArgs(["ask", "aurelius", "--high", "hello", "world"], {
    booleanFlags: ["high"],
  });
  assert.deepEqual(out.positionals, ["ask", "aurelius", "hello", "world"]);
  assert.equal(out.flags.high, true);
});

await test("parseArgs --thinking takes a value", () => {
  const out = parseArgs(["--thinking", "high", "msg"]);
  assert.equal(out.flags.thinking, "high");
  assert.deepEqual(out.positionals, ["msg"]);
});

await test("parseArgs supports --key=value", () => {
  const out = parseArgs(["--timeout=120", "--json"], {
    booleanFlags: ["json"],
  });
  assert.equal(out.flags.timeout, "120");
  assert.equal(out.flags.json, true);
});

await test("extractJson skips banner lines", () => {
  const text =
    "Config warnings:\n- plugins.entries.x: stale\n🦞 OpenClaw foo\n\n{\n  \"a\": 1\n}\n";
  const v = extractJson(text);
  assert.deepEqual(v, { a: 1 });
});

await test("extractJson handles arrays", () => {
  assert.deepEqual(extractJson("noise\n[1,2,3]"), [1, 2, 3]);
});

await test("extractJson returns null on garbage", () => {
  assert.equal(extractJson("hello world"), null);
});

await test("cleanStderr filters banner+plugin warnings", () => {
  const cleaned = cleanStderr(
    "Config warnings:\n- plugins.entries.x: stale\n🦞 OpenClaw 1.0\nReal error here\n",
  );
  assert.equal(cleaned, "Real error here");
});

await test("resolveAgentId aurelius alias", async () => {
  const id = await resolveAgentId("aurelius");
  assert.equal(id, "kestrel-aurelius");
});

await test("resolveAgentId passes through canonical id", async () => {
  const id = await resolveAgentId("cole");
  assert.ok(typeof id === "string" && id.length > 0);
});

await test("`bench --help` runs and lists every command", async () => {
  const { code, stdout } = await runBench(["--help"]);
  assert.equal(code, 0);
  for (const cmd of [
    "ask",
    "chat",
    "feed",
    "agents",
    "sessions",
    "tasks",
    "status",
    "tail",
    "commitments",
    "setup",
  ]) {
    assert.match(stdout, new RegExp(`\\b${cmd}\\b`), `expected ${cmd} in --help`);
  }
});

await test("`bench version` matches package.json", async () => {
  const { code, stdout } = await runBench(["version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), PKG.version);
});

for (const cmd of ["ask", "chat", "feed", "tail", "commitments", "setup", "tasks", "sessions", "status", "agents"]) {
  await test(`\`bench ${cmd} --help\` works`, async () => {
    const { code, stdout } = await runBench([cmd, "--help"]);
    assert.equal(code, 0, `exit=${code}`);
    assert.ok(stdout.length > 20, "help text too short");
  });
}

await test("`bench agents --json` returns array (live)", async () => {
  const { code, stdout } = await runBench(["agents", "--json"]);
  if (code !== 0) {
    throw new Error(`openclaw not reachable; skipping (exit=${code})`);
  }
  const v = JSON.parse(stdout);
  assert.ok(Array.isArray(v));
  assert.ok(v.length > 0);
  const ids = v.map((a) => a.id);
  assert.ok(ids.includes("kestrel-aurelius"));
});

await test("`bench setup --non-interactive --json` returns checks", async () => {
  const { code, stdout } = await runBench(["setup", "--non-interactive", "--json"]);
  // Setup may fail (e.g. no agents configured) — we only require the schema.
  const data = JSON.parse(stdout);
  assert.ok(Array.isArray(data.checks), "expected data.checks array");
  assert.ok(data.checks.length >= 3, "expected at least 3 checks");
  for (const r of data.checks) {
    assert.ok(typeof r.name === "string");
    assert.ok(typeof r.ok === "boolean");
  }
  // exit code reflects pass/fail; either is acceptable for the smoke test.
  assert.ok(code === 0 || code === 1);
});

await test("`bench unknown` exits 64 with helpful message", async () => {
  const { code, stderr } = await runBench(["totally-bogus-command"]);
  assert.equal(code, 64);
  assert.match(stderr, /unknown command/);
});

await test("install.sh is POSIX shebang and executable", () => {
  const p = path.resolve(__dirname, "../scripts/install.sh");
  const stat = statSync(p);
  // Mode check: owner-execute bit should be set.
  assert.ok((stat.mode & 0o100) !== 0, "expected install.sh to be executable");
  const text = readFileSync(p, "utf8");
  assert.match(text.split("\n")[0], /^#!\/bin\/sh/);
  assert.match(text, /set -eu/);
});

await test("install.sh verifies both bench binaries", () => {
  const text = readFileSync(path.resolve(__dirname, "../scripts/install.sh"), "utf8");
  assert.match(text, /PACKAGE=\$\{BENCHAGI_PACKAGE:-github:BenchAGI\/bench-cli\}/);
  assert.match(text, /Verifying bench binary/);
  assert.match(text, /Verifying benchagi streaming console/);
  assert.match(text, /command -v benchagi/);
});

console.log(`\nresult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

function runBench(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [BENCH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
