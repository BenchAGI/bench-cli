import { spawn } from "node:child_process";

const FIXED_CHILD_PATH = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Tailscale.app/Contents/MacOS";
const NON_SECRET_CONTEXT = new Set([
  "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR",
]);

/**
 * Build ordinary subprocess context without ambient credential or runtime-hook
 * variables. Credentialed effects use GateKeeper's stricter, one-secret child
 * environment instead.
 */
export function nonSecretChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { PATH: FIXED_CHILD_PATH };
  for (const name of NON_SECRET_CONTEXT) {
    const value = source[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

export type CapturedProcess = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export async function runCaptured(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    maxBytes?: number;
    extraFdInput?: string;
  } = {},
): Promise<CapturedProcess> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  return await new Promise((resolve) => {
    let settled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? nonSecretChildEnvironment(),
      detached: process.platform !== "win32",
      stdio: options.extraFdInput === undefined
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", "pipe"],
    });
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= maxBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxBytes - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      const killTree = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
      };
      killTree("SIGTERM");
      const force = setTimeout(() => killTree("SIGKILL"), 500);
      force.unref();
    }, timeoutMs);
    timer.unref();
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
      });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
    child.stdin?.end(options.input ?? "");
    if (options.extraFdInput !== undefined) {
      const stream = child.stdio[3];
      if (stream && "end" in stream) stream.end(options.extraFdInput);
    }
  });
}
