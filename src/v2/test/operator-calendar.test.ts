import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  disableOperatorCalendar,
  operatorCalendarConfigPath,
  parseOperatorCalendarConfigureArgs,
  readOperatorCalendarConfig,
  renderOperatorCalendarStatus,
  writeOperatorCalendarConfig,
} from "../excalibur/operator-calendar.js";

async function fixture(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "excalibur-operator-calendar-"));
  return {
    ...process.env,
    HOME: root,
    EXCALIBUR_OPERATOR_CALENDAR_CONFIG: join(root, ".config", "excalibur", "v1", "operator-calendar.json"),
  };
}

function configured() {
  return parseOperatorCalendarConfigureArgs([
    "--account", "operator@example.test",
    "--calendar-id", "private-calendar@example.test",
    "--timezone", "America/Denver",
    "--lookahead-days", "7",
    "--consent-operator-summary",
  ]);
}

test("calendar configure is explicit consent and writes exact private schema atomically", async () => {
  const env = await fixture();
  await assert.rejects(
    async () => parseOperatorCalendarConfigureArgs([
      "--account", "operator@example.test",
      "--calendar-id", "primary",
      "--timezone", "America/Denver",
    ]),
    /consent-operator-summary/,
  );

  const written = await writeOperatorCalendarConfig(configured(), env);
  assert.equal(written.config?.enabled, true);
  assert.equal(written.mode, 0o600);
  const path = operatorCalendarConfigPath(env);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw), [
    "schemaVersion", "enabled", "provider", "account", "calendarId", "timezone", "lookaheadDays",
  ]);

  const rendered = renderOperatorCalendarStatus(await readOperatorCalendarConfig(env)).join("\n");
  assert.match(rendered, /account: configured \(hidden\)/);
  assert.match(rendered, /only the operator-thread schedules observation/);
  assert.doesNotMatch(rendered, /operator@example|private-calendar/);
});

test("calendar disable preserves the 0600 config and status rejects widened permissions", async () => {
  const env = await fixture();
  await writeOperatorCalendarConfig(configured(), env);
  const disabled = await disableOperatorCalendar(env);
  assert.equal(disabled.config?.enabled, false);
  assert.equal((await stat(disabled.path)).mode & 0o777, 0o600);

  await chmod(disabled.path, 0o644);
  await assert.rejects(readOperatorCalendarConfig(env), /owner-only 0600/);
});

test("calendar configuration accepts only a one-to-seven day lookahead", () => {
  assert.throws(() => parseOperatorCalendarConfigureArgs([
    "--account", "operator@example.test",
    "--calendar-id", "primary",
    "--timezone", "America/Denver",
    "--lookahead-days", "8",
    "--consent-operator-summary",
  ]), /between 1 and 7/);

  const defaulted = parseOperatorCalendarConfigureArgs([
    "--account", "operator@example.test",
    "--calendar-id", "primary",
    "--timezone", "America/Denver",
    "--consent-operator-summary",
  ]);
  assert.equal(defaulted.lookaheadDays, 4, "default is today plus the next three days");
});

test("calendar identifiers match the sidecar boundary", () => {
  assert.throws(() => parseOperatorCalendarConfigureArgs([
    "--account", "operator account@example.test",
    "--calendar-id", "primary",
    "--timezone", "America/Denver",
    "--consent-operator-summary",
  ]), /calendar account is malformed/);
  assert.throws(() => parseOperatorCalendarConfigureArgs([
    "--account", "operator@example.test",
    "--calendar-id", "calendar id with spaces",
    "--timezone", "America/Denver",
    "--consent-operator-summary",
  ]), /calendar id is malformed/);
});
