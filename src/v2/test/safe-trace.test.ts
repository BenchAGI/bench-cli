import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SafeTraceWriter } from "../diagnostics/safe-trace.js";

test("safe traces are private, expiring, and redact credentials and content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-trace-"));
  await chmod(dir, 0o755);
  const path = join(dir, "gateway.jsonl");
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  const writer = new SafeTraceWriter(path, { now: () => now, ttlMs: 60_000 });
  writer.append("out", JSON.stringify({
    authorization: "Bearer top-secret-token",
    message: "private customer prompt",
    nested: { token: "xai_1234567890", status: "ready" },
  }));
  await writer.flush();

  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("top-secret-token"), false);
  assert.equal(raw.includes("private customer prompt"), false);
  assert.equal(raw.includes("xai_1234567890"), false);
  const record = JSON.parse(raw.trim()) as Record<string, unknown>;
  assert.equal(record.schema, "excalibur-safe-trace-v1");
  assert.equal(record.createdAt, "2026-07-13T12:00:00.000Z");
  assert.equal(record.expiresAt, "2026-07-13T12:01:00.000Z");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o755);
});

test("safe trace files rotate once their TTL expires during a long-running session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "excalibur-trace-rotate-"));
  const path = join(dir, "gateway.jsonl");
  let now = Date.parse("2026-07-13T12:00:00.000Z");
  const writer = new SafeTraceWriter(path, { now: () => now, ttlMs: 60_000 });
  writer.append("in", JSON.stringify({ type: "event", event: "first" }));
  await writer.flush();
  now += 60_001;
  writer.append("in", JSON.stringify({ type: "event", event: "second" }));
  await writer.flush();
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes("second"), true);
  assert.equal(lines[0]?.includes("first"), false);
});
