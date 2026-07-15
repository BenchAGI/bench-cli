import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSeatPacket, writeFrozenPacket } from "../ucp/packet.js";
import { EffectRegistry } from "../ucp/registry.js";

test("UCP seat.dispatch cannot invoke a model outside /orchestra advance", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-registry-"));
  const bin = join(root, "bin");
  const marker = join(root, "model-transport-called");
  const packetPath = join(root, "packet.json");
  await mkdir(bin);
  const openclaw = join(bin, "openclaw");
  await writeFile(openclaw, `#!/bin/sh\nprintf called >${marker}\nexit 99\n`, { mode: 0o700 });
  await chmod(openclaw, 0o700);
  await writeFrozenPacket(packetPath, createSeatPacket({
    goal: "Review the bounded local implementation.",
    repoPaths: [process.cwd()],
    nonGoals: ["No publish, merge, deploy, send, or secret access."],
    proof: ["Run the bounded local tests."],
    maxFiles: 8,
  }));
  const registry = new EffectRegistry({
    env: {
      ...process.env,
      EXCALIBUR_UCP_STATE_DIR: join(root, "state"),
      HOME: root,
      PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`,
    },
  });
  const execution = await registry.execute({
    effectId: "seat.dispatch",
    execute: true,
    input: { packetPath, seat: "sol" },
  });
  assert.equal(execution.receipt.status, "denied");
  assert.equal(execution.receipt.denialCode, "CANONICAL_ORCHESTRA_BROKER_REQUIRED");
  await assert.rejects(access(marker));
});

test("mail.send remains hard denied with a durable named receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-registry-"));
  const registry = new EffectRegistry({ env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: root, HOME: root } });
  const execution = await registry.execute({ effectId: "mail.send", input: {} });
  assert.equal(execution.receipt.status, "denied");
  assert.equal(execution.receipt.denialCode, "MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED");
  assert.doesNotMatch(await readFile(execution.receiptPath, "utf8"), /recipient|message body/);
});

test("typed effect schemas reject extra or credential-bearing input with a value-free receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-registry-"));
  const registry = new EffectRegistry({ env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: root, HOME: root } });
  const execution = await registry.execute({
    effectId: "bench.health",
    input: { instanceId: "tenant-test", apiToken: "must-never-be-persisted" },
  });
  assert.equal(execution.receipt.status, "denied");
  assert.equal(execution.receipt.denialCode, "UCP_INPUT_FIELD_DENIED");
  assert.doesNotMatch(await readFile(execution.receiptPath, "utf8"), /apiToken|must-never-be-persisted/);
});

test("Bench health names missing configuration and never falls back to local markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-registry-"));
  const registry = new EffectRegistry({ env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: root, HOME: root } });
  const execution = await registry.execute({ effectId: "bench.health", input: { instanceId: "tenant-test" } });
  assert.equal(execution.receipt.status, "missing_config");
  assert.equal(execution.receipt.denialCode, "BENCH_MISSING_CONFIG");
  assert.match(execution.receipt.summary, /Bench Chassis API/);
  assert.equal(execution.receipt.secretUses.length, 0);
});

test("customer mutations require one explicit non-bulk process-bound instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "ucp-registry-"));
  const request = (instanceId: string) => ({
    effectId: "bench.cs.grant",
    dryRun: true,
    input: { instanceId, principal: "operator@example.com", customerSuccessEnabled: true },
  });

  const missing = await new EffectRegistry({
    env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: join(root, "missing"), HOME: root },
  }).execute(request("tenant-test"));
  assert.equal(missing.receipt.denialCode, "UCP_TENANT_SCOPE_MISSING");

  const bulk = await new EffectRegistry({
    env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: join(root, "bulk"), HOME: root, EXCALIBUR_INSTANCE_ID: "all" },
  }).execute(request("all"));
  assert.equal(bulk.receipt.denialCode, "UCP_TENANT_SCOPE_MISSING");

  const mismatch = await new EffectRegistry({
    env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: join(root, "mismatch"), HOME: root, EXCALIBUR_INSTANCE_ID: "tenant-one" },
  }).execute(request("tenant-two"));
  assert.equal(mismatch.receipt.denialCode, "UCP_TENANT_SCOPE_DENIED");

  const matched = await new EffectRegistry({
    env: { ...process.env, EXCALIBUR_UCP_STATE_DIR: join(root, "matched"), HOME: root, EXCALIBUR_INSTANCE_ID: "tenant-one" },
  }).execute(request("tenant-one"));
  assert.equal(matched.receipt.status, "dry_run");
});
