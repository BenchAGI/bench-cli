import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA,
  EXCALIBUR_ORCHESTRA_PREFLIGHT_REQUEST_SCHEMA,
  EXCALIBUR_ORCHESTRA_PREFLIGHT_RESULT_SCHEMA,
  EXCALIBUR_ORCHESTRA_PREPARE_REQUEST_SCHEMA,
  EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA,
  EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX,
  EXCALIBUR_ORCHESTRA_PROGRESS_RESULT_SCHEMA,
  EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
  requestOrchestraPublicationIntent,
  resolveOrchestraBrokerConfig,
  runOrchestraCommand,
  type OrchestraExecFile,
} from "../excalibur/orchestra-broker.js";

const DIGEST = "d".repeat(64);
const RESOURCE_SET_DIGEST = "e".repeat(64);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function configuredEnvironment(): Promise<{
  env: NodeJS.ProcessEnv;
  executable: string;
  config: string;
  stateRoot: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "excalibur-orchestra-")));
  const executable = join(root, "pattern-a-broker");
  const config = join(root, "orchestra-config.json");
  const stateRoot = join(root, "state");
  const brokerBytes = "#!/bin/sh\nexit 99\n";
  await writeFile(executable, brokerBytes, { mode: 0o700 });
  await chmod(executable, 0o700);
  await mkdir(stateRoot, { mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await writeFile(config, JSON.stringify({
    schemaVersion: EXCALIBUR_ORCHESTRA_CONFIG_SCHEMA,
    brokerExecutable: executable,
    brokerSha256: createHash("sha256").update(brokerBytes).digest("hex"),
    resourceSetDigest: RESOURCE_SET_DIGEST,
    stateRoot,
  }), { mode: 0o600 });
  return {
    executable,
    config,
    stateRoot,
    env: {
      HOME: root,
      PATH: "/attacker-controlled/bin",
      EXCALIBUR_ORCHESTRA_CONFIG: config,
      EXCALIBUR_ORCHESTRA_STATE_DIR: join(root, "legacy-state-must-not-pass"),
      SHOULD_NOT_REACH_BROKER: "secret-value",
    },
  };
}

function preflightResult(configured: Awaited<ReturnType<typeof configuredEnvironment>>): Record<string, unknown> {
  const attested = {
    schema: EXCALIBUR_ORCHESTRA_PREFLIGHT_RESULT_SCHEMA,
    available: true,
    stateRootRealpath: configured.stateRoot,
    resourceSetDigest: RESOURCE_SET_DIGEST,
  };
  return { ...attested, attestationDigest: digest(attested) };
}

function afterPreflight(
  configured: Awaited<ReturnType<typeof configuredEnvironment>>,
  command: OrchestraExecFile,
): OrchestraExecFile {
  return async (executable, argv, options) => {
    if (argv.length === 1 && argv[0] === "status") {
      assert.equal(executable, configured.executable);
      assert.equal(options.env.EXCALIBUR_PATTERN_A_STATE_ROOT, configured.stateRoot);
      assert.equal(options.env.EXCALIBUR_ORCHESTRA_STATE_DIR, undefined);
      assert.equal(options.env.SHOULD_NOT_REACH_BROKER, undefined);
      assert.doesNotMatch(String(options.env.PATH), /attacker-controlled/);
      assert.match(String(options.env.PATH), /\/usr\/bin:\/bin$/);
      assert.deepEqual(JSON.parse(String(options.input)), {
        schema: EXCALIBUR_ORCHESTRA_PREFLIGHT_REQUEST_SCHEMA,
        stateRootRealpath: configured.stateRoot,
        expectedResourceSetDigest: RESOURCE_SET_DIGEST,
      });
      return { stdout: JSON.stringify(preflightResult(configured)), stderr: "" };
    }
    return await command(executable, argv, options);
  };
}

test("unavailable orchestra config is rendered honestly without invoking a broker", async () => {
  let invoked = false;
  const lines = await runOrchestraCommand(["status", "mission-1"], {
    env: {},
    execFileFn: async () => {
      invoked = true;
      throw new Error("must not execute");
    },
  });
  assert.equal(invoked, false);
  assert.match(lines.join("\n"), /Orchestra · unavailable/);
  assert.match(lines.join("\n"), /no mission command, model, or external effect was invoked/);
});

test("orchestra config rejects group/world-readable mode before broker invocation", async () => {
  const configured = await configuredEnvironment();
  await chmod(String(configured.env.EXCALIBUR_ORCHESTRA_CONFIG), 0o644);
  let invoked = false;
  const lines = await runOrchestraCommand(["status", "mission-1"], {
    env: configured.env,
    execFileFn: async () => {
      invoked = true;
      throw new Error("must not execute");
    },
  });
  assert.equal(invoked, false);
  assert.match(lines.join("\n"), /owned by the current operator with no group\/world permissions/);
});

test("orchestra config rejects a group/world-writable broker executable", async () => {
  const configured = await configuredEnvironment();
  await chmod(configured.executable, 0o722);
  let invoked = false;
  const lines = await runOrchestraCommand(["status", "mission-1"], {
    env: configured.env,
    execFileFn: async () => {
      invoked = true;
      throw new Error("must not execute");
    },
  });
  assert.equal(invoked, false);
  assert.match(lines.join("\n"), /operator-owned and not group\/world writable/);
});

test("orchestra config rejects broker byte drift before preflight or mission invocation", async () => {
  const configured = await configuredEnvironment();
  await writeFile(configured.executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let invoked = false;
  const result = await resolveOrchestraBrokerConfig(configured.env, {
    execFileFn: async () => {
      invoked = true;
      throw new Error("must not execute");
    },
  });
  assert.equal(invoked, false);
  assert.ok("reason" in result);
  assert.match("reason" in result ? result.reason : "", /SHA-256 does not match/);
});

test("orchestra config requires a closure preflight bound to exact resource set and state root", async () => {
  const configured = await configuredEnvironment();
  let calls = 0;
  const result = await resolveOrchestraBrokerConfig(configured.env, {
    execFileFn: async (_executable, argv, options) => {
      calls += 1;
      assert.deepEqual(argv, ["status"]);
      const request = JSON.parse(String(options.input));
      assert.equal(request.expectedResourceSetDigest, RESOURCE_SET_DIGEST);
      assert.equal(request.stateRootRealpath, configured.stateRoot);
      const bad = { ...preflightResult(configured), resourceSetDigest: "f".repeat(64) };
      return { stdout: JSON.stringify(bad), stderr: "" };
    },
  });
  assert.equal(calls, 1);
  assert.ok("reason" in result);
  assert.match("reason" in result ? result.reason : "", /did not attest the pinned Pattern A resource set/);
});

test("status invokes one absolute executable with argv and renders state plus receipt counts", async () => {
  const configured = await configuredEnvironment();
  const capture: { call?: Parameters<OrchestraExecFile> } = {};
  const lines = await runOrchestraCommand(["status", "mission-1"], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async (...args) => {
      capture.call = args;
      return {
        stdout: JSON.stringify({
          schemaVersion: EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
          missionId: "mission-1",
          missionDigest: DIGEST,
          state: "reviewing",
          receiptCounts: { total: 5, succeeded: 4, pending: 1 },
        }),
        stderr: "",
      };
    }),
  });
  assert.equal(capture.call?.[0], await realpath(configured.executable));
  assert.deepEqual(capture.call?.[1], ["status", "--mission-id", "mission-1"]);
  assert.equal(capture.call?.[2].shell, false);
  assert.equal(capture.call?.[2].env.SHOULD_NOT_REACH_BROKER, undefined);
  assert.equal(capture.call?.[2].env.EXCALIBUR_PATTERN_A_STATE_ROOT, configured.stateRoot);
  assert.equal(capture.call?.[2].env.EXCALIBUR_ORCHESTRA_STATE_DIR, undefined);
  assert.match(lines.join("\n"), /mission-1 · reviewing/);
  assert.match(lines.join("\n"), /pending 1/);
  assert.match(lines.join("\n"), /succeeded 4/);
  assert.match(lines.join("\n"), /total 5/);
});

