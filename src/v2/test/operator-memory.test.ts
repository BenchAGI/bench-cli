import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  disableOperatorMemory,
  operatorMemoryConfigPath,
  parseOperatorMemoryConfigureArgs,
  readOperatorMemoryConfig,
  renderOperatorMemoryStatus,
  writeOperatorMemoryConfig,
} from "../excalibur/operator-memory.js";

async function fixture(): Promise<{ env: NodeJS.ProcessEnv; shelf: string }> {
  const root = await mkdtemp(join(tmpdir(), "excalibur-operator-memory-"));
  return {
    env: {
      ...process.env,
      HOME: root,
      EXCALIBUR_OPERATOR_MEMORY_CONFIG: join(root, ".config", "excalibur", "v1", "operator-memory.json"),
    },
    shelf: join(root, "private-aurelius", "SESSION_LANDMARKS.md"),
  };
}

test("memory configure writes the exact owner-only schema and status hides shelfPath", async () => {
  const { env, shelf } = await fixture();
  const config = parseOperatorMemoryConfigureArgs(["--shelf", shelf]);
  const written = await writeOperatorMemoryConfig(config, env);
  assert.equal(written.config?.enabled, true);
  assert.equal(written.mode, 0o600);

  const path = operatorMemoryConfigPath(env);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw), ["schemaVersion", "enabled", "adapter", "shelfPath"]);

  const rendered = renderOperatorMemoryStatus(await readOperatorMemoryConfig(env)).join("\n");
  assert.match(rendered, /shelf: configured \(hidden\)/);
  assert.match(rendered, /tenant fallback disabled/);
  assert.doesNotMatch(rendered, new RegExp(shelf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("memory disable remains private and widened permissions fail closed", async () => {
  const { env, shelf } = await fixture();
  await writeOperatorMemoryConfig(parseOperatorMemoryConfigureArgs(["--shelf", shelf]), env);
  const disabled = await disableOperatorMemory(env);
  assert.equal(disabled.config?.enabled, false);
  assert.equal((await stat(disabled.path)).mode & 0o777, 0o600);

  await chmod(disabled.path, 0o644);
  await assert.rejects(readOperatorMemoryConfig(env), /owner-only 0600/);
});

test("memory configure requires an absolute SESSION_LANDMARKS.md shelf", () => {
  assert.throws(
    () => parseOperatorMemoryConfigureArgs(["--shelf", "SESSION_LANDMARKS.md"]),
    /absolute SESSION_LANDMARKS\.md/,
  );
  assert.throws(
    () => parseOperatorMemoryConfigureArgs(["--shelf", "/private/OTHER.md"]),
    /absolute SESSION_LANDMARKS\.md/,
  );
});
