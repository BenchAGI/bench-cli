#!/usr/bin/env node
// benchagi — streaming-aware CLI for the Bench/OpenClaw agent system (V2).
// V1 ships local-Gateway-WS-primary; cloud-relay v1.1 (ADR-004).
import { run } from "../dist/v2/cli.js";

run(process.argv.slice(2), { invocationName: "benchagi" }).catch((err) => {
  process.stderr.write(`benchagi: ${err?.message ?? String(err)}\n`);
  process.exit(err?.exitCode ?? 1);
});
