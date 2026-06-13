// `benchagi install-app` — install/refresh the macOS Dock launcher app.

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { eprintln, println } from "../render/ansi.js";

function packageRoot(): string {
  // dist/v2/commands/install-app.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runScript(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [path], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function commandInstallApp(): Promise<void> {
  if (process.platform !== "darwin") {
    eprintln("benchagi install-app is macOS-only. The terminal CLI is already installed.");
    return;
  }

  const script = join(packageRoot(), "scripts", "make-dock-app.sh");
  if (!(await fileExists(script))) {
    eprintln(`Dock app helper not found: ${script}`);
    process.exit(1);
  }

  const code = await runScript(script);
  if (code !== 0) {
    process.exit(code);
  }
  println("BenchAGI Dock app is installed.");
}