test("prepare binds an owner-private brief to the authenticated principal and conversation", async () => {
  const configured = await configuredEnvironment();
  const briefPath = join(String(configured.env.HOME), "mission-brief.json");
  const brief = {
    schema: "excalibur-pattern-a-mission-brief/v1",
    missionId: "mission-prepared",
    repository: "BenchAGI/bench-cli",
  };
  await writeFile(briefPath, JSON.stringify(brief), { mode: 0o600 });
  let capture: Parameters<OrchestraExecFile> | null = null;
  const lines = await runOrchestraCommand(["prepare", briefPath], {
    env: configured.env,
    principalId: "operator-a",
    sessionId: "20000000-0000-4000-8000-000000000002",
    execFileFn: afterPreflight(configured, async (...args) => {
      capture = args;
      return {
        stdout: JSON.stringify({
          schemaVersion: EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
          missionId: "mission-prepared",
          missionDigest: DIGEST,
          state: "MISSION_DRAFT",
          receiptCounts: { total: 0 },
        }),
        stderr: "",
      };
    }),
  });
  const call = capture as Parameters<OrchestraExecFile> | null;
  assert.deepEqual(call?.[1], ["prepare"]);
  assert.equal(call?.[2].shell, false);
  assert.deepEqual(JSON.parse(String(call?.[2].input)), {
    schema: EXCALIBUR_ORCHESTRA_PREPARE_REQUEST_SCHEMA,
    principalId: "operator-a",
    sessionId: "20000000-0000-4000-8000-000000000002",
    brief,
  });
  assert.match(lines.join("\n"), /mission-prepared · MISSION_DRAFT/);

  await chmod(briefPath, 0o644);
  const rejected = await runOrchestraCommand(["prepare", briefPath], {
    env: configured.env,
    principalId: "operator-a",
    sessionId: "20000000-0000-4000-8000-000000000002",
    execFileFn: afterPreflight(configured, async () => { throw new Error("must not execute"); }),
  });
  assert.match(rejected.join("\n"), /brief JSON must be owned by the current operator/);

  const unbound = await runOrchestraCommand(["prepare", briefPath], {
    env: configured.env,
    execFileFn: async () => { throw new Error("must not execute"); },
  });
  assert.match(unbound.join("\n"), /authenticated operator principal and active conversation/);
});

