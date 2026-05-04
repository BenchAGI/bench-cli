// Agent name resolution. Maps friendly short names ("aurelius") onto the
// real OpenClaw agent ids ("kestrel-aurelius") when needed.
import { runOpenclawJson } from "./openclaw.mjs";

const STATIC_ALIASES = {
  aurelius: "kestrel-aurelius",
  // Other agents already use their short id as the canonical id.
};

let _cache = null;

/**
 * Lazy-load the configured agent list and build alias maps.
 * Falls back to STATIC_ALIASES when the gateway is unreachable.
 */
export async function loadAgentIndex() {
  if (_cache) return _cache;
  let agents = [];
  try {
    agents = await runOpenclawJson(["agents", "list", "--json"]);
  } catch {
    // Soft-fail: the user can still use static aliases offline.
    agents = [];
  }
  const byId = new Map();
  const aliases = new Map(Object.entries(STATIC_ALIASES));
  for (const a of agents) {
    if (!a?.id) continue;
    byId.set(a.id, a);
    // Auto-alias the trailing segment after the last dash, e.g. kestrel-aurelius -> aurelius.
    const tail = a.id.split("-").pop();
    if (tail && tail !== a.id && !aliases.has(tail)) {
      aliases.set(tail, a.id);
    }
  }
  _cache = { agents, byId, aliases };
  return _cache;
}

/**
 * Resolve a short name into the canonical agent id.
 * Returns the input unchanged if it already matches a known id.
 *
 * @param {string} name
 */
export async function resolveAgentId(name) {
  if (!name) return name;
  const idx = await loadAgentIndex();
  if (idx.byId.has(name)) return name;
  if (idx.aliases.has(name)) return idx.aliases.get(name);
  // Static fallback when the gateway is offline.
  return STATIC_ALIASES[name] ?? name;
}
