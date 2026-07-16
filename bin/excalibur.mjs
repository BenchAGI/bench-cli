#!/usr/bin/env node
// excalibur — Grok-first unified contact surface (beta preview).
import { run } from "../dist/v2/cli.js";

run(process.argv.slice(2), { invocationName: "excalibur" }).catch((err) => {
  process.stderr.write(`excalibur: ${err?.message ?? String(err)}\n`);
  process.exit(err?.exitCode ?? 1);
});
