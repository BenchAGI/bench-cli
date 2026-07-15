import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { loadUcpConfig } from "./config.js";
import { GateKeeper } from "./gatekeeper.js";
import { GrantStore } from "./grants.js";
import { UCP_SCHEMA_VERSION } from "./types.js";
function localTailnetIps() {
    return Object.values(networkInterfaces()).flatMap((items) => (items || []))
        .filter((item) => item.family === "IPv4" && item.address.startsWith("100.64."))
        .map((item) => item.address);
}
function deriveRole(ips) {
    if (ips.includes("100.64.0.3"))
        return "brain:mini1/aerie";
    if (ips.includes("100.64.0.10"))
        return "hot-twin:mini2";
    if (ips.includes("100.64.0.1"))
        return "node:macbook";
    return "unknown";
}
async function httpReachability(fetchImpl, url) {
    if (!url)
        return "missing";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    timer.unref();
    try {
        const response = await fetchImpl(url, {
            method: "HEAD",
            redirect: "manual",
            signal: controller.signal,
            headers: { "user-agent": "excalibur-ucp-health/1" },
        });
        return `http_${response.status}`;
    }
    catch {
        return "unreachable";
    }
    finally {
        clearTimeout(timer);
    }
}
function ghIdentity(env) {
    const declared = env.EXCALIBUR_GITHUB_USER?.trim();
    if (declared && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(declared)) {
        return { state: "locked", summary: `${declared} · declared metadata only; auth was not accessed and publish remains GateKeeper/broker-locked` };
    }
    return { state: "locked", summary: "unverified without credential access · set EXCALIBUR_GITHUB_USER for non-secret display metadata" };
}
function successfulHttpProbe(result) {
    return /^http_[23]\d\d$/.test(result);
}
async function operatorPolicy(env) {
    const home = env.GROK_HOME?.trim();
    if (!home)
        return { state: "missing", summary: "native operator profile not in this process; effective policy unverified" };
    const configPath = join(home, "config.toml");
    const requirementsPath = join(home, "requirements.toml");
    const [config, requirements] = await Promise.all([
        readFile(configPath, "utf8").catch(() => ""),
        access(requirementsPath, constants.R_OK).then(() => true).catch(() => false),
    ]);
    const permission = config.match(/^permission_mode\s*=\s*"([^"]+)"/m)?.[1] || "missing";
    if (permission !== "default" || !requirements) {
        return { state: "drift", summary: `effective profile drift · permission ${permission} · requirements ${requirements ? "present" : "missing"}` };
    }
    return { state: "ready", summary: "permission default · requirements present" };
}
async function mailDraftPosture(directory) {
    if (!directory) {
        return { id: "mail.draft", state: "missing", summary: "blocked · draft directory is missing_config" };
    }
    const info = await lstat(directory).catch(() => null);
    const uid = typeof process.getuid === "function" ? process.getuid() : info?.uid;
    if (!info?.isDirectory() || info.isSymbolicLink()) {
        return { id: "mail.draft", state: "blocked", summary: `${directory} · draft directory is absent or not a real directory` };
    }
    if (info.uid !== uid || (info.mode & 0o077) !== 0) {
        return { id: "mail.draft", state: "drift", summary: `${directory} · draft directory must be owner-private` };
    }
    return { id: "mail.draft", state: "ready", summary: `${directory} · owner-private local drafts only · no send` };
}
export async function collectSessionHealthCard(deps = {}) {
    const env = deps.env ?? process.env;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const gatekeeper = deps.gatekeeper ?? new GateKeeper();
    const grants = deps.grants ?? new GrantStore(env);
    const loaded = await loadUcpConfig(env);
    const config = loaded.config;
    const ips = localTailnetIps();
    const observedRole = deriveRole(ips);
    const gatewayTarget = env.EXCALIBUR_OPENCLAW_GATEWAY?.trim() || config.openclaw.gatewayTarget;
    const [openclaw, memory, meshControl, derp, gate, policy, openGrants, mailDraft] = await Promise.all([
        httpReachability(fetchImpl, gatewayTarget),
        httpReachability(fetchImpl, config.memory.remoteMcpUrl),
        httpReachability(fetchImpl, config.mesh.controlUrl),
        httpReachability(fetchImpl, config.mesh.derpUrl),
        gatekeeper.status(),
        operatorPolicy(env),
        grants.getOpen(),
        mailDraftPosture(config.mail.draftDirectory),
    ]);
    const lines = [];
    lines.push({
        id: "identity",
        state: observedRole === "unknown" ? "drift" : "ready",
        summary: `${userInfo().username}@${hostname()} · tailnet ${ips.join(",") || "unobserved"} · role ${observedRole}`,
    });
    const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(gatewayTarget);
    lines.push({
        id: "openclaw.gateway",
        state: successfulHttpProbe(openclaw) ? "locked" : "blocked",
        summary: `${gatewayTarget} · public probe ${openclaw} · identity/auth not consumed · owner expected mini1/aerie${loopback ? " · loopback is a forward, not local brain proof" : ""}`,
    });
    lines.push({
        id: "openclaw.slack_owner",
        state: "locked",
        summary: "expected mini1 at rest; actual socket owner requires a typed broker probe · never start a MacBook bridge",
    });
    lines.push({
        id: "memory.remote_mcp",
        state: successfulHttpProbe(memory) ? "live" : "blocked",
        summary: `${config.memory.remoteMcpUrl || "missing_config"} · ${memory} · separate from CarbonWhite embed/rerank`,
    });
    lines.push({
        id: "bench.chassis",
        state: !config.bench.apiBase || !config.bench.secretRef ? "missing" : "locked",
        summary: !config.bench.apiBase || !config.bench.secretRef
            ? `missing_config · create/reference 1Password item “${config.bench.requiredItem}”; no markdown fallback`
            : `${config.bench.apiBase} · configured; run bench.health with Touch ID for live truth`,
    });
    lines.push({
        id: "mesh.flyway",
        state: successfulHttpProbe(meshControl) && successfulHttpProbe(derp) ? "locked" : "blocked",
        summary: `control ${meshControl} · DERP ${derp} · admin ${config.mesh.secretRef ? "locked" : `missing_config (${config.mesh.requiredItem})`} · multitenant customer isolation unproven`,
    });
    lines.push({
        id: "gatekeeper.1password",
        state: gate.installed && gate.userPresence ? "locked" : "missing",
        summary: gate.installed && gate.userPresence
            ? "1Password bridge present · Touch ID available · locked until named effect access"
            : `1Password CLI ${gate.installed ? "present" : "missing"} · Touch ID ${gate.userPresence ? "available" : "unavailable"}`,
    });
    const gh = ghIdentity(env);
    lines.push({ id: "github.user", state: gh.state, summary: gh.summary });
    lines.push({
        id: "mcp.matrix",
        state: "locked",
        summary: `OpenClaw ${openclaw} · memory-remote ${memory} · GitHub ${gh.state} · Slack/Playwright unverified`,
    });
    lines.push({ id: "operator.policy", state: policy.state, summary: policy.summary });
    lines.push(mailDraft);
    lines.push({
        id: "mail.read",
        state: "blocked",
        summary: "unavailable · no mailbox-read effect is registered and no message content was read",
    });
    lines.push({
        id: "mail.send",
        state: "blocked",
        summary: "hard-denied · MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED",
    });
    lines.push({
        id: "capabilities",
        state: "ready",
        summary: `modes observe,prepare · open grants ${openGrants.length ? openGrants.map((item) => `${item.grantId}:${item.mode}`).join(",") : "none"}`,
    });
    if (loaded.exists && loaded.safeFile !== true) {
        lines.push({ id: "config.mode", state: "drift", summary: `${loaded.path} must be a non-symlinked owner-private file in an owner-controlled directory` });
    }
    const blockers = lines.filter((line) => ["blocked", "missing", "drift", "locked", "stub"].includes(line.state)).map((line) => line.id);
    return {
        schemaVersion: UCP_SCHEMA_VERSION,
        observedAt: new Date().toISOString(),
        identity: `${userInfo().username}@${hostname()}`,
        expectedRole: "brain:mini1/aerie",
        observedRole,
        capabilityModes: ["observe", "prepare", ...new Set(openGrants.map((grant) => grant.mode))],
        openGrantIds: openGrants.map((grant) => grant.grantId),
        lines,
        blockers,
    };
}
export function renderSessionHealthCard(card) {
    return [
        `UCP session health · ${card.observedAt}`,
        `  identity: ${card.identity} · observed ${card.observedRole} · expected brain ${card.expectedRole}`,
        ...card.lines.map((line) => `  ${line.state.padEnd(7)} ${line.id}: ${line.summary}`),
        `  blockers: ${card.blockers.length ? card.blockers.join(", ") : "none"}`,
        `  claim: ${card.blockers.length ? "full customer onboarding capability is NOT established" : "declared capabilities match observed probes"}`,
    ];
}
