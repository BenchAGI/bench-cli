// `benchagi install-app` — install/refresh the macOS Dock launcher app.
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { eprintln, println } from "../render/ansi.js";
function packageRoot() {
    // dist/v2/commands/install-app.js -> package root
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function currentCliEntry(root) {
    const argvEntry = process.argv[1];
    if (argvEntry) {
        const candidate = resolve(argvEntry);
        if (await fileExists(candidate)) {
            return candidate;
        }
    }
    const packaged = join(root, "bin", "benchagi.mjs");
    if (await fileExists(packaged)) {
        return packaged;
    }
    return undefined;
}
function runScript(path, env) {
    return new Promise((resolve, reject) => {
        const child = spawn("bash", [path], { stdio: "inherit", env });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
}
export async function commandInstallApp(positional = [], agent) {
    if (process.platform !== "darwin") {
        eprintln("benchagi install-app is macOS-only. The terminal CLI is already installed.");
        return;
    }
    const desktop = positional[0] === "desktop";
    const root = packageRoot();
    const script = join(root, "scripts", desktop ? "make-desktop-app.sh" : "make-dock-app.sh");
    if (!(await fileExists(script))) {
        eprintln(`Dock app helper not found: ${script}`);
        process.exit(1);
    }
    const cliEntry = await currentCliEntry(root);
    const agentId = agent?.trim();
    const code = await runScript(script, {
        ...process.env,
        BENCHAGI_CLI_NODE: process.execPath,
        ...(cliEntry ? { BENCHAGI_CLI_ENTRY: cliEntry } : {}),
        ...(desktop && agentId ? { BENCHAGI_DESKTOP_AGENT: agentId } : {}),
    });
    if (code !== 0) {
        process.exit(code);
    }
    println(desktop ? "Claude Code desktop-seat dock app is installed." : "BenchAGI Dock app is installed.");
}
