// Isolated ink-render smoke for the TUI. Renders <App> against a stub runner + fake TTY streams so
// we exercise app.tsx / working.tsx / status-bar.tsx / input.tsx at runtime (React hooks, ink
// components, the poll loop) without a gateway or a real terminal. Catches the class of errors that
// type-checking can't: bad hooks, undefined components, render-time throws.

import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { App } from "../dist/v2/tui/app.js";
import { LogStore } from "../dist/v2/tui/log-store.js";

const stub = {
  getThinking: () => "on",
  healthSnapshot: () => ({ state: "ok", runQuietMs: 0, gatewayTickMs: 0, inFlight: false, reconnectAttempt: null, reconnectDelayMs: null }),
  isInFlight: () => false,
  hasPendingApproval: () => false,
  currentRun: () => "run-smoke",
  resumeKey: () => "agent:aurelius",
  isExpanded: () => false,
  setThinking: (m) => m,
  sendMessage: async () => null,
  waitForFinal: async () => "final",
  interruptCurrent: async () => "aborted",
  handleApprovalKey: async () => true,
};

// Fake interactive stdin so ink's useInput can mount (needs isTTY + setRawMode).
const stdin = Object.assign(new EventEmitter(), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
  resume() {},
  pause() {},
  setEncoding() {},
  read: () => null,
});

const chunks = [];
const stdout = new PassThrough();
stdout.columns = 100;
stdout.rows = 30;
stdout.isTTY = true;
stdout.on("data", (c) => chunks.push(c.toString()));

const store = new LogStore();
store.pushLine("smoke: hello from the buffer");

let failed = null;
try {
  const app = render(
    React.createElement(App, {
      runner: stub,
      store,
      agentId: "aurelius",
      model: "Opus 4.8",
      tier: { level: "Legendary", color: "Orange" },
      who: "Light",
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  );

  // Let the poll loop + a couple of frames run, then drive a little input.
  await new Promise((r) => setTimeout(r, 300));
  stdin.emit("data", "/he"); // should surface live hints
  await new Promise((r) => setTimeout(r, 120));
  // Push a line AFTER mount — this is the case the <Static> immutable-append fix must satisfy
  // (the original mutate-in-place store made post-mount lines invisible; smoke must catch that).
  store.pushLine("after-mount-canary-12345");
  await new Promise((r) => setTimeout(r, 120));
  app.unmount();
  await new Promise((r) => setTimeout(r, 50));
} catch (err) {
  failed = err;
}

const out = chunks.join("");
const checks = [
  ["banner/buffer line (pre-mount)", /hello from the buffer/],
  ["committed line AFTER mount (Static fix)", /after-mount-canary-12345/],
  ["status bar agent", /Aurelius/],
  ["status bar tier", /Legendary/],
  ["status bar model", /Opus 4\.8/],
  ["input prompt glyph", /❯/],
  ["health dot", /live/],
];

let ok = !failed;
if (failed) console.error("RENDER THREW:", failed);
for (const [label, re] of checks) {
  const hit = re.test(out);
  if (!hit) ok = false;
  console.log(`${hit ? "ok  " : "FAIL"}  ${label}`);
}

console.log(ok ? "\ntui-smoke: PASS" : "\ntui-smoke: FAIL");
process.exit(ok ? 0 : 1);
