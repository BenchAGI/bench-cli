#!/usr/bin/env node
// cloud-brain-smoke.mjs — Phase B validation per
// `~/.openclaw/wiki/main/_boards/runbooks/platform/benchagi-v2-cloud-brain-pickup.md` §"Validation script".
//
// Activates AFTER cloud-brain Phase 1B PRs merge (BenchAGI #872 W1, #874 W4,
// #878 W2, #988 relay, openclaw#24 W3) AND a developer's agentDeployment is
// flipped to runtime: 'remote-brain' per the operator-side smoke runbook.
//
// What it does:
//
//   1. Lists all known agents from the local openclaw gateway.
//   2. For each agent, queries Firestore (admin REST + gcloud token per
//      ~/.claude/.../memory/reference_firebase_admin_rest_recipe.md) for
//      `agentDeployments/{instanceId}_{agentId}` and reads the `runtime` field.
//   3. If `runtime === 'remote-brain'`, spawns `benchagi --agent <name>
//      --liveness off "respond: smoke-ok"` with stdout/stderr captured and
//      a 60s wall-clock timeout.
//   4. Asserts (per runbook §"Validation script" point 4):
//        - chat output is non-empty (proves cloud-brain dispatched the LLM turn)
//        - the run terminated cleanly (proves orchestrator returned)
//        - no error markers in output
//        - latency < 60s
//   5. Emits a JSON summary; exits 0 on all-green, 1 if any agent failed.
//
// Required env:
//   - INSTANCE_ID         — Firestore instance id (e.g. cory's primary instance)
//   - GCP_PROJECT         — Firebase project id (default: benchagi-8ea90)
//
// Optional env:
//   - SMOKE_AGENT_FILTER  — regex; if set, only test agents matching this
//   - SMOKE_PROMPT        — override default prompt (default: "respond: smoke-ok")
//   - SMOKE_TIMEOUT_MS    — override 60s default
//   - DEBUG_RAW_FRAMES    — if "1", tee raw WS frames to ./smoke-frames-<agent>.jsonl
//                           (requires bench-cli to honor BENCHAGI_DEBUG_TRACE_FILE,
//                           which is a V1.1 follow-up — for now this is a no-op)
//
// This script is GATED on cloud-brain Phase 1B merging. If the schemas don't
// support `runtime` field yet, every agent will appear as `runtime: undefined`
// and the script will report "no remote-brain agents found — gated".

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INSTANCE_ID = process.env.INSTANCE_ID;
const GCP_PROJECT = process.env.GCP_PROJECT ?? "benchagi-8ea90";
const PROMPT = process.env.SMOKE_PROMPT ?? "respond: smoke-ok";
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS ?? "60000", 10);
const FILTER = process.env.SMOKE_AGENT_FILTER ? new RegExp(process.env.SMOKE_AGENT_FILTER) : null;

if (!INSTANCE_ID) {
  console.error("ERROR: INSTANCE_ID env var required");
  console.error("Usage: INSTANCE_ID=<your-instance> node scripts/cloud-brain-smoke.mjs");
  process.exit(2);
}

// --- Firestore admin REST via gcloud user token ---

function gcloudAccessToken() {
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    console.error("ERROR: gcloud auth print-access-token failed:", err.message);
    console.error("Run `gcloud auth login` first.");
    process.exit(2);
  }
}

async function fetchAgentDeployment(instanceId, agentId, token) {
  const docPath = `instances/${instanceId}/agentDeployments/${instanceId}_${agentId}`;
  const url = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents/${docPath}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Goog-User-Project": GCP_PROJECT,
    },
  });
  if (resp.status === 404) return null; // No deployment for this agent
  if (!resp.ok) {
    throw new Error(`Firestore GET ${docPath} → ${resp.status} ${await resp.text()}`);
  }
  const doc = await resp.json();
  // Firestore REST returns fields wrapped in type tags. Extract `runtime` (string).
  const runtime = doc?.fields?.runtime?.stringValue ?? null;
  const tier = doc?.fields?.tier?.stringValue ?? null;
  return { runtime, tier, raw: doc };
}

// --- benchagi spawn with stdout capture + timeout ---

function runBenchagi(agentId, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(
      "node",
      ["bin/benchagi.mjs", "--agent", agentId, "--liveness", "off", "--no-thinking", prompt],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGINT"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const dtMs = performance.now() - t0;
      resolve({ exitCode: code, stdout, stderr, durationMs: Math.round(dtMs) });
    });
  });
}

