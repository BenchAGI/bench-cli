// `benchagi doctor` — SPEC §3 / §12.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalGatewayWsTransport } from "../transport/local-gateway.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { resolveGatewayToken, resolveGatewayPassword } from "../auth/gateway-token.js";
import { c, println } from "../render/ansi.js";
import { loadCreds } from "../state/keychain.js";
import { listAgents } from "./agents.js";
import { commandForgeReport } from "./forge-report.js";
const GATEWAY_WS_URL = "ws://127.0.0.1:18789";
const ok = (msg) => c.green("✓ ") + msg;
const warn = (msg) => c.yellow("⚠ ") + msg;
const bad = (msg) => c.red("✗ ") + msg;
export async function commandDoctor(opts = {}) {
    let exitCode = 0;
    const checks = [];
    const record = (name, status, detail) => {
        checks.push({ name, status, detail });
    };
    // Gateway reachability
    const t = new LocalGatewayWsTransport();
    const reachable = await t.isReachable();
    if (!reachable) {
        println(bad(`local OpenClaw Gateway not reachable at ${GATEWAY_WS_URL}`));
        record("gateway-reachable", "bad", `local OpenClaw Gateway not reachable at ${GATEWAY_WS_URL}`);
        exitCode = 2;
    }
    else {
        println(ok("local OpenClaw Gateway reachable"));
        record("gateway-reachable", "ok", "local OpenClaw Gateway reachable");
    }
    // Connect handshake
    let policy = null;
    if (reachable) {
        try {
            policy = await t.connect({
                url: GATEWAY_WS_URL,
                token: await resolveGatewayToken(),
                password: await resolveGatewayPassword(),
                protocolVersion: PROTOCOL_VERSION,
            });
            println(ok(`gateway protocol v${policy.protocol} (server ${policy.serverVersion})`));
            record("gateway-handshake", "ok", `gateway protocol v${policy.protocol} (server ${policy.serverVersion})`);
            const required = ["chat.send", "chat.history", "sessions.list", "local-seat.capture"];
            const missing = required.filter((m) => !policy.methods.includes(m));
            if (missing.length > 0) {
                println(bad(`missing methods: ${missing.join(", ")}`));
                record("gateway-methods", "bad", `missing methods: ${missing.join(", ")}`);
                exitCode = 6;
            }
            else {
                println(ok("required methods present"));
                record("gateway-methods", "ok", "required methods present");
            }
            const tools = policy.events.includes("session.tool") || policy.methods.length > 0;
            void tools;
            println(c.dim(`  policy: maxPayload=${policy.policy.maxPayload}B, tickInterval=${policy.policy.tickIntervalMs}ms`));
        }
        catch (err) {
            const detail = `gateway handshake failed: ${err instanceof Error ? err.message : String(err)}`;
            println(bad(detail));
            record("gateway-handshake", "bad", detail);
            exitCode = 7;
        }
    }
    // Agents
    if (reachable && policy) {
        try {
            const agents = await listAgents();
            if (agents.length === 0) {
                println(warn("no agents configured (check openclaw.json agents.list)"));
                record("agents", "warn", "no agents configured (check openclaw.json agents.list)");
            }
            else {
                println(ok(`${agents.length} agent(s) discovered`));
                record("agents", "ok", `${agents.length} agent(s) discovered`);
            }
        }
        catch (err) {
            const detail = `agents.list failed: ${err instanceof Error ? err.message : String(err)}`;
            println(warn(detail));
            record("agents", "warn", detail);
        }
    }
    // Auth
    const creds = await loadCreds();
    if (!creds) {
        println(c.dim("⊘ not signed in (Firebase Direct optional in V1)"));
        record("auth", "ok", "not signed in (Firebase Direct optional in V1)");
    }
    else {
        println(ok(`signed in as ${creds.email}`));
        record("auth", "ok", `signed in as ${creds.email}`);
    }
    await t.close();
    // Logs — where to look (and what to attach to a Forge report).
    printLogsSection();
    const failing = checks.some((check) => check.status !== "ok");
    if (opts.report) {
        await commandForgeReport(checks, opts.attachPath);
    }
    else if (failing) {
        println();
        println("Run 'benchagi doctor --report' to file this on the BenchAGI Forge.");
    }
    if (exitCode !== 0)
        process.exit(exitCode);
}
function printLogsSection() {
    const mark = (path, suffix = "") => existsSync(path) ? c.green("✓ ") + path + suffix : c.dim("⊘ ") + c.dim(path + suffix + " (missing)");
    println();
    println(c.bold("Logs"));
    println(c.dim(`  gateway ws: ${GATEWAY_WS_URL}`));
    println(`  ${mark(join(homedir(), ".openclaw", "openclaw.json"))}`);
    const candidates = [
        join(homedir(), ".openclaw", "logs"),
        "/tmp/openclaw",
        join(homedir(), "Library", "Logs", "openclaw"),
    ];
    for (const dir of candidates) {
        println(`  ${mark(dir, "/*")}`);
    }
}
