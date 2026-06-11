// Lightweight smoke tests. No third-party test runner — just node.
//
// Covers: argv parser, JSON extractor, banner filtering, alias resolution,
// end-to-end --help / version, agents --json against a live gateway,
// and shape checks for the new commands' help output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { parseArgs } from "../src/lib/args.mjs";
import { extractJson, cleanStderr } from "../src/lib/openclaw.mjs";
import { resolveAgentId } from "../src/lib/agents.mjs";
import { resolveForgeAuth } from "../src/commands/forge.mjs";
import { profileIsFresh } from "../dist/v2/state/user-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(__dirname, "../bin/bench.mjs");
const PKG = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
);

let passed = 0;
let failed = 0;
const AURELIUS_IDS = new Set(["aurelius", "kestrel-aurelius"]);

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
  assert.ok(AURELIUS_IDS.has(id), `expected current or legacy Aurelius id, got ${id}`);
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
    "forge",
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

for (const cmd of ["ask", "chat", "feed", "tail", "commitments", "forge", "setup", "tasks", "sessions", "status", "agents"]) {
  await test(`\`bench ${cmd} --help\` works`, async () => {
    const { code, stdout } = await runBench([cmd, "--help"]);
    assert.equal(code, 0, `exit=${code}`);
    assert.ok(stdout.length > 20, "help text too short");
  });
}

await test("`bench agents --json` returns array (live)", async () => {
  const { code, stdout } = await runBench(["agents", "--json"]);
  if (code !== 0) {
    console.log(`       openclaw not reachable; skipped live roster assertion (exit=${code})`);
    return;
  }
  const v = JSON.parse(stdout);
  assert.ok(Array.isArray(v));
  assert.ok(v.length > 0);
  const ids = v.map((a) => a.id);
  assert.ok(ids.some((id) => AURELIUS_IDS.has(id)));
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
  assert.match(text, /PACKAGE=\$\{BENCHAGI_PACKAGE:-https:\/\/github\.com\/BenchAGI\/bench-cli\/archive\/refs\/heads\/main\.tar\.gz\}/);
  assert.match(text, /Verifying bench alias binary/);
  assert.match(text, /Verifying benchagi streaming console/);
  assert.match(text, /command -v benchagi/);
});

// --- BenchAGI seat: status line + attention notifications (the new feature) ---
const ASSETS = path.resolve(__dirname, "../dist/v2/assets/.claude");

await test("seat .claude assets are shipped in dist", () => {
  for (const f of [
    "settings.json",
    "statusline/benchagi-statusline.mjs",
    "hooks/benchagi-attention.mjs",
    "output-styles/benchagi.md",
  ]) {
    assert.ok(existsSync(path.join(ASSETS, f)), `missing dist asset: ${f}`);
  }
});

await test("status line renders the agent identity from BENCH_AGENT_* env", async () => {
  const { stdout } = await runScript(path.join(ASSETS, "statusline/benchagi-statusline.mjs"), [], {
    env: { BENCH_AGENT_NAME: "Aurelius", BENCH_AGENT_EMOJI: "🦅", BENCH_AGENT_MODEL_SHORT: "Opus 4.8", BENCH_AGENT_ROLE: "coo" },
    input: "{}",
  });
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /Aurelius/);
  assert.match(plain, /Opus 4\.8/);
  assert.match(plain, /benchagi/);
});

