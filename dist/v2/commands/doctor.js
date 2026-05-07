// `benchagi doctor` — SPEC §3 / §12.
import { LocalGatewayWsTransport } from "../transport/local-gateway.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { resolveGatewayToken, resolveGatewayPassword } from "../auth/gateway-token.js";
import { c, println } from "../render/ansi.js";
import { loadCreds } from "../state/keychain.js";
import { listAgents } from "./agents.js";
const ok = (msg) => c.green("✓ ") + msg;
const warn = (msg) => c.yellow("⚠ ") + msg;
const bad = (msg) => c.red("✗ ") + msg;
export async function commandDoctor() {
    let exitCode = 0;
    // Gateway reachability
    const t = new LocalGatewayWsTransport();
    const reachable = await t.isReachable();
    if (!reachable) {
        println(bad("local OpenClaw Gateway not reachable at ws://127.0.0.1:18789"));
        exitCode = 2;
    }
    else {
        println(ok("local OpenClaw Gateway reachable"));
    }
    // Connect handshake
    let policy = null;
    if (reachable) {
        try {
            policy = await t.connect({
                url: "ws://127.0.0.1:18789",
                token: await resolveGatewayToken(),
                password: await resolveGatewayPassword(),
                protocolVersion: PROTOCOL_VERSION,
            });
            println(ok(`gateway protocol v${policy.protocol} (server ${policy.serverVersion})`));
            const required = ["chat.send", "chat.history", "sessions.list"];
            const missing = required.filter((m) => !policy.methods.includes(m));
            if (missing.length > 0) {
                println(bad(`missing methods: ${missing.join(", ")}`));
                exitCode = 6;
            }
            else {
                println(ok("required methods present"));
            }
            const tools = policy.events.includes("session.tool") || policy.methods.length > 0;
            void tools;
            println(c.dim(`  policy: maxPayload=${policy.policy.maxPayload}B, tickInterval=${policy.policy.tickIntervalMs}ms`));
        }
        catch (err) {
            println(bad(`gateway handshake failed: ${err instanceof Error ? err.message : String(err)}`));
            exitCode = 7;
        }
    }
    // Agents
    if (reachable && policy) {
        try {
            const agents = await listAgents();
            if (agents.length === 0) {
                println(warn("no agents configured (check openclaw.json agents.list)"));
            }
            else {
                println(ok(`${agents.length} agent(s) discovered`));
            }
        }
        catch (err) {
            println(warn(`agents.list failed: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    // Auth
    const creds = await loadCreds();
    if (!creds) {
        println(c.dim("⊘ not signed in (Firebase Direct optional in V1)"));
    }
    else {
        println(ok(`signed in as ${creds.email}`));
    }
    await t.close();
    if (exitCode !== 0)
        process.exit(exitCode);
}
