// Cross-session preferences. SPEC §8.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const STATE_DIR = join(homedir(), ".config", "benchagi");
const STATE_PATH = join(STATE_DIR, "state.json");
const DEFAULT_STATE = {
    version: 1,
    recentAgents: [],
    perAgent: {},
};
export async function loadState() {
    try {
        const raw = await readFile(STATE_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1) {
            // Future migrations live here.
            return DEFAULT_STATE;
        }
        return {
            version: 1,
            defaultAgent: parsed.defaultAgent,
            recentAgents: Array.isArray(parsed.recentAgents)
                ? parsed.recentAgents.slice(0, 10)
                : [],
            perAgent: typeof parsed.perAgent === "object" && parsed.perAgent !== null
                ? parsed.perAgent
                : {},
        };
    }
    catch (err) {
        if (typeof err === "object" &&
            err !== null &&
            "code" in err &&
            err.code === "ENOENT") {
            return DEFAULT_STATE;
        }
        throw err;
    }
}
export async function saveState(state) {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
export async function setDefaultAgent(agentId) {
    const state = await loadState();
    state.defaultAgent = agentId;
    state.recentAgents = [agentId, ...state.recentAgents.filter((a) => a !== agentId)].slice(0, 10);
    await saveState(state);
}
export async function recordRecent(agentId) {
    const state = await loadState();
    state.recentAgents = [agentId, ...state.recentAgents.filter((a) => a !== agentId)].slice(0, 10);
    await saveState(state);
}
export async function getProjectAgent() {
    // Project-scoped override at .benchagi/agent
    const projectAgentPath = join(process.cwd(), ".benchagi", "agent");
    try {
        const s = await stat(projectAgentPath);
        if (!s.isFile())
            return undefined;
        const raw = await readFile(projectAgentPath, "utf8");
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    catch {
        return undefined;
    }
}
export async function setPerAgent(agentId, patch) {
    const state = await loadState();
    state.perAgent[agentId] = { ...state.perAgent[agentId], ...patch };
    await saveState(state);
}
