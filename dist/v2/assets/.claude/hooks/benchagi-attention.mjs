#!/usr/bin/env node
// benchagi-attention.mjs — the BenchAGI status line notification channel.
// Writes/clears state/bench-attention.json, which benchagi-statusline.mjs renders
// at the front of the seat's status line so the human can see, at a glance, that
// the agent needs something from them. Never throws (hooks must not break a turn).
//
// Modes:
//   hook-notification   read a Claude Code Notification payload on stdin, surface its message
//   set "<message>" [level]   set attention explicitly (agent/CLI). level: needs-input|blocked|info
//   clear               remove the attention (wired to UserPromptSubmit = the human responded)
import fs from "node:fs";
import path from "node:path";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function resolveRoot(payload) {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    payload?.workspace?.project_dir ||
    payload?.cwd ||
    process.cwd()
  );
}

function attentionFile(root) {
  return path.join(root, "state", "bench-attention.json");
}

function write(root, message, level) {
  const msg = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!msg) return;
  const file = attentionFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ message: msg.slice(0, 240), level: level || "needs-input", ts: Date.now() }),
    "utf8",
  );
}

function clear(root) {
  try {
    fs.rmSync(attentionFile(root), { force: true });
  } catch {
    /* best-effort */
  }
}

function main() {
  const mode = process.argv[2] || "hook-notification";
  if (mode === "clear") {
    clear(resolveRoot(readStdin()));
    return;
  }
  if (mode === "set") {
    write(resolveRoot({}), process.argv[3], process.argv[4]);
    return;
  }
  const payload = readStdin();
  write(resolveRoot(payload), payload?.message || "Claude needs your attention", "needs-input");
}

try {
  main();
} catch {
  /* hooks must never fail a turn */
}