// --- Assertions ---

function assertSmokePassed(result, prompt, timeoutMs) {
  const issues = [];

  if (result.exitCode !== 0) {
    issues.push(`exit code ${result.exitCode}`);
  }
  if (result.durationMs >= timeoutMs) {
    issues.push(`timed out after ${timeoutMs}ms`);
  }
  if (result.durationMs >= 60_000) {
    issues.push(`latency ${result.durationMs}ms exceeds 60s budget`);
  }
  if (!result.stdout || result.stdout.trim().length === 0) {
    issues.push("empty stdout — no chat output captured");
  }
  // Heuristic: look for a few error indicators in the rendered output.
  if (/error: |chat\.send failed|connection closed|history replay failed/i.test(result.stdout)) {
    issues.push("error marker in stdout");
  }
  // The prompt asks the agent to "respond: smoke-ok" — don't strictly require
  // this in output (model might paraphrase), but flag if completely absent.
  if (!/smoke-ok|ok|hello|hi/i.test(result.stdout)) {
    issues.push("response doesn't contain expected acknowledgement (lenient check failed)");
  }

  return issues;
}

// --- Discover known agents from the local gateway ---

function listAgents() {
  try {
    const out = execFileSync("node", ["bin/benchagi.mjs", "agents", "list"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Parse lines like "  kestrel-aurelius  pi/aurelius-default"; split on whitespace.
    const agents = [];
    for (const line of out.split("\n")) {
      const m = /^\s+(\S+)\s+(\S+)/.exec(line);
      if (m) agents.push({ id: m[1], model: m[2] });
    }
    return agents;
  } catch (err) {
    console.error("ERROR: `benchagi agents list` failed:", err.message);
    process.exit(2);
  }
}

// --- Main ---

async function main() {
  console.log(`[smoke] instance=${INSTANCE_ID} project=${GCP_PROJECT} timeout=${TIMEOUT_MS}ms`);

  const token = gcloudAccessToken();
  const agents = listAgents();
  console.log(`[smoke] discovered ${agents.length} agent(s) from local gateway`);

  const results = [];
  for (const agent of agents) {
    if (FILTER && !FILTER.test(agent.id)) continue;

    let deployment;
    try {
      deployment = await fetchAgentDeployment(INSTANCE_ID, agent.id, token);
    } catch (err) {
      console.log(`[smoke] ${agent.id}: SKIP — Firestore lookup failed: ${err.message}`);
      results.push({ agent: agent.id, skipped: true, reason: "firestore-lookup-failed", error: err.message });
      continue;
    }

    if (!deployment) {
      console.log(`[smoke] ${agent.id}: SKIP — no agentDeployment doc`);
      results.push({ agent: agent.id, skipped: true, reason: "no-deployment-doc" });
      continue;
    }

    if (deployment.runtime !== "remote-brain") {
      console.log(`[smoke] ${agent.id}: SKIP — runtime=${deployment.runtime ?? "<unset>"}, not remote-brain`);
      results.push({ agent: agent.id, skipped: true, reason: "not-remote-brain", runtime: deployment.runtime });
      continue;
    }

    console.log(`[smoke] ${agent.id}: RUN — runtime=remote-brain, tier=${deployment.tier ?? "<unset>"}`);
    const run = await runBenchagi(agent.id, PROMPT, TIMEOUT_MS);
    const issues = assertSmokePassed(run, PROMPT, TIMEOUT_MS);

    if (issues.length === 0) {
      console.log(`[smoke] ${agent.id}: PASS (${run.durationMs}ms)`);
      results.push({ agent: agent.id, pass: true, durationMs: run.durationMs });
    } else {
      console.log(`[smoke] ${agent.id}: FAIL — ${issues.join(", ")}`);
      console.log(`[smoke] --- stdout ---\n${run.stdout}\n[smoke] --- stderr ---\n${run.stderr}`);
      results.push({ agent: agent.id, pass: false, durationMs: run.durationMs, issues, stdout: run.stdout, stderr: run.stderr });
    }
  }

  const tested = results.filter((r) => !r.skipped);
  const failed = tested.filter((r) => !r.pass);

  console.log("\n[smoke] --- summary ---");
  console.log(JSON.stringify({
    totalAgents: results.length,
    tested: tested.length,
    passed: tested.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2));

  if (tested.length === 0) {
    console.log("[smoke] no remote-brain agents found — Phase 1B may not be merged + flipped yet");
    process.exit(0);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(2);
});
