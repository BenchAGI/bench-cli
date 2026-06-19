// Cross-session preferences. SPEC §8.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Liveness = "auto" | "always" | "stream" | "batch" | "off";

export type PerAgentState = {
  liveness?: Liveness;
};

// Per-instance seat preferences, persisted across sessions so the seat launches
// in the right mode for whichever instance you're operating. `effort` maps to
// Claude Code's `--effort` launch flag. (ultracode is NOT here yet: the `claude`
// CLI has no launch flag for it — see seat.ts; that's a tracked follow-up.)
export type PerInstanceState = {
  effort?: string;
};

export type State = {
  version: 1;
  defaultAgent?: string;
  recentAgents: string[];
  perAgent: Record<string, PerAgentState>;
  perInstance: Record<string, PerInstanceState>;
};

const STATE_DIR = join(homedir(), ".config", "benchagi");
const STATE_PATH = join(STATE_DIR, "state.json");

const DEFAULT_STATE: State = {
  version: 1,
  recentAgents: [],
  perAgent: {},
  perInstance: {},
};

export async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
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
        ? (parsed.perAgent as Record<string, PerAgentState>)
        : {},
      perInstance: typeof parsed.perInstance === "object" && parsed.perInstance !== null
        ? (parsed.perInstance as Record<string, PerInstanceState>)
        : {},
    };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return DEFAULT_STATE;
    }
    throw err;
  }
}

export async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export async function setDefaultAgent(agentId: string): Promise<void> {
  const state = await loadState();
  state.defaultAgent = agentId;
  state.recentAgents = [agentId, ...state.recentAgents.filter((a) => a !== agentId)].slice(0, 10);
  await saveState(state);
}

export async function recordRecent(agentId: string): Promise<void> {
  const state = await loadState();
  state.recentAgents = [agentId, ...state.recentAgents.filter((a) => a !== agentId)].slice(0, 10);
  await saveState(state);
}

export async function getProjectAgent(): Promise<string | undefined> {
  // Project-scoped override at .benchagi/agent
  const projectAgentPath = join(process.cwd(), ".benchagi", "agent");
  try {
    const s = await stat(projectAgentPath);
    if (!s.isFile()) return undefined;
    const raw = await readFile(projectAgentPath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function setPerAgent(
  agentId: string,
  patch: PerAgentState,
): Promise<void> {
  const state = await loadState();
  state.perAgent[agentId] = { ...state.perAgent[agentId], ...patch };
  await saveState(state);
}

// Per-instance seat preference: the effort the seat launches with for a given
// instance, so each workspace keeps its own mode across sessions. Empty/blank
// instanceId is ignored (no global bucket — avoids one instance's mode leaking
// to an unidentified launch).
export async function getPerInstanceEffort(instanceId: string): Promise<string | undefined> {
  if (!instanceId.trim()) return undefined;
  const state = await loadState();
  return state.perInstance[instanceId]?.effort;
}

export async function setPerInstanceEffort(instanceId: string, effort: string): Promise<void> {
  if (!instanceId.trim() || !effort.trim()) return;
  const state = await loadState();
  state.perInstance[instanceId] = { ...state.perInstance[instanceId], effort };
  await saveState(state);
}