test("progress renders only the bounded broker projection for the exact mission", async () => {
  const configured = await configuredEnvironment();
  const eventBody = {
    schema: EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA,
    sequence: 3,
    priorEventDigest: "a".repeat(64),
    missionId: "mission-progress",
    missionDigest: DIGEST,
    state: "SOL_BUILDING",
    phase: "sol",
    status: "STARTED",
    seat: "sol",
    taskId: "task-one",
    round: 1,
    completed: 1,
    total: 2,
    occurredAt: "2026-07-14T12:00:00.000Z",
  };
  const event = { ...eventBody, eventDigest: digest(eventBody) };
  const lines = await runOrchestraCommand(["progress", "mission-progress"], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async (_executable, argv) => {
      assert.deepEqual(argv, ["progress", "--mission-id", "mission-progress"]);
      return {
        stdout: JSON.stringify({
          schemaVersion: EXCALIBUR_ORCHESTRA_PROGRESS_RESULT_SCHEMA,
          missionId: "mission-progress",
          missionDigest: DIGEST,
          missionState: "SOL_BUILDING",
          revision: 4,
          eventCount: 3,
          latestEvent: event,
        }),
        stderr: "",
      };
    }),
  });
  assert.match(lines.join("\n"), /events: 3/);
  assert.match(lines.join("\n"), /SOL_BUILDING · revision 4/);
  assert.match(lines.join("\n"), /progress #3 · sol · sol STARTED · 1\/2/);
  assert.doesNotMatch(lines.join("\n"), /occurredAt|eventDigest|priorEventDigest/);

  const malformed = await runOrchestraCommand(["progress", "mission-progress"], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async () => ({
      stdout: JSON.stringify({
        schemaVersion: EXCALIBUR_ORCHESTRA_PROGRESS_RESULT_SCHEMA,
        missionId: "mission-progress",
        missionDigest: DIGEST,
        missionState: "SOL_BUILDING",
        revision: 4,
        eventCount: 3,
        latestEvent: { ...event, missionId: "another-mission" },
      }),
      stderr: "",
    })),
  });
  assert.match(malformed.join("\n"), /Orchestra · unavailable/);
  assert.match(malformed.join("\n"), /malformed Pattern A progress event/);
});

