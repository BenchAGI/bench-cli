// Slash-command parser + registry.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EXCALIBUR_SLASH_COMMANDS,
  SLASH_COMMANDS,
  parseSlash,
  findCommand,
  matchHint,
  renderHelp,
  buildRegistry,
} from "../repl/slash.js";

test("parseSlash returns null for non-slash input", () => {
  assert.equal(parseSlash("hello"), null);
  assert.equal(parseSlash(""), null);
  assert.equal(parseSlash("  not a command"), null);
  assert.equal(parseSlash("path/to/file"), null); // slash not at start
});

test("parseSlash extracts name and args", () => {
  const p = parseSlash("/thinking on");
  assert.equal(p?.name, "thinking");
  assert.deepEqual(p?.args, ["on"]);
  assert.equal(p?.argStr, "on");
});

test("parseSlash lowercases the name and tolerates leading whitespace", () => {
  const p = parseSlash("   /STATUS");
  assert.equal(p?.name, "status");
  assert.deepEqual(p?.args, []);
});

test("parseSlash handles a bare slash", () => {
  const p = parseSlash("/");
  assert.equal(p?.name, "");
  assert.deepEqual(p?.args, []);
});

test("parseSlash splits multiple args and trims", () => {
  const p = parseSlash("/switch   aurelius   extra ");
  assert.equal(p?.name, "switch");
  assert.deepEqual(p?.args, ["aurelius", "extra"]);
  assert.equal(p?.argStr, "aurelius   extra");
});

test("findCommand resolves canonical names and aliases", () => {
  assert.equal(findCommand("help")?.name, "help");
  assert.equal(findCommand("?")?.name, "help");
  assert.equal(findCommand("quit")?.name, "exit");
  assert.equal(findCommand("AGENT")?.name, "switch");
  assert.equal(findCommand("nope"), null);
});

test("every command has a unique non-colliding name/alias", () => {
  const seen = new Set<string>();
  for (const cmd of SLASH_COMMANDS) {
    for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
      assert.ok(!seen.has(n), `duplicate command token: ${n}`);
      seen.add(n);
    }
  }
});

test("matchHint surfaces prefix matches while typing the command word", () => {
  const all = matchHint("/").map((c) => c.name);
  assert.ok(all.includes("help") && all.includes("status"));
  const th = matchHint("/th").map((c) => c.name);
  assert.deepEqual(th, ["thinking"]);
  const s = matchHint("/s").map((c) => c.name);
  assert.ok(s.includes("status") && s.includes("switch"));
});

test("matchHint stops once the user starts typing args", () => {
  assert.deepEqual(matchHint("/thinking "), []);
  assert.deepEqual(matchHint("/thinking on"), []);
  assert.deepEqual(matchHint("plain text"), []);
});

test("matchHint matches aliases too", () => {
  const names = matchHint("/q").map((c) => c.name);
  assert.ok(names.includes("exit")); // via alias "quit"
});

test("renderHelp lists every visible command with its summary", () => {
  const help = renderHelp();
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.hidden) continue;
    assert.ok(help.includes(cmd.summary), `missing summary for /${cmd.name}`);
  }
  assert.match(help, /\/thinking \[on\|off\|collapsed\]/);
});

test("buildRegistry appends extra commands", () => {
  const reg = buildRegistry([{ name: "debug", summary: "x" }]);
  assert.equal(findCommand("debug", reg)?.name, "debug");
  assert.equal(reg.length, SLASH_COMMANDS.length + 1);
});

test("Excalibur registry and help expose the complete aggregate parity surface", () => {
  const registry = buildRegistry(EXCALIBUR_SLASH_COMMANDS);
  const expected = [
    "pulse", "decisions", "forge", "comms", "schedules", "fleet",
    "receipts", "controls", "system", "context", "seat", "route", "memory",
  ];
  assert.deepEqual(EXCALIBUR_SLASH_COMMANDS.map((item) => item.name), expected);
  const help = renderHelp(registry);
  for (const name of [...expected, "status"]) {
    assert.equal(findCommand(name, registry)?.name, name);
    assert.match(help, new RegExp(`/${name}(?:\\s|$)`));
  }
});
