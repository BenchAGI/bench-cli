// `benchagi desktop` — open the Claude Code DESKTOP app as a full BenchAGI seat.
// Provisions the seat workspace (settings.local.json env block, branded .claude/,
// operating contract) and fires the claude://code/new deep link on it. The
// desktop session carries the seat via config alone — no spawn env exists.
import { spawn } from "node:child_process";
import { c, eprintln, println } from "../render/ansi.js";
import { provisionDesktopClaudeSeat, readSeatSettingsAgentId } from "../launcher/seat.js";
import { resolveRoster } from "../launcher/roster.js";
const DESKTOP_APP_INSTALL_URL = "https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect";
// Explicit --agent must match or fail loudly (a wrong-agent seat is worse than
// an error). The remembered workspace agent degrades softly to the first
// roster entry so a dock-app click survives entitlement changes.
export function pickDesktopAgent(roster, wanted) {
    const byNameOrId = (value) => roster.find((a) => a.agentId === value || a.name.toLowerCase() === value.toLowerCase());
    const explicit = wanted.explicit?.trim();
    if (explicit) {
        const agent = byNameOrId(explicit);
        if (agent)
            return { agent };
        const known = roster.map((a) => a.agentId).join(", ") || "none";
        return { error: `agent "${explicit}" is not in your roster (available: ${known})` };
    }
    const remembered = wanted.remembered?.trim();
    if (remembered) {
        const agent = byNameOrId(remembered);
        if (agent)
            return { agent };
    }
    const agent = roster[0];
    if (!agent)
        return { error: "no agents available — sign in (benchagi auth login) or check the gateway" };
    return { agent };
}
function openUrl(url) {
    return new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
}
export async function commandDesktop(agentFlag, gatewayUrl) {
    if (process.platform !== "darwin") {
        eprintln("benchagi desktop is macOS-only (it opens the Claude Code desktop app).");
        process.exitCode = 1;
        return;
    }
    const roster = await resolveRoster({ gatewayUrl });
    const picked = pickDesktopAgent(roster, {
        explicit: agentFlag,
        remembered: readSeatSettingsAgentId(),
    });
    if (!picked.agent) {
        eprintln(`benchagi desktop: ${picked.error}`);
        process.exitCode = 1;
        return;
    }
    const agent = picked.agent;
    const { workspace, deepLink } = provisionDesktopClaudeSeat(agent, { gatewayUrl });
    println(`  ${c.cyan("▸")} ${agent.emoji} ${agent.name} · Claude Code desktop seat`);
    println(c.dim(`  workspace: ${workspace}`));
    println(c.dim("  hooks + bridge carried by .claude/settings.local.json"));
    let code;
    try {
        code = await openUrl(deepLink);
    }
    catch {
        code = 1;
    }
    if (code !== 0) {
        eprintln("  could not open the claude:// deep link — is the Claude Code desktop app installed?");
        eprintln(`  install it from: ${DESKTOP_APP_INSTALL_URL}`);
        process.exitCode = code;
        return;
    }
    println(c.dim("  opened the Claude Code desktop app (first launch asks to trust the folder)"));
}
