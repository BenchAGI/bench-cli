// roster.ts — the agents shown in the launcher picker. Source of truth is the
// user's ENTITLEMENTS (benchagi.com); falls back to the gateway `agents list`
// for dev / no-account so the picker always renders.

import { listAgents, type AgentSummary } from "../commands/agents.js";
import { resolveEntitledAgents } from "./entitlements.js";
import { shortModel as shortModelId } from "./models.js";

export interface LauncherAgent {
  agentId: string;
  name: string;
  role: string;
  model?: string;
  modelShort: string;
  emoji: string;
}

function shortModel(m?: string): string {
  return shortModelId(m) || "—";
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export async function resolveRoster(opts: { gatewayUrl?: string } = {}): Promise<LauncherAgent[]> {
  const entitled = await resolveEntitledAgents();
  if (entitled !== null) {
    return entitled.map((a) => ({
      agentId: a.agentId,
      name: cap(a.name),
      role: a.role,
      model: a.model,
      modelShort: shortModel(a.model),
      emoji: a.emoji,
    }));
  }
  const agents = await listAgents(opts.gatewayUrl).catch(() => [] as AgentSummary[]);
  return agents.map((a) => ({
    agentId: a.id,
    name: cap(a.displayName ?? a.id),
    role: "",
    model: a.model,
    modelShort: shortModel(a.model),
    emoji: "•",
  }));
}
