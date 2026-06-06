// roster.ts — the agents shown in the launcher picker. Source of truth is the
// user's ENTITLEMENTS (benchagi.com); falls back to the gateway `agents list`
// for dev / no-account so the picker always renders.

import { listAgents, type AgentSummary } from "../commands/agents.js";
import { resolveEntitledAgents } from "./entitlements.js";

export interface LauncherAgent {
  agentId: string;
  name: string;
  role: string;
  model?: string;
  modelShort: string;
  emoji: string;
}

const MODEL_SHORT: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};

function shortModel(m?: string): string {
  if (!m) return "—";
  return MODEL_SHORT[m] ?? m;
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export async function resolveRoster(): Promise<LauncherAgent[]> {
  const entitled = await resolveEntitledAgents().catch(() => null);
  if (entitled && entitled.length) {
    return entitled.map((a) => ({
      agentId: a.agentId,
      name: cap(a.name),
      role: a.role,
      model: a.model,
      modelShort: shortModel(a.model),
      emoji: a.emoji,
    }));
  }
  const agents = await listAgents().catch(() => [] as AgentSummary[]);
  return agents.map((a) => ({
    agentId: a.id,
    name: cap(a.displayName ?? a.id),
    role: "",
    model: a.model,
    modelShort: shortModel(a.model),
    emoji: "•",
  }));
}
