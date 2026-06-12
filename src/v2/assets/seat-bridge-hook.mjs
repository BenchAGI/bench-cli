#!/usr/bin/env node
// BenchAGI local-seat hook shim. Reads the provider hook payload on stdin and
// forwards it to the installed BenchAGI CLI. Hooks must never break a turn.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const event = process.argv[2] || process.env.BENCHAGI_SEAT_EVENT || "summary";
  const bin = process.env.BENCHAGI_BIN || "benchagi";
  const debug = process.env.BENCHAGI_SEAT_BRIDGE_DEBUG === "1";
  spawnSync(bin, ["seat-bridge", "capture", "--event", event], {
    input: readStdin(),
    stdio: ["pipe", "ignore", debug ? "inherit" : "ignore"],
    env: process.env,
  });
}

try {
  main();
} catch {
  // best-effort only
}
