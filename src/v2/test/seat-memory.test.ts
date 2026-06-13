import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  contentHashOf,
  detectSeatMemoryWrite,
  drainSeatMemoryQueue,
  enqueueMemoryFile,
  listSeatMemoryRecords,
  resolveClaudeMemoryDir,
  resolveOpenclawBin,
} from "../commands/seat-memory-queue.js";

let tmpRoot = "";
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seat-memory-test-"));
  for (const key of ["BENCHAGI_SEAT_PROMOTIONS_DIR", "BENCHAGI_OPENCLAW_BIN", "BENCHAGI_CONFIG_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.BENCHAGI_SEAT_PROMOTIONS_DIR = join(tmpRoot, "queue");
  delete process.env.BENCHAGI_OPENCLAW_BIN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeMemoryFile(name: string, body: string): string {
  const dir = join(tmpRoot, "claude-memory");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

function writeFakeOpenclaw(name: string, script: string): string {
  const bin = join(tmpRoot, name);
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

test("detectSeatMemoryWrite matches Write/Edit to a Claude memory path", () => {
  const base = "/home/u/.claude/projects/-seat/memory/note.md";
  assert.deepEqual(
    detectSeatMemoryWrite(JSON.stringify({ tool_name: "Write", tool_input: { file_path: base } })),
    { filePath: base },
  );
  assert.deepEqual(
    detectSeatMemoryWrite(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: base } })),
    { filePath: base },
  );
  assert.equal(
    detectSeatMemoryWrite(JSON.stringify({ tool_name: "Read", tool_input: { file_path: base } })),
    null,
  );
  assert.equal(
    detectSeatMemoryWrite(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x.md" } })),
    null,
  );
  assert.equal(detectSeatMemoryWrite("not json"), null);
});

test("contentHashOf is stable across trailing whitespace and CRLF", () => {
  assert.equal(contentHashOf("a\r\nb  \n"), contentHashOf("a\nb\n"));
  assert.notEqual(contentHashOf("a"), contentHashOf("b"));
});

test("resolveClaudeMemoryDir derives the slug from the seat cwd", () => {
  const dir = resolveClaudeMemoryDir({ cwd: "/Users/x/.config/benchagi/seat-workspace" });
  assert.ok(dir);
  assert.ok(
    dir.endsWith(".claude/projects/-Users-x--config-benchagi-seat-workspace/memory"),
    dir,
  );
});

test("enqueueMemoryFile is idempotent by content and re-arms on change", () => {
  const ctx = { agentId: "aurelius", seatKind: "claude-code", seatSessionId: "s1" };
  const file = writeMemoryFile("fact.md", "first body\n");
  enqueueMemoryFile(ctx, file);
  enqueueMemoryFile(ctx, file);
  let records = listSeatMemoryRecords("aurelius");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, "pending");
  const firstHash = records[0]?.sourceHash;

  writeFileSync(file, "second body\n");
  enqueueMemoryFile(ctx, file);
  records = listSeatMemoryRecords("aurelius");
  assert.equal(records.length, 1);
  assert.notEqual(records[0]?.sourceHash, firstHash);
  assert.equal(records[0]?.state, "pending");
});

test("resolveOpenclawBin honors BENCHAGI_OPENCLAW_BIN when the file exists", () => {
  const bin = writeFakeOpenclaw("openclaw-stub", "#!/bin/sh\nexit 0\n");
  process.env.BENCHAGI_OPENCLAW_BIN = bin;
  assert.equal(resolveOpenclawBin(), bin);
  assert.equal(resolveOpenclawBin("/no/such/path"), bin);
});

test("drainSeatMemoryQueue keeps records pending when openclaw fails (offline)", () => {
  const ctx = { agentId: "aurelius", seatKind: "claude-code", seatSessionId: "s1" };
  const file = writeMemoryFile("retry.md", "needs promotion\n");
  enqueueMemoryFile(ctx, file);
  const failBin = writeFakeOpenclaw("openclaw-fail", "#!/bin/sh\nexit 3\n");

  const result = drainSeatMemoryQueue({ agentId: "aurelius", openclawBin: failBin, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.promoted, 0);
  const records = listSeatMemoryRecords("aurelius");
  assert.equal(records[0]?.state, "pending");
  assert.equal(records[0]?.attempts, 1);
  assert.ok(records[0]?.lastError);
});

test("drainSeatMemoryQueue marks records promoted on a successful promote-file run", () => {
  const ctx = { agentId: "aurelius", seatKind: "claude-code", seatSessionId: "s1" };
  const file = writeMemoryFile("done.md", "promote me\n");
  enqueueMemoryFile(ctx, file);
  const hash = contentHashOf("promote me\n");
  // Fake openclaw echoes a promote-file JSON result whose contentHash matches.
  const okBin = writeFakeOpenclaw(
    "openclaw-ok",
    `#!/bin/sh\ncat <<'EOF'\n{"results":[{"slug":"done","target":"/w/memory/seat/done.md","status":"created","contentHash":"${hash}"}]}\nEOF\n`,
  );

  const result = drainSeatMemoryQueue({ agentId: "aurelius", openclawBin: okBin, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.promoted, 1);
  const records = listSeatMemoryRecords("aurelius");
  assert.equal(records[0]?.state, "promoted");
  assert.equal(records[0]?.targetPath, "/w/memory/seat/done.md");

  // Re-draining is a no-op (promoted records are not retried).
  const again = drainSeatMemoryQueue({ agentId: "aurelius", openclawBin: okBin, timeoutMs: 5000 });
  assert.equal(again.drained, 0);
});
