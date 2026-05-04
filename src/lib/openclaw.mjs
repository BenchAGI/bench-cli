// Shared helpers for invoking the underlying `openclaw` CLI.
import { spawn } from "node:child_process";

export const OPENCLAW_BIN = process.env.BENCH_OPENCLAW_BIN || "openclaw";

/**
 * Run `openclaw` with the given args and return { code, stdout, stderr }.
 * Never inherits TTY; we always capture output for predictable parsing.
 *
 * @param {string[]} args
 * @param {{ verbose?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runOpenclaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Stream `openclaw` output straight to the user's terminal (stdout/stderr inherit).
 * Used by interactive flows like `bench chat`.
 */
export function streamOpenclaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0 }));
  });
}

/**
 * Run `openclaw ... --json` and return the parsed JSON, with banner / config
 * warning noise filtered out. Throws a typed error if parsing fails.
 *
 * The `openclaw` CLI prefixes JSON output with config warnings and a banner;
 * we strip everything before the first `{` or `[` token at the start of a line.
 *
 * @template T
 * @param {string[]} args
 * @returns {Promise<T>}
 */
export async function runOpenclawJson(args) {
  const { code, stdout, stderr } = await runOpenclaw(args);
  if (code !== 0) {
    const err = new Error(
      `openclaw exited with code ${code}\n${cleanStderr(stderr)}`,
    );
    err.exitCode = code;
    err.stderr = stderr;
    throw err;
  }
  // Some openclaw subcommands (e.g. `commitments list --json`) emit their JSON
  // payload on stderr rather than stdout. Try stdout first, then stderr.
  let json = extractJson(stdout);
  if (json === null) json = extractJson(stderr);
  if (json === null) {
    const err = new Error(
      `Could not parse JSON from openclaw output.\n--- stdout ---\n${stdout.slice(0, 800)}\n--- stderr ---\n${cleanStderr(stderr).slice(0, 400)}`,
    );
    err.exitCode = 2;
    throw err;
  }
  return json;
}

/**
 * Extract the first JSON value from a buffer that may contain banner text.
 * Returns null if no JSON value can be parsed.
 *
 * @param {string} text
 */
export function extractJson(text) {
  if (!text) return null;
  // Find the first `{` or `[` at start of a line, then try to parse from there.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const candidate = lines.slice(i).join("\n");
      try {
        return JSON.parse(candidate);
      } catch {
        // try a more aggressive bounded scan below
      }
    }
  }
  // Fallback: take from first `{`/`[` to last `}`/`]`.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start < 0) return null;
  const endObj = text.lastIndexOf("}");
  const endArr = text.lastIndexOf("]");
  const end = Math.max(endObj, endArr);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Strip the noisy "Config warnings" preamble and the lobster banner from
 * stderr/stdout so error messages stay readable.
 *
 * @param {string} text
 */
export function cleanStderr(text) {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^Config warnings:/.test(line)) return false;
      if (/^- plugins\./.test(line)) return false;
      if (/^🦞 OpenClaw /.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}