test("advance binds the exact mission digest and exposes no arbitrary broker argv", async () => {
  const configured = await configuredEnvironment();
  let argv: string[] = [];
  let timeout = 0;
  const progress: string[] = [];
  const lines = await runOrchestraCommand(["advance", "mission-2", DIGEST], {
    env: configured.env,
    onProgress: (line) => progress.push(line),
    execFileFn: afterPreflight(configured, async (_executable, received, options) => {
      argv = received;
      timeout = options.timeout;
      const progressBody = {
        schema: EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA,
        sequence: 1,
        priorEventDigest: "0".repeat(64),
        missionId: "mission-2",
        missionDigest: DIGEST,
        state: "SOL_BUILDING",
        phase: "sol",
        status: "STARTED",
        seat: "sol",
        taskId: "task-one",
        round: 1,
        completed: 0,
        total: 1,
        occurredAt: "2026-07-14T12:00:00.000Z",
      };
      const progressEvent = { ...progressBody, eventDigest: digest(progressBody) };
      options.onStderrLine?.(`${EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX}${canonicalJson(progressEvent)}`);
      return {
        stdout: JSON.stringify({
          schemaVersion: EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
          missionId: "mission-2",
          missionDigest: DIGEST,
          state: "advanced",
          receiptCounts: { total: 6, succeeded: 6 },
        }),
        stderr: "",
      };
    }),
  });
  assert.deepEqual(argv, [
    "advance", "--mission-id", "mission-2", "--confirm-mission-digest", DIGEST,
  ]);
  assert.equal(timeout, 14_400_000);
  assert.match(progress.join("\n"), /may take up to 4 hours; do not resubmit/);
  assert.match(progress.join("\n"), /progress #1 · sol · sol STARTED · 0\/1/);
  assert.match(lines.join("\n"), /mission-2 · advanced/);
  assert.match(lines.join("\n"), new RegExp(DIGEST));

  const rejected = await runOrchestraCommand(["advance", "mission-2", "not-a-digest"], {
    env: configured.env,
    execFileFn: async () => { throw new Error("must not execute"); },
  });
  assert.match(rejected.join("\n"), /exact-mission-digest/);
});

test("advance fails closed on a bad progress digest or broken stream continuity", async () => {
  const configured = await configuredEnvironment();
  const unsigned = {
    schema: EXCALIBUR_ORCHESTRA_PROGRESS_EVENT_SCHEMA,
    sequence: 1,
    priorEventDigest: "0".repeat(64),
    missionId: "mission-stream",
    missionDigest: DIGEST,
    state: "FABLE_PLANNING",
    phase: "planning",
    status: "STARTED",
    seat: "fable",
    taskId: null,
    round: null,
    completed: 0,
    total: 1,
    occurredAt: "2026-07-15T06:00:00.000Z",
  };
  const valid = { ...unsigned, eventDigest: digest(unsigned) };
  const brokerResult = {
    schemaVersion: EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
    missionId: "mission-stream",
    missionDigest: DIGEST,
    state: "advanced",
    receiptCounts: { total: 1 },
  };

  const badDigest = await runOrchestraCommand(["advance", "mission-stream", DIGEST], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async (_executable, _argv, options) => {
      options.onStderrLine?.(`${EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX}${canonicalJson({
        ...valid,
        eventDigest: "f".repeat(64),
      })}`);
      return { stdout: JSON.stringify(brokerResult), stderr: "" };
    }),
  });
  assert.match(badDigest.join("\n"), /invalid digest/);

  const discontinuous = await runOrchestraCommand(["advance", "mission-stream", DIGEST], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async (_executable, _argv, options) => {
      options.onStderrLine?.(`${EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX}${canonicalJson(valid)}`);
      const secondUnsigned = {
        ...unsigned,
        sequence: 3,
        priorEventDigest: valid.eventDigest,
        occurredAt: "2026-07-15T06:01:00.000Z",
      };
      options.onStderrLine?.(`${EXCALIBUR_ORCHESTRA_PROGRESS_PREFIX}${canonicalJson({
        ...secondUnsigned,
        eventDigest: digest(secondUnsigned),
      })}`);
      return { stdout: JSON.stringify(brokerResult), stderr: "" };
    }),
  });
  assert.match(discontinuous.join("\n"), /sequence or prior-digest continuity/);
});

test("advance rejects a broker result correlated to another digest", async () => {
  const configured = await configuredEnvironment();
  const lines = await runOrchestraCommand(["advance", "mission-3", DIGEST], {
    env: configured.env,
    execFileFn: afterPreflight(configured, async () => ({
      stdout: JSON.stringify({
        schemaVersion: EXCALIBUR_ORCHESTRA_RESULT_SCHEMA,
        missionId: "mission-3",
        missionDigest: "e".repeat(64),
        state: "advanced",
        receiptCounts: { total: 1 },
      }),
      stderr: "",
    })),
  });
  assert.match(lines.join("\n"), /Orchestra · unavailable/);
  assert.match(lines.join("\n"), /did not bind the exact mission and digest/);
});

