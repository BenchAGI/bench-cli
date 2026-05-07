// `benchagi agents list` and `benchagi agents use <name>`.
import { LocalGatewayWsTransport } from "../transport/local-gateway.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { resolveGatewayToken, resolveGatewayPassword } from "../auth/gateway-token.js";
import { c, println } from "../render/ansi.js";
import { loadState, setDefaultAgent } from "../state/state-file.js";
export async function listAgents() {
    const transport = new LocalGatewayWsTransport();
    const reachable = await transport.isReachable();
    if (!reachable) {
        throw Object.assign(new Error("Local OpenClaw Gateway not reachable at ws://127.0.0.1:18789. " +
            "Ensure the gateway is running, or run `openclaw doctor`."), { exitCode: 2 });
    }
    await transport.connect({
        url: "ws://127.0.0.1:18789",
        token: await resolveGatewayToken(),
        password: await resolveGatewayPassword(),
        protocolVersion: PROTOCOL_VERSION,
    });
    try {
        const payload = await transport.request("agents.list");
        const agents = extractAgents(payload);
        return agents;
    }
    finally {
        await transport.close();
    }
}
function extractAgents(payload) {
    if (!payload || typeof payload !== "object")
        return [];
    const obj = payload;
    const arr = (obj.agents ?? obj.list ?? []);
    if (!Array.isArray(arr))
        return [];
    return arr
        .map((a) => {
        if (!a || typeof a !== "object")
            return null;
        const r = a;
        const id = typeof r.id === "string" ? r.id : null;
        if (!id)
            return null;
        const ident = r.identity;
        const model = r.model?.primary;
        return {
            id,
            displayName: ident?.name,
            model,
        };
    })
        .filter((x) => x !== null);
}
export async function commandAgentsList() {
    const agents = await listAgents();
    const state = await loadState();
    if (agents.length === 0) {
        println(c.dim("no agents configured"));
        return;
    }
    for (const a of agents) {
        const isDefault = state.defaultAgent === a.id ? c.bold("✓") : " ";
        const display = a.displayName ?? a.id;
        const model = a.model ? c.dim(`  [${a.model}]`) : "";
        println(`${isDefault} ${c.cyan(a.id.padEnd(24))} ${display}${model}`);
    }
}
export async function commandAgentsUse(name) {
    const agents = await listAgents();
    const resolved = resolveShortName(name, agents);
    if (!resolved) {
        println(c.red(`unknown agent: ${name}`));
        println(c.dim("known agents:"));
        for (const a of agents)
            println(c.dim(`  · ${a.id}`));
        process.exit(5);
    }
    await setDefaultAgent(resolved.id);
    println(`default agent set to ${c.cyan(resolved.id)}`);
}
export function resolveShortName(name, agents) {
    const lower = name.toLowerCase();
    for (const a of agents) {
        if (a.id === name || a.id.toLowerCase() === lower)
            return a;
    }
    for (const a of agents) {
        const trail = a.id.split(/[-_]/).pop()?.toLowerCase() ?? "";
        if (trail === lower)
            return a;
    }
    return null;
}
