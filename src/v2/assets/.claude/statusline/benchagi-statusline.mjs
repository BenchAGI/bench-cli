#!/usr/bin/env node
// benchagi-statusline.mjs — Claude Code statusLine for a BenchAGI local seat.
// Renders one branded line:  🦅 Aurelius · Opus 4.8 · coo · ⎇ main · benchagi
// The agent is resolved from BENCH_AGENT_* env vars the seat sets (the product CLI
// has no crew.json), and a pending attention/notification is surfaced at the FRONT
// from state/bench-attention.json. Fast, synchronous, never throws. Local-only.
import fs from "node:fs";
import path from "node:path";

const IR = "\x1b[38;2;255;45;85m"; // #ff2d55
const DIM = "\x1b[38;2;124;124;135m";
const COPPER = "\x1b[38;2;196;122;58m";
const AMBER = "\x1b[38;2;255;184;74m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ATTENTION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function gitBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}

function attentionSegment(root) {
  const a = readJson(path.join(root, "state", "bench-attention.json"));
  if (!a || !a.message) return null;
  if (a.ts && Date.now() - a.ts > ATTENTION_MAX_AGE_MS) return null;
  const msg = String(a.message).replace(/\s+/g, " ").trim().slice(0, 52);
  if (!msg) return null;
  const style = a.level === "blocked" ? `${IR}${BOLD}⛔` : a.level === "info" ? `${DIM}ℹ` : `${AMBER}${BOLD}🔔`;
  return `${style} ${msg}${RESET}`;
}

function main() {
  const input = readInput();
  const env = process.env;
  const root =
    input.workspace?.project_dir ||
    env.CLAUDE_PROJECT_DIR ||
    input.workspace?.current_dir ||
    input.cwd ||
    process.cwd();

  const emoji = env.BENCH_AGENT_EMOJI || "🦅";
  const name = env.BENCH_AGENT_NAME || "BenchAGI";
  const modelShort = env.BENCH_AGENT_MODEL_SHORT || input.model?.display_name || "—";
  const role = env.BENCH_AGENT_ROLE || "";
  const branch = gitBranch(root);

  const parts = [`${emoji} ${IR}${name}${RESET}`, `${COPPER}${modelShort}${RESET}`];
  if (role) parts.push(`${DIM}${role}${RESET}`);
  if (branch) parts.push(`${DIM}⎇ ${branch}${RESET}`);
  parts.push(`${DIM}benchagi${RESET}`);

  const attention = attentionSegment(root);
  const line = parts.join(`${DIM} · ${RESET}`);
  process.stdout.write(attention ? `${attention}${DIM}  ·  ${RESET}${line}` : line);
}

try {
  main();
} catch {
  process.stdout.write("🦅 benchagi");
}
