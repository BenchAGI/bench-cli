# ANVIL-4-REVIEW: cloud-brain readiness

## Summary
- Recommendation: **GO** / **GO-WITH-PATCHES** / **HOLD**

## Findings (P0 / P1 / P2 with file + line + issue + suggested fix)

### Path correctness
...

### Dedup key validity
...

### Transparency contract (ADR-006)
...

### chat.history under cloud-brain
...

### Smoke script soundness
...

## Single-test-proves-transparency answer
...

## Out-of-scope notes (optional)
```

Be terse. Skip nitpicks. Focus on what would actually break under cloud-brain.

# Attached: scripts/cloud-brain-smoke.mjs

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
--
# ANVIL-4-REVIEW: cloud-brain readiness

## Summary
- Recommendation: **HOLD**
- Main blocker: the proposed smoke can pass without exercising cloud-brain. Local `benchagi` still talks to local gateway `chat.send`; W3 adds `/v1/llm_turn` for the relay to call, but I found no local gateway path that routes `chat.send` through cloud-brain based on Firestore `runtime`.

## Findings

### Path correctness
**P0** — `scripts/cloud-brain-smoke.mjs:97-103` runs `node bin/benchagi.mjs ...`, which sends local gateway `chat.send` via `src/v2/chat-runner.ts:359-364`. The W3 path is a separate HTTP endpoint, `/v1/llm_turn`, registered in `openclaw-w3/src/gateway/server-http.ts:970-984` and handled in `openclaw-w3/src/gateway/llm-turn-http.ts:315-375`.

Issue: selecting agents by Firestore `runtime: remote-brain` does not make local gateway `chat.send` use cloud-brain. Unless one of the unavailable PR diffs adds a local gateway dispatch bridge, this smoke tests local OpenClaw, not cloud-brain.

Suggested fix: either add/verify a gateway `chat.send` remote-brain dispatch path that writes/claims `LlmTurnDirective` and re-emits normal `chat`/`agent` events, or change the smoke to assert cloud artifacts: directive created, claimed, completed, and correlated to the CLI run.

### Dedup key validity
**OK, conditional.** The CLI key `(prefix, runId, seq, stream, sub)` is valid if forwarded remote-brain events are emitted as normal `agent` frames with stable `runId` and monotonic per-run `seq`. The directive schema carries `runId` per spec lines 611-619, and OpenClaw agent events generate monotonic per-run seq in `openclaw-w3/src/infra/agent-events.ts:200-217`.

Concern is not the key. The gap is proving the gateway actually forwards remote-brain completion as those same event frames.

### Transparency contract (ADR-006)
**OK in bench-cli code; P0 in integration contract.** `ChatRunner` does not branch on `runtime`; lifecycle handling keys off `chat` final states and `agent.lifecycle` phases only (`src/v2/chat-runner.ts:118-154`). That is the right transparency shape.

But transparency is currently asserted, not proven. The local gateway path must be the component that hides cloud-brain. I did not find that bridge in the readable local code.

### chat.history under cloud-brain
**P1** — bench-cli calls `chat.history { sessionKey, sinceSeq }` and expects `events`/`frames` for replay (`src/v2/chat-runner.ts:222-245`, `491-505`). The readable OpenClaw `chat.history` handler accepts `sessionKey`, `limit`, `maxChars`, then returns transcript `messages`, not event frames, and does not consume `sinceSeq` (`openclaw-w3/src/gateway/server-methods/chat.ts:1607-1675`).

Suggested fix: gateway needs a real event-frame history contract: `chat.history({ sessionKey, sinceSeq }) -> { events: EventFrame[] }`, including forwarded remote-brain frames. Otherwise reconnect replay is best-effort no-op for both local and cloud-brain runs.

### Smoke script soundness
**P0** — false-positive risk: non-empty stdout + exit 0 can be produced by local execution. No assertion proves `relayDirectives` had an `llm_turn` for this run, that `/v1/llm_turn` was called, or that a directive completed.

**P1** — Firestore lookup assumes doc id `instances/${instanceId}/agentDeployments/${instanceId}_${agentId}` at `scripts/cloud-brain-smoke.mjs:75-77`. The runbook says this, but the broader spec examples use arbitrary `deploymentId`. If W1 backfill preserves noncanonical deployment ids, the smoke skips real remote-brain agents.

**P2** — Firestore failures are recorded as skips (`scripts/cloud-brain-smoke.mjs:193-200`), so an auth/project outage can produce exit 0 if no agents are tested. For readiness, infra lookup failure should be fatal unless explicitly `--allow-skips`.

**P2** — script assumes repo-root cwd for `bin/benchagi.mjs` (`scripts/cloud-brain-smoke.mjs:100-104`). Use `import.meta.url` to resolve repo root.

## Single-test-proves-transparency answer
The current smoke is not sufficient. A stronger single test:

1. Start `benchagi --agent <remote-brain-agent> "respond: smoke-ok"`.
2. Capture raw WS frames from the CLI.
3. Watch Firestore for a new `relayDirectives` doc with `directiveType: "llm_turn"`, matching `instanceId`, `agentId`, and a correlated `runId`.
4. Assert directive reaches `completed`.
5. Assert the CLI saw normal `chat` final and/or `agent.lifecycle end` frames with the same run identity and no runtime-specific branch.

That proves both halves: cloud-brain actually ran, and benchagi consumed it transparently.
tokens used
164,060
# ANVIL-4-REVIEW: cloud-brain readiness

## Summary
- Recommendation: **HOLD**
- Main blocker: the proposed smoke can pass without exercising cloud-brain. Local `benchagi` still talks to local gateway `chat.send`; W3 adds `/v1/llm_turn` for the relay to call, but I found no local gateway path that routes `chat.send` through cloud-brain based on Firestore `runtime`.

## Findings

### Path correctness
**P0** — `scripts/cloud-brain-smoke.mjs:97-103` runs `node bin/benchagi.mjs ...`, which sends local gateway `chat.send` via `src/v2/chat-runner.ts:359-364`. The W3 path is a separate HTTP endpoint, `/v1/llm_turn`, registered in `openclaw-w3/src/gateway/server-http.ts:970-984` and handled in `openclaw-w3/src/gateway/llm-turn-http.ts:315-375`.

Issue: selecting agents by Firestore `runtime: remote-brain` does not make local gateway `chat.send` use cloud-brain. Unless one of the unavailable PR diffs adds a local gateway dispatch bridge, this smoke tests local OpenClaw, not cloud-brain.

Suggested fix: either add/verify a gateway `chat.send` remote-brain dispatch path that writes/claims `LlmTurnDirective` and re-emits normal `chat`/`agent` events, or change the smoke to assert cloud artifacts: directive created, claimed, completed, and correlated to the CLI run.

### Dedup key validity
**OK, conditional.** The CLI key `(prefix, runId, seq, stream, sub)` is valid if forwarded remote-brain events are emitted as normal `agent` frames with stable `runId` and monotonic per-run `seq`. The directive schema carries `runId` per spec lines 611-619, and OpenClaw agent events generate monotonic per-run seq in `openclaw-w3/src/infra/agent-events.ts:200-217`.

Concern is not the key. The gap is proving the gateway actually forwards remote-brain completion as those same event frames.

### Transparency contract (ADR-006)
**OK in bench-cli code; P0 in integration contract.** `ChatRunner` does not branch on `runtime`; lifecycle handling keys off `chat` final states and `agent.lifecycle` phases only (`src/v2/chat-runner.ts:118-154`). That is the right transparency shape.

But transparency is currently asserted, not proven. The local gateway path must be the component that hides cloud-brain. I did not find that bridge in the readable local code.

### chat.history under cloud-brain
**P1** — bench-cli calls `chat.history { sessionKey, sinceSeq }` and expects `events`/`frames` for replay (`src/v2/chat-runner.ts:222-245`, `491-505`). The readable OpenClaw `chat.history` handler accepts `sessionKey`, `limit`, `maxChars`, then returns transcript `messages`, not event frames, and does not consume `sinceSeq` (`openclaw-w3/src/gateway/server-methods/chat.ts:1607-1675`).

Suggested fix: gateway needs a real event-frame history contract: `chat.history({ sessionKey, sinceSeq }) -> { events: EventFrame[] }`, including forwarded remote-brain frames. Otherwise reconnect replay is best-effort no-op for both local and cloud-brain runs.

### Smoke script soundness
**P0** — false-positive risk: non-empty stdout + exit 0 can be produced by local execution. No assertion proves `relayDirectives` had an `llm_turn` for this run, that `/v1/llm_turn` was called, or that a directive completed.

**P1** — Firestore lookup assumes doc id `instances/${instanceId}/agentDeployments/${instanceId}_${agentId}` at `scripts/cloud-brain-smoke.mjs:75-77`. The runbook says this, but the broader spec examples use arbitrary `deploymentId`. If W1 backfill preserves noncanonical deployment ids, the smoke skips real remote-brain agents.

**P2** — Firestore failures are recorded as skips (`scripts/cloud-brain-smoke.mjs:193-200`), so an auth/project outage can produce exit 0 if no agents are tested. For readiness, infra lookup failure should be fatal unless explicitly `--allow-skips`.

**P2** — script assumes repo-root cwd for `bin/benchagi.mjs` (`scripts/cloud-brain-smoke.mjs:100-104`). Use `import.meta.url` to resolve repo root.

## Single-test-proves-transparency answer
The current smoke is not sufficient. A stronger single test:

1. Start `benchagi --agent <remote-brain-agent> "respond: smoke-ok"`.
2. Capture raw WS frames from the CLI.
3. Watch Firestore for a new `relayDirectives` doc with `directiveType: "llm_turn"`, matching `instanceId`, `agentId`, and a correlated `runId`.
4. Assert directive reaches `completed`.
5. Assert the CLI saw normal `chat` final and/or `agent.lifecycle end` frames with the same run identity and no runtime-specific branch.

That proves both halves: cloud-brain actually ran, and benchagi consumed it transparently.
=== EXIT 0 ===
DONE: Wed May  6 13:10:35 MDT 2026