test("publication intent invokes only the pinned broker command and validates both exact digests", async () => {
  const configured = await configuredEnvironment();
  const details = join(String(configured.env.HOME), "publish-details.json");
  await writeFile(details, JSON.stringify({
    schema: "excalibur-pattern-a-publication-metadata/v1",
    title: "feat: exact Pattern A head",
    body: "Anvil-gated draft-only publication.",
    labels: [],
  }), { mode: 0o600 });
  const publicationGateDigest = "7".repeat(64);
  const intent = {
    actionId: "github.draft_pr.publish.v1",
    target: { resourceType: "github_draft_pull_request", repository: "BenchAGI/bench-cli" },
    payload: {
      worktreePath: "/private/work/excalibur-one-surface-cli",
      remoteName: "origin",
      baseRef: "main",
      baseSha: "1".repeat(40),
      headRef: "codex/might-surface",
      headSha: "2".repeat(40),
      patchDigest: "3".repeat(64),
      changedPathsDigest: "4".repeat(64),
      packetDigest: "5".repeat(64),
      missionId: "mission-publish",
      principalId: "operator-a",
      sessionId: "20000000-0000-4000-8000-000000000002",
      missionDigest: "6".repeat(64),
      publicationGateDigest,
      title: "feat: exact Pattern A head",
      body: "Anvil-gated draft-only publication.",
      labels: [],
      draftOnly: true,
    },
    idempotencyKey: "pattern-a-mission-publish-22222222222222222222",
  };
  const { publicationGateDigest: _gate, ...boundPayload } = intent.payload;
  let commandCalls = 0;
  const requested = await requestOrchestraPublicationIntent("mission-publish", details, {
    env: configured.env,
    execFileFn: afterPreflight(configured, async (_executable, argv, options) => {
      commandCalls += 1;
      assert.deepEqual(argv, [
        "propose", "--mission-id", "mission-publish", "--details", await realpath(details),
      ]);
      assert.equal(options.shell, false);
      assert.equal(options.env.EXCALIBUR_PATTERN_A_STATE_ROOT, configured.stateRoot);
      return {
        stdout: JSON.stringify({
          intent,
          intentDigest: digest(intent),
          publicationGateDigest,
          actionBindingDigest: digest({
            actionId: intent.actionId,
            target: intent.target,
            payload: boundPayload,
            idempotencyKey: intent.idempotencyKey,
          }),
        }),
        stderr: "",
      };
    }),
  });
  assert.equal(commandCalls, 1);
  assert.ok("publication" in requested);
  if ("publication" in requested) {
    assert.deepEqual(requested.publication.intent, intent);
    assert.equal(requested.publication.intentDigest, digest(intent));
  }

  const manualHashes = join(String(configured.env.HOME), "manual-hash-details.json");
  await writeFile(manualHashes, JSON.stringify({
    schema: "excalibur-pattern-a-publication-metadata/v1",
    title: "feat: must derive facts",
    body: "No operator-supplied Git hashes.",
    labels: [],
    headSha: "2".repeat(40),
  }), { mode: 0o600 });
  commandCalls = 0;
  const manualRejected = await requestOrchestraPublicationIntent("mission-publish", manualHashes, {
    env: configured.env,
    execFileFn: afterPreflight(configured, async () => {
      commandCalls += 1;
      throw new Error("must not invoke proposal command");
    }),
  });
  assert.equal(commandCalls, 0);
  assert.match("reason" in manualRejected ? manualRejected.reason : "", /only exact Pattern A publication metadata/);

  const labeled = join(String(configured.env.HOME), "labeled-details.json");
  await writeFile(labeled, JSON.stringify({
    schema: "excalibur-pattern-a-publication-metadata/v1",
    title: "feat: labels remain derived policy",
    body: "Operator metadata cannot add labels.",
    labels: ["excalibur"],
  }), { mode: 0o600 });
  const labeledRejected = await requestOrchestraPublicationIntent("mission-publish", labeled, {
    env: configured.env,
    execFileFn: afterPreflight(configured, async () => {
      commandCalls += 1;
      throw new Error("must not invoke proposal command");
    }),
  });
  assert.equal(commandCalls, 0);
  assert.match("reason" in labeledRejected ? labeledRejected.reason : "", /only exact Pattern A publication metadata/);

  await chmod(details, 0o644);
  commandCalls = 0;
  const rejected = await requestOrchestraPublicationIntent("mission-publish", details, {
    env: configured.env,
    execFileFn: afterPreflight(configured, async () => {
      commandCalls += 1;
      throw new Error("must not invoke publication command");
    }),
  });
  assert.equal(commandCalls, 0);
  assert.ok("reason" in rejected);
  assert.match("reason" in rejected ? rejected.reason : "", /details JSON must be owned/);
});
