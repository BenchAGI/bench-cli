#!/usr/bin/env node
// bench — thin wrapper around `openclaw` for daily Bench/OpenClaw operations.
import { run } from "../src/cli.mjs";

run(process.argv.slice(2)).catch((err) => {
  // Errors are normalized inside run(); this is a last-resort safety net.
  process.stderr.write(`bench: ${err?.message ?? String(err)}\n`);
  process.exit(err?.exitCode ?? 1);
});