await test("attention set→render→clear surfaces a notification then removes it", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "benchagi-seat-"));
  try {
    const hook = path.join(ASSETS, "hooks/benchagi-attention.mjs");
    const sl = path.join(ASSETS, "statusline/benchagi-statusline.mjs");
    const env = { CLAUDE_PROJECT_DIR: ws, BENCH_AGENT_NAME: "Aurelius", BENCH_AGENT_EMOJI: "🦅", BENCH_AGENT_MODEL_SHORT: "Opus 4.8" };
    await runScript(hook, ["set", "Approve the deploy?", "needs-input"], { env, input: "" });
    const set = (await runScript(sl, [], { env, input: "{}" })).stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(set, /Approve the deploy\?/, "expected the attention message in the status line");
    await runScript(hook, ["clear"], { env, input: "{}" });
    const cleared = (await runScript(sl, [], { env, input: "{}" })).stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(cleared, /Approve the deploy\?/, "expected the attention cleared");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- bench forge: auth resolution (env > file > default) ---

await test("resolveForgeAuth: env wins over files", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bench-forge-"));
  try {
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "bench-cloud.key"), "file-key\n");
    writeFileSync(
      path.join(home, ".openclaw", "bench-cloud.json"),
      JSON.stringify({ instanceId: "file-inst", apiBase: "https://file.example/api" }),
    );
    const auth = resolveForgeAuth({
      env: {
        BENCH_API_KEY: " env-key ",
        BENCH_INSTANCE_ID: "env-inst",
        BENCH_API_BASE: "https://env.example/api/",
      },
      home,
    });
    assert.equal(auth.apiKey, "env-key");
    assert.equal(auth.instanceId, "env-inst");
    assert.equal(auth.apiBase, "https://env.example/api"); // trailing slash trimmed
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("resolveForgeAuth: falls back to ~/.openclaw files, trims the key", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bench-forge-"));
  try {
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "bench-cloud.key"), "  file-key  \n");
    writeFileSync(
      path.join(home, ".openclaw", "bench-cloud.json"),
      JSON.stringify({ instanceId: "file-inst", apiBase: "https://file.example/api" }),
    );
    const auth = resolveForgeAuth({ env: {}, home });
    assert.equal(auth.apiKey, "file-key");
    assert.equal(auth.instanceId, "file-inst");
    assert.equal(auth.apiBase, "https://file.example/api");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("resolveForgeAuth: empty when nothing configured, default apiBase", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bench-forge-"));
  try {
    const auth = resolveForgeAuth({ env: {}, home });
    assert.equal(auth.apiKey, "");
    assert.equal(auth.instanceId, "");
    assert.equal(auth.apiBase, "https://benchagi.com/api");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("`bench forge submit` without auth fails with setup guidance", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bench-forge-"));
  try {
    const { code, stderr } = await runBenchEnv(
      ["forge", "submit", "--title", "t", "--goal", "g"],
      { HOME: home, BENCH_API_KEY: "", BENCH_INSTANCE_ID: "", BENCH_API_BASE: "" },
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /not connected to Bench Cloud/);
    assert.match(stderr, /forge scopes/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("`bench forge list` renders desiredSkillOrUI and forwards limit", async () => {
  await withForgeMock(async ({ method, url, headers }, res) => {
    assert.equal(method, "GET");
    assert.equal(url.pathname, "/api/v1/forge/packets/agent");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(headers["x-expected-instance-id"], "inst-1");
    sendJson(res, {
      packets: [
        forgePacket({
          packetId: "fp_1",
          desiredSkillOrUI: "Project Alpha title",
          updatedAt: Date.now(),
        }),
      ],
      count: 1,
    });
  }, async (apiBase) => {
    const { code, stdout, stderr } = await runBenchEnv(["forge", "list", "--limit", "2"], forgeEnv(apiBase));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Project Alpha title/);
  });
});

await test("`bench forge status` renders customer projection title + customer-agent author", async () => {
  await withForgeMock(async ({ method, url }, res) => {
    assert.equal(method, "GET");
    if (url.pathname === "/api/v1/forge/packets/agent") {
      assert.equal(url.searchParams.get("packetId"), "fp_1");
      sendJson(res, {
        packets: [forgePacket({ packetId: "fp_1", desiredSkillOrUI: "Project Alpha title" })],
        count: 1,
      });
      return;
    }
    if (url.pathname === "/api/v1/forge/packets/agent/fp_1/messages") {
      sendJson(res, {
        messages: [
          {
            authorType: "customer-agent",
            body: "Please prioritize this.",
            kind: "message",
            createdAt: Date.now(),
          },
        ],
        count: 1,
      });
      return;
    }
    sendJson(res, { error: "not found" }, 404);
  }, async (apiBase) => {
    const { code, stdout, stderr } = await runBenchEnv(["forge", "status", "fp_1"], forgeEnv(apiBase));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /title\s+Project Alpha title/);
    assert.match(stdout, /you message/);
    assert.match(stdout, /Please prioritize this\./);
  });
});

await test("profileIsFresh: fresh within window, false when stale/missing/garbage", () => {
  assert.equal(profileIsFresh(null), false);
  assert.equal(profileIsFresh({}), false);
  assert.equal(profileIsFresh({ verifiedAt: new Date().toISOString() }), true);
  assert.equal(profileIsFresh({ verifiedAt: new Date(Date.now() - 40 * 86400000).toISOString() }), false);
  assert.equal(profileIsFresh({ verifiedAt: "not-a-date" }), false);
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

function runBenchEnv(args, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [BENCH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function runScript(scriptPath, args, { env = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

function forgeEnv(apiBase) {
  return {
    BENCH_API_KEY: "test-key",
    BENCH_INSTANCE_ID: "inst-1",
    BENCH_API_BASE: apiBase,
    NO_COLOR: "1",
  };
}

function forgePacket(overrides = {}) {
  const now = Date.now();
  return {
    packetId: "fp_1",
    kind: "dev-request",
    desiredSkillOrUI: "Project Alpha title",
    goal: "Build Project Alpha.",
    state: "received",
    targetAgent: "aurelius",
    targetAgentKnown: true,
    createdAt: now,
    submittedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function withForgeMock(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      Promise.resolve(handler({ method: req.method, url, headers: req.headers }, res)).catch((err) => {
        res.statusCode = 500;
        res.end(String(err?.message ?? err));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        resolve(await fn(`http://127.0.0.1:${port}/api`));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function sendJson(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
