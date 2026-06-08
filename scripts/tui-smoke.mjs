// Isolated ink-render smoke for the TUI. Renders <App> against a stub runner + fake TTY streams so
// we exercise app.tsx / working.tsx / status-bar.tsx / input.tsx at runtime (React hooks, ink
// components, the poll loop, AND keyboard input) without a gateway or a real terminal. Catches the
// class of errors type-checking can't: bad hooks, undefined components, render throws, the <Static>
// post-mount scrollback bug, and the approval-key gate consuming 'r' at an idle prompt.

import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { App } from "../dist/v2/tui/app.js";
import { LogStore } from "../dist/v2/tui/log-store.js";

const approvalCalls = [];
const stub = {
  getThinking: () => "on",
  healthSnapshot: () => ({ state: "ok", runQuietMs: 0, gatewayTickMs: 0, inFlight: false, reconnectAttempt: null, reconnectDelayMs: null }),
  isInFlight: () => false, // idle — no run in flight
  hasPendingApproval: () => false,
  canHandleApprovalKey: (k) => k === "r" || k === "R", // mirrors the real runner's expand-key branch
  currentRun: () => "run-smoke",
  resumeKey: () => "agent:aurelius",
  isExpanded: () => false,
  setThinking: (m) => m,
  sendMessage: async () => null,
  waitForFinal: async () => "final",
  interruptCurrent: async () => "aborted",
  handleApprovalKey: async (k) => {
    approvalCalls.push(k);
    return true;
  },
};

// Fake interactive stdin that ink can read: ink 5 reads via 'readable' + read(), NOT 'data' events.
// A PassThrough is a real Readable, so write()→read() works; add the TTY shims ink expects.
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const chunks = [];
const stdout = new PassThrough();
stdout.columns = 100;
stdout.rows = 30;
stdout.isTTY = true;
stdout.on("data", (c) => chunks.push(c.toString()));

const store = new LogStore();
store.pushLine("smoke: hello from the buffer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  await sleep(300); // mount + first poll
  // Type a message starting with 'r' at an IDLE prompt, char by char. With the fix this is literal
  // text; the regression would consume the leading 'r' as an expand toggle (handleApprovalKey).
  for (const ch of "roof") {
    stdin.write(ch);
    await sleep(40);
  }
  await sleep(120);
  // Push a committed line AFTER mount — the <Static> immutable-append fix must surface it (the
  // original mutate-in-place store made post-mount lines invisible).
  store.pushLine("after-mount-canary-12345");
  await sleep(120);
  app.unmount();
  await sleep(50);
} catch (err) {
  failed = err;
}

const out = chunks.join("");
const checks = [
  ["banner/buffer line (pre-mount)", () => /hello from the buffer/.test(out)],
  ["committed line AFTER mount (Static fix)", () => /after-mount-canary-12345/.test(out)],
  ["status bar agent", () => /Aurelius/.test(out)],
  ["status bar tier", () => /Legendary/.test(out)],
  ["status bar model", () => /Opus 4\.8/.test(out)],
  ["input prompt glyph", () => /❯/.test(out)],
  ["health dot", () => /live/.test(out)],
  ["typed 'roof' is literal at idle (input rendered)", () => /roof/.test(out)],
  ["'r' NOT consumed as expand at idle (approval-key gate)", () => approvalCalls.length === 0],
];

let ok = !failed;
if (failed) console.error("RENDER THREW:", failed);
for (const [label, fn] of checks) {
  const hit = fn();
  if (!hit) ok = false;
  console.log(`${hit ? "ok  " : "FAIL"}  ${label}`);
}
if (approvalCalls.length) console.log(`  (handleApprovalKey was called with: ${JSON.stringify(approvalCalls)})`);

console.log(ok ? "\ntui-smoke: PASS" : "\ntui-smoke: FAIL");
process.exit(ok ? 0 : 1);
