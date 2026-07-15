import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { commandAuthLogin, commandAuthLogout, commandAuthStatus } from "../commands/auth.js";
import { CLI_VERSION, commandVersion } from "../commands/version.js";
import { inspectCliPathShadows } from "../diagnostics/path-shadow.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { loadAccount } from "../launcher/account.js";
import { EntitlementResolutionError, resolveEntitledAgents } from "../launcher/entitlements.js";
import { c, println } from "../render/ansi.js";
import { resolveStateScope, scopeDirectory } from "../state/scope.js";
import { runUcpCommand } from "../ucp/cli.js";
import { collectSessionHealthCard, renderSessionHealthCard } from "../ucp/health.js";
import { EffectRegistry } from "../ucp/registry.js";
import { activateTenantCloudReadOnly, runExcaliburConversation, } from "./conversation.js";
import { renderCapabilities, renderReceiptPage, renderSnapshot } from "./control-render.js";
import { ExcaliburHttpTransport, resolveSidecarConnection } from "./http-transport.js";
import { inspectExcaliburLaunchers, verifyCanonicalLauncherManifest, } from "./launcher-integrity.js";
import { resolveOrchestraBrokerConfig } from "./orchestra-broker.js";
import { disableOperatorCalendar, parseOperatorCalendarConfigureArgs, readOperatorCalendarConfig, renderOperatorCalendarStatus, writeOperatorCalendarConfig, } from "./operator-calendar.js";
import { disableOperatorMemory, parseOperatorMemoryConfigureArgs, readOperatorMemoryConfig, renderOperatorMemoryStatus, writeOperatorMemoryConfig, } from "./operator-memory.js";
import { renderOneSurfaceStartupBrief, renderSidecarMemoryStatus, summarizeOneSurfaceReadiness, } from "./readiness.js";
import { loadExcaliburState, scopedStatePath, setSelectedContext, stateFileMode, } from "./scoped-state.js";
const COMMANDS = new Set([
    "ask",
    "resume",
    "sessions",
    "context",
    "health",
    "effects",
    "effect",
    "grant",
    "grants",
    "might",
    "views",
    "actions",
    "receipts",
    "seats",
    "providers",
    "memory",
    "calendar",
    "auth",
    "doctor",
    "version",
    "help",
]);
const UCP_COMMANDS = new Set(["health", "effects", "effect", "grant", "grants"]);
export async function runExcalibur(argv) {
    const parsed = parseArgs(argv);
    if (parsed.version || parsed.command === "version") {
        await commandVersion("excalibur");
        return;
    }
    if (parsed.help || parsed.command === "help") {
        printHelp();
        return;
    }
    if (parsed.command === "auth") {
        await runAuth(parsed.positional);
        return;
    }
    const env = process.env;
    if (parsed.command && UCP_COMMANDS.has(parsed.command)) {
        await runUcpCommand(parsed.command, parsed.positional, env);
        return;
    }
    const scope = await resolveStateScope({ env });
    const state = await loadExcaliburState({ scope, env });
    switch (parsed.command) {
        case "context":
            await runContext(parsed.positional, scope, state, env);
            return;
        case "might":
            await runMight(parsed, scope, state, env);
            return;
        case "sessions":
            printSessions(state);
            return;
        case "receipts": {
            const transport = await resolveControlReadTransport(parsed, scope, state, env);
            printControlLines(renderReceiptPage(await transport.getReceipts({ limit: 100 })));
            return;
        }
        case "views": {
            const transport = await resolveControlReadTransport(parsed, scope, state, env);
            printControlLines(renderSnapshot(await transport.getSnapshot()));
            return;
        }
        case "actions": {
            const transport = await resolveControlReadTransport(parsed, scope, state, env);
            printControlLines(renderCapabilities(await transport.getCapabilities(), "action"));
            return;
        }
        case "seats":
            await printSeats(parsed, scope, state, env);
            return;
        case "providers":
            await runProviders(parsed.positional, scope, env);
            return;
        case "memory":
            await runMemory(parsed.positional, parsed, scope, state, env);
            return;
        case "calendar":
            await runCalendar(parsed.positional, state, env);
            return;
        case "doctor":
            await runDoctor(parsed, scope, state, env);
            return;
        case "resume": {
            const id = parsed.positional[0];
            if (!id)
                throw Object.assign(new Error("usage: excalibur resume <session-id> [message]"), { exitCode: 2 });
            const session = state.sessions.find((item) => item.sessionId === id);
            if (!session)
                throw Object.assign(new Error(`unknown scoped session: ${id}`), { exitCode: 5 });
            const allowed = await availableContexts(scope, env);
            if (!allowed.includes(session.contextId)) {
                throw Object.assign(new Error("session context is not available to the current principal and instance"), { exitCode: 13 });
            }
            await printUcpBootHealth(env);
            await runExcaliburConversation({
                env,
                scope,
                contextId: session.contextId,
                resume: session,
                message: parsed.positional.slice(1).join(" ").trim() || undefined,
                classic: parsed.classic,
                full: parsed.full,
                noThinking: parsed.noThinking,
                sidecarUrl: parsed.sidecarUrl,
                traceFramesPath: parsed.traceFramesPath,
            });
            return;
        }
        case "ask": {
            const message = parsed.positional.join(" ").trim();
            if (!message)
                throw Object.assign(new Error("usage: excalibur ask <message>"), { exitCode: 2 });
            await launchConversation(parsed, scope, state, env, message);
            return;
        }
        default: {
            let message = parsed.positional.join(" ").trim();
            if (!message && !process.stdin.isTTY)
                message = await readPipedPrompt();
            await launchConversation(parsed, scope, state, env, message || undefined);
        }
    }
}
async function launchConversation(parsed, scope, state, env, message) {
    const allowed = await availableContexts(scope, env);
    if (!allowed.includes(state.selectedContext)) {
        throw Object.assign(new Error(`selected context ${state.selectedContext} is outside the current principal/instance boundary; run \`excalibur context use operator-local\``), { exitCode: 13 });
    }
    await printUcpBootHealth(env);
    await runExcaliburConversation({
        env,
        scope,
        contextId: state.selectedContext,
        message,
        classic: parsed.classic,
        full: parsed.full,
        noThinking: parsed.noThinking,
        sidecarUrl: parsed.sidecarUrl,
        traceFramesPath: parsed.traceFramesPath,
    });
}
async function printUcpBootHealth(env) {
    try {
        const execution = await new EffectRegistry({ env }).execute({ effectId: "session.health_card", input: {} });
        const card = execution.result.output;
        if (!card)
            throw new Error("health card absent");
        for (const [index, line] of renderSessionHealthCard(card).entries()) {
            println(index === 0 ? c.bold(line) : c.dim(line));
        }
        println(c.dim(`  health receipt: ${execution.receipt.receiptId}`));
    }
    catch {
        println(c.red("UCP session health unavailable · full onboarding/publish capability must not be claimed"));
    }
}
async function readPipedPrompt() {
    process.stdin.setEncoding("utf8");
    let value = "";
    for await (const chunk of process.stdin)
        value += String(chunk);
    return value.trim();
}
async function availableContexts(scope, env) {
    const account = await loadAccount(env);
    const contexts = new Set(["operator-local"]);
    const instance = env.EXCALIBUR_INSTANCE_ID?.trim() || env.BENCHAGI_INSTANCE_ID?.trim() || account?.instanceId?.trim();
    if (instance && instance !== "unbound" && instance !== "operator-local" && instance === scope.instanceId) {
        contexts.add(instance);
    }
    return [...contexts];
}
async function runContext(args, scope, state, env) {
    const subcommand = args[0] || "list";
    const contexts = await availableContexts(scope, env);
    if (subcommand === "list") {
        println(c.bold("Contexts"));
        for (const context of contexts) {
            const active = state.selectedContext === context ? c.green("●") : c.dim("○");
            const lane = context === "operator-local" ? "shared desktop/CLI sidecar" : "customer instance · explicit tenant control session";
            println(`  ${active} ${context} ${c.dim(`— ${lane}`)}`);
        }
        return;
    }
    if (subcommand === "use") {
        const context = args[1];
        if (!context)
            throw Object.assign(new Error("usage: excalibur context use <context-id>"), { exitCode: 2 });
        if (!contexts.includes(context)) {
            throw Object.assign(new Error(`context ${context} is not bound to the current principal and instance`), { exitCode: 13 });
        }
        await setSelectedContext(context, { scope, env });
        println(`active context: ${c.cyan(context)}`);
        return;
    }
    throw Object.assign(new Error("usage: excalibur context <list|use>"), { exitCode: 2 });
}
function printSessions(state) {
    println(c.bold("Scoped sessions"));
    if (state.sessions.length === 0) {
        println(c.dim("  no sessions yet"));
        return;
    }
    for (const session of state.sessions) {
        println(`  ${c.cyan(session.sessionId)}  ${session.provider}  ${session.contextId}  ${session.status}  ${c.dim(session.updatedAt)}`);
    }
    println(c.dim("Resume requires the full scoped session id: excalibur resume <session-id>"));
}
function printControlLines(lines) {
    for (const [index, line] of lines.entries())
        println(index === 0 ? c.bold(line) : line);
}
async function resolveControlReadTransport(parsed, scope, state, env) {
    const contexts = await availableContexts(scope, env);
    if (!contexts.includes(state.selectedContext)) {
        throw Object.assign(new Error(`selected context ${state.selectedContext} is outside the current principal/instance boundary`), { exitCode: 13 });
    }
    const conversationScope = state.selectedContext === "operator-local"
        ? { kind: "operator" }
        : { kind: "tenant", instanceId: state.selectedContext };
    try {
        const connectionEnv = parsed.sidecarUrl
            ? { ...env, EXCALIBUR_SIDECAR_URL: parsed.sidecarUrl }
            : env;
        const sidecar = await resolveSidecarConnection(connectionEnv);
        const transport = new ExcaliburHttpTransport({
            baseUrl: sidecar.baseUrl,
            posture: "sidecar",
            scope: conversationScope,
            accessToken: sidecar.token,
            cloudAccessToken: conversationScope.kind === "tenant"
                ? async () => (await loadFreshFirebaseIdToken().catch(() => null)) || undefined
                : undefined,
        });
        await transport.getControlSession();
        return transport;
    }
    catch (error) {
        if (conversationScope.kind !== "tenant") {
            throw Object.assign(new Error("shared Excalibur loopback sidecar is unavailable; operator reads have no cloud fallback"), { exitCode: 6, cause: error });
        }
        const reason = error instanceof Error && "code" in error
            ? String(error.code).toLowerCase().replaceAll("_", "-")
            : "sidecar-unavailable";
        const transport = await activateTenantCloudReadOnly({
            env,
            scope,
            contextId: state.selectedContext,
        }, reason);
        println(c.yellow("authenticated cloud read-only mode · chat, approval, and effects locked"));
        return transport;
    }
}
async function printSeats(parsed, scope, state, env) {
    println(c.bold("Inference seats"));
    const transport = await resolveControlReadTransport(parsed, scope, state, env);
    const [controlSession, snapshot, capabilities] = await Promise.all([
        transport.getControlSession(),
        transport.getSnapshot(),
        transport.getCapabilities(),
    ]);
    const readiness = summarizeOneSurfaceReadiness({ controlSession, snapshot, capabilities });
    println(`  posture: ${readiness.posture} · ${transport.posture === "sidecar" ? "shared sidecar" : "authenticated cloud read-only"}`);
    for (const seat of readiness.health.seats) {
        const model = seat.servedModel
            ? `${seat.provider || "provider"}:${seat.servedModel}`
            : "model/attestation unavailable";
        println(`  ${seat.state.padEnd(11)} ${seat.role}/${seat.seatId} · ${model}`);
        if (seat.requestedModel)
            println(c.dim(`    requested: ${seat.requestedModel} · served: ${seat.servedModel || "unavailable"}`));
        if (seat.attestationDigest)
            println(c.dim(`    attestation: ${seat.attestationDigest}`));
    }
    println(`  ${c.green("enforced")} conductor routing  ${c.dim("sidecar only · direct provider launch disabled")}`);
    try {
        const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
        const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
        const ready = Boolean(firebaseToken && entitled !== null);
        println(`  ${ready ? c.yellow("fallback") : c.red("blocked")} cloud control reads  ${c.dim(ready ? "Firebase human + exact-instance posture" : "fresh Firebase human authentication required")}`);
    }
    catch (error) {
        println(`  ${c.red("blocked")} cloud read-only  ${c.dim(error.message)}`);
    }
    if (readiness.health.seats.length === 2 && readiness.health.seats[1]?.seatId === "support-seat-roster") {
        println(`  ${c.yellow("degraded")} supporting model seats  ${c.dim("no authoritative planner/builder/adversary roster returned")}`);
    }
}
async function runMight(parsed, scope, state, env) {
    const transport = await resolveControlReadTransport(parsed, scope, state, env);
    const memoryStatus = transport.posture === "sidecar"
        ? await transport.getMemoryStatus().catch(() => null)
        : null;
    const [controlSession, snapshot, capabilities, receiptProbe] = await Promise.all([
        transport.getControlSession(),
        transport.getSnapshot(),
        transport.getCapabilities(),
        transport.getReceipts({ limit: 1 })
            .then((page) => ({ page, error: null }))
            .catch((error) => ({ page: null, error: error.message })),
    ]);
    const lines = renderOneSurfaceStartupBrief(summarizeOneSurfaceReadiness({
        controlSession,
        snapshot,
        capabilities,
        memoryStatus,
        receiptPage: receiptProbe.page,
        receiptProbeError: receiptProbe.error,
    })).map((line, index) => index === 0 ? line.replace("startup", "status") : line);
    const [orchestra, mail] = await Promise.all([
        resolveOrchestraBrokerConfig(env),
        collectSessionHealthCard({ env }).then((card) => card.lines.filter((line) => line.id.startsWith("mail."))),
    ]);
    lines.push("  Hands · local authority extensions");
    lines.push("reason" in orchestra
        ? `    blocked     orchestra · ${orchestra.reason} · no fallback`
        : `    ready       orchestra · wrapper ${orchestra.brokerSha256} · resources ${orchestra.resourceSetDigest} · preflight ${orchestra.preflightAttestationDigest}`);
    for (const item of mail)
        lines.push(`    ${item.state.padEnd(11)} ${item.id} · ${item.summary}`);
    printControlLines(lines);
}
async function runProviders(args, scope, env) {
    if ((args[0] || "status") !== "status") {
        throw Object.assign(new Error("usage: excalibur providers status"), { exitCode: 2 });
    }
    println(c.bold("Provider status"));
    try {
        const sidecar = await resolveSidecarConnection(env);
        const transport = new ExcaliburHttpTransport({
            baseUrl: sidecar.baseUrl,
            posture: "sidecar",
            scope: { kind: "operator" },
            accessToken: sidecar.token,
        });
        await transport.getControlSession();
        println(`  Shared sidecar: ${c.green("ready")} · ${sidecar.baseUrl} · canonical`);
    }
    catch (error) {
        println(`  Shared sidecar: ${c.red("blocked")} · ${error.message}`);
    }
    println(`  Grok ACP routing: ${c.green("sidecar only")} · direct provider launch disabled`);
    try {
        const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
        const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
        if (!firebaseToken || entitled === null)
            println(`  Cloud reads: ${c.dim("fresh Firebase human session required")}`);
        else
            println(`  Cloud reads: ${c.green("exact-instance authentication verified")} · ${entitled.length} entitlement(s)`);
    }
    catch (error) {
        println(`  Cloud: ${c.red("blocked")} · ${error.message}`);
    }
}
async function runMemory(args, parsed, scope, state, env) {
    const subcommand = args[0] || "status";
    if (["configure", "disable"].includes(subcommand) && state.selectedContext !== "operator-local") {
        throw Object.assign(new Error("operator memory configuration is available only in the operator-local context"), { exitCode: 13 });
    }
    if (subcommand === "configure") {
        printControlLines(renderOperatorMemoryStatus(await writeOperatorMemoryConfig(parseOperatorMemoryConfigureArgs(args.slice(1)), env)));
        return;
    }
    if (subcommand === "disable") {
        if (args.length !== 1)
            throw Object.assign(new Error("usage: excalibur memory disable"), { exitCode: 2 });
        printControlLines(renderOperatorMemoryStatus(await disableOperatorMemory(env)));
        return;
    }
    if (subcommand !== "status" || args.length > 1) {
        throw Object.assign(new Error("usage: excalibur memory <configure|status|disable>"), { exitCode: 2 });
    }
    if (state.selectedContext === "operator-local") {
        printControlLines(renderOperatorMemoryStatus(await readOperatorMemoryConfig(env)));
    }
    else {
        println(c.dim("Operator memory configuration is isolated from tenant context; no fallback is permitted."));
    }
    const transport = await resolveControlReadTransport(parsed, scope, state, env);
    if (transport.posture === "sidecar") {
        const memoryStatus = await transport.getMemoryStatus();
        printControlLines(renderSidecarMemoryStatus(memoryStatus));
        printControlLines(renderSnapshot(await transport.getSnapshot(), "memory.status"));
    }
    else {
        println(c.yellow("Sidecar memory · unavailable in authenticated cloud read-only mode"));
        printControlLines(renderSnapshot(await transport.getSnapshot(), "memory.status"));
    }
    println(`  model memory: ${c.green("disabled")} ${c.dim("(shared sidecar attestation excludes native provider memory)")}`);
    println(`  conversation sessions: ${state.sessions.length} scoped metadata record(s)`);
    println(`  state scope: ${scope.principalHash}/${scope.instanceId}`);
    println(c.dim(`  ${scopedStatePath(scope, env)}`));
}
async function runCalendar(args, state, env) {
    if (state.selectedContext !== "operator-local") {
        throw Object.assign(new Error("operator calendar configuration is available only in the operator-local context"), { exitCode: 13 });
    }
    const subcommand = args[0] || "status";
    let result;
    if (subcommand === "configure") {
        result = await writeOperatorCalendarConfig(parseOperatorCalendarConfigureArgs(args.slice(1)), env);
    }
    else if (subcommand === "disable") {
        if (args.length !== 1)
            throw Object.assign(new Error("usage: excalibur calendar disable"), { exitCode: 2 });
        result = await disableOperatorCalendar(env);
    }
    else if (subcommand === "status") {
        if (args.length > 1)
            throw Object.assign(new Error("usage: excalibur calendar status"), { exitCode: 2 });
        result = await readOperatorCalendarConfig(env);
    }
    else {
        throw Object.assign(new Error("usage: excalibur calendar <configure|status|disable>"), { exitCode: 2 });
    }
    printControlLines(renderOperatorCalendarStatus(result));
}
async function runAuth(args) {
    switch (args[0] || "status") {
        case "login":
            await commandAuthLogin({ paste: args.includes("--paste") });
            return;
        case "logout":
            await commandAuthLogout();
            return;
        case "status":
            await commandAuthStatus();
            return;
        default:
            throw Object.assign(new Error("usage: excalibur auth <login|logout|status>"), { exitCode: 2 });
    }
}
async function actualCliEntry(raw = process.argv[1]) {
    const entry = resolve(raw || "bin/excalibur.mjs");
    return await realpath(entry).catch(() => entry);
}
export function legacyBenchExcaliburWarning(resolution) {
    if (!resolution.winner)
        return null;
    return `\`${resolution.winner} excalibur\` is a legacy Aurelius shadow-conductor path; use the standalone \`excalibur\` binary for the shared One-Surface conversation`;
}
async function runDoctor(parsed, scope, state, env) {
    let coreFailed = false;
    const binary = await actualCliEntry();
    const pathResolutions = await inspectCliPathShadows(env);
    const launcherInspections = await inspectExcaliburLaunchers(env, parsed.launchCheck ? binary : undefined);
    const excaliburPath = pathResolutions.find((item) => item.name === "excalibur");
    let canonicalLauncherVerified = false;
    println(`excalibur ${CLI_VERSION} doctor`);
    println(c.green(`✓ CLI identity: excalibur ${CLI_VERSION}`));
    println(c.dim(`  actual binary: ${binary}`));
    const directExcaliburTargets = excaliburPath?.realTargets.filter((item) => item.endsWith("/excalibur.mjs")) || [];
    if (excaliburPath?.winner && directExcaliburTargets.length > 0 && !directExcaliburTargets.includes(binary)) {
        if (parsed.launchCheck)
            println(c.yellow(`⚠ PATH launches ${excaliburPath.winner}; toolbar manifest must prove its pinned entry`));
        else {
            coreFailed = true;
            println(c.red(`✗ PATH launches ${excaliburPath.winner}, not this One-Surface binary`));
        }
    }
    if (parsed.launchCheck) {
        const manifestPath = env.EXCALIBUR_CANONICAL_LAUNCH_MANIFEST;
        if (!manifestPath) {
            coreFailed = true;
            println(c.red("✗ canonical launcher manifest is absent; refusing to claim toolbar readiness"));
        }
        else {
            try {
                const manifest = await verifyCanonicalLauncherManifest(manifestPath, binary);
                canonicalLauncherVerified = true;
                println(c.green(`✓ canonical launcher manifest verified · ${manifest.surface} · sidecar required`));
                println(c.dim(`  ${manifestPath}`));
            }
            catch (error) {
                coreFailed = true;
                println(c.red(`✗ canonical launcher manifest rejected: ${error.message}`));
            }
        }
    }
    try {
        if (state.selectedContext !== "operator-local" && state.selectedContext !== scope.instanceId) {
            throw new Error("selected tenant context is outside the current principal-bound instance");
        }
        const connectionEnv = parsed.sidecarUrl
            ? { ...env, EXCALIBUR_SIDECAR_URL: parsed.sidecarUrl }
            : env;
        const sidecar = await resolveSidecarConnection(connectionEnv);
        const conversationScope = state.selectedContext === "operator-local"
            ? { kind: "operator" }
            : { kind: "tenant", instanceId: state.selectedContext };
        const transport = new ExcaliburHttpTransport({
            baseUrl: sidecar.baseUrl,
            posture: "sidecar",
            scope: conversationScope,
            accessToken: sidecar.token,
            cloudAccessToken: conversationScope.kind === "tenant"
                ? async () => (await loadFreshFirebaseIdToken().catch(() => null)) || undefined
                : undefined,
        });
        const controlSession = await transport.getControlSession();
        // Optional adapters degrade only their own capability. Snapshot,
        // capability manifest, session, and digests remain canonical core gates.
        const memoryProbe = await transport.getMemoryStatus()
            .then((value) => ({ value, error: null }))
            .catch((error) => ({ value: null, error: error.message }));
        const [snapshot, capabilities, receiptProbe] = await Promise.all([
            transport.getSnapshot(),
            transport.getCapabilities(),
            transport.getReceipts({ limit: 1 })
                .then((page) => ({ page, error: null }))
                .catch((error) => ({ page: null, error: error.message })),
        ]);
        const readiness = summarizeOneSurfaceReadiness({
            controlSession,
            snapshot,
            capabilities,
            memoryStatus: memoryProbe.value,
            receiptPage: receiptProbe.page,
            receiptProbeError: receiptProbe.error,
        });
        println(c.green(`✓ shared Excalibur sidecar control and capability manifest verified (${sidecar.baseUrl})`));
        println(c.dim(`  protocol digest: ${controlSession.digests.protocol}`));
        println(c.dim(`  manifest digest: ${controlSession.digests.manifest}`));
        println(c.dim(`  routing digest:  ${controlSession.digests.routing}`));
        println(c.dim(`  capabilities: ${capabilities.length} · snapshot: ${snapshot.observedAt}`));
        const brief = renderOneSurfaceStartupBrief(readiness);
        println(c.bold(brief[0].replace("startup", "diagnostic")));
        for (const line of brief.slice(1))
            println(c.dim(line));
        if (!readiness.coreReady) {
            coreFailed = true;
            println(c.red(`✗ One-Surface core blocked: ${readiness.coreBlockers.join(", ")}`));
        }
        else {
            println(c.green(`✓ canonical posture ${readiness.posture} · exact sidecar/model/contract core ready`));
        }
        for (const check of [
            readiness.health.ledger,
            readiness.health.worktree,
            readiness.health.publisher,
            readiness.health.memory,
            readiness.health.schedules,
        ]) {
            const line = `${check.id}: ${check.state} · ${check.detail}`;
            println(check.state === "ready" ? c.green(`✓ ${line}`) : c.yellow(`⚠ ${line}`));
            if (check.remediation)
                println(c.dim(`  remediation: ${check.remediation}`));
        }
        if (memoryProbe.error)
            println(c.dim(`  memory probe: ${memoryProbe.error}`));
    }
    catch (error) {
        coreFailed = true;
        println(c.red(`✗ shared Excalibur sidecar blocked: ${error.message}`));
    }
    println(c.green("✓ direct Grok ACP launch disabled; all Grok chat is sidecar-owned"));
    const orchestra = await resolveOrchestraBrokerConfig(env);
    if ("reason" in orchestra) {
        println(c.yellow(`⚠ Pattern A orchestra unavailable: ${orchestra.reason}`));
        println(c.dim("  /orchestra init|status|advance|propose invokes no fallback"));
    }
    else {
        println(c.green(`✓ Pattern A orchestra broker verified: ${orchestra.executable}`));
        println(c.dim(`  owner-private config: ${orchestra.configPath}`));
        println(c.dim(`  broker sha256: ${orchestra.brokerSha256}`));
        println(c.dim(`  Pattern A resource set: ${orchestra.resourceSetDigest}`));
        println(c.dim(`  owner-private state root: ${orchestra.stateRoot}`));
        println(c.dim(`  closure preflight attestation: ${orchestra.preflightAttestationDigest}`));
    }
    const mailLines = (await collectSessionHealthCard({ env })).lines
        .filter((line) => line.id.startsWith("mail."));
    for (const line of mailLines) {
        const rendered = `${line.id}: ${line.state} · ${line.summary}`;
        println(line.state === "ready" ? c.green(`✓ ${rendered}`) : c.yellow(`⚠ ${rendered}`));
    }
    const mode = await stateFileMode({ scope, env });
    if (mode === 0o600)
        println(c.green(`✓ scoped state private (0600)`));
    else {
        coreFailed = true;
        println(c.red(`✗ scoped state mode is ${mode == null ? "missing" : mode.toString(8)}; expected 600`));
    }
    println(c.dim(`  ${scopeDirectory(scope, env)}`));
    if (state.selectedContext === "operator-local") {
        try {
            const memory = await readOperatorMemoryConfig(env);
            const memoryLines = renderOperatorMemoryStatus(memory);
            println(memory.config ? c.green(`✓ ${memoryLines[0]}`) : c.dim(`⊘ ${memoryLines[0]}`));
            for (const line of memoryLines.slice(1))
                println(c.dim(line));
        }
        catch (error) {
            println(c.yellow(`⚠ memory capability degraded: ${error.message}`));
        }
        try {
            const calendar = await readOperatorCalendarConfig(env);
            const lines = renderOperatorCalendarStatus(calendar);
            println(calendar.config ? c.green(`✓ ${lines[0]}`) : c.dim(`⊘ ${lines[0]}`));
            for (const line of lines.slice(1))
                println(c.dim(line));
        }
        catch (error) {
            println(c.yellow(`⚠ calendar capability degraded: ${error.message}`));
        }
    }
    else {
        println(c.dim("⊘ operator calendar configuration is isolated from tenant context"));
    }
    try {
        const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
        const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
        if (!firebaseToken || entitled === null)
            println(c.dim("⊘ Firebase human auth absent; tenant sidecar-loss reads unavailable"));
        else
            println(c.green(`✓ authenticated entitlements bound (${entitled.length} agent(s))`));
    }
    catch (error) {
        const label = error instanceof EntitlementResolutionError ? error.message : error.message;
        println(c.yellow(`⚠ tenant cloud-read capability degraded: ${label}`));
    }
    const benchResolution = pathResolutions.find((item) => item.name === "bench");
    const legacyWarning = benchResolution ? legacyBenchExcaliburWarning(benchResolution) : null;
    if (legacyWarning)
        println(c.yellow(`⚠ ${legacyWarning}`));
    for (const launcher of launcherInspections) {
        if (launcher.classification === "canonical") {
            println(c.green(`✓ canonical toolbar bundle: ${launcher.appPath}`));
        }
        else {
            println(c.yellow(`⚠ non-canonical Excalibur toolbar bundle: ${launcher.appPath}`));
            for (const issue of launcher.issues)
                println(c.dim(`  ${issue}`));
            println(c.dim("  do not use this bundle for a One-Surface test drive"));
        }
    }
    for (const resolution of pathResolutions) {
        if (!resolution.winner) {
            println(c.yellow(`⚠ ${resolution.name} is not on PATH`));
            if (resolution.name === "excalibur" && !(parsed.launchCheck && canonicalLauncherVerified))
                coreFailed = true;
            continue;
        }
        if (resolution.shadowed) {
            if (resolution.name === "excalibur") {
                if (parsed.launchCheck && canonicalLauncherVerified) {
                    println(c.yellow(`⚠ terminal PATH has an Excalibur shadow, but this toolbar launch is exact-entry pinned: ${resolution.candidates.join(" → ")}`));
                }
                else {
                    coreFailed = true;
                    println(c.red(`✗ ${resolution.name} PATH shadow: ${resolution.candidates.join(" → ")}`));
                }
            }
            else {
                println(c.yellow(`⚠ compatibility command ${resolution.name} has a PATH shadow: ${resolution.candidates.join(" → ")}`));
            }
        }
        else {
            println(c.green(`✓ ${resolution.name} resolves to ${resolution.winner}`));
        }
    }
    println(coreFailed
        ? c.red("MIGHT result: core blocked · SHADOW only · no canonical launch claim")
        : c.green("MIGHT result: canonical core ready · optional capability degradation shown above"));
    if (coreFailed)
        process.exitCode = 1;
}
function parseArgs(argv) {
    const out = {
        command: null,
        positional: [],
        classic: false,
        full: false,
        noThinking: false,
        launchCheck: false,
        help: false,
        version: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--classic") {
            out.classic = true;
            continue;
        }
        if (arg === "--full") {
            out.full = true;
            continue;
        }
        if (arg === "--no-thinking") {
            out.noThinking = true;
            continue;
        }
        if (arg === "--launch-check") {
            out.launchCheck = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            out.help = true;
            continue;
        }
        if (arg === "--version" || arg === "-v") {
            out.version = true;
            continue;
        }
        if (arg === "--sidecar") {
            out.sidecarUrl = argv[++i];
            if (!out.sidecarUrl)
                throw Object.assign(new Error("--sidecar requires a value"), { exitCode: 2 });
            continue;
        }
        if (arg.startsWith("--sidecar=")) {
            out.sidecarUrl = arg.slice("--sidecar=".length);
            continue;
        }
        if (arg === "--trace-frames") {
            out.traceFramesPath = argv[++i];
            if (!out.traceFramesPath)
                throw Object.assign(new Error("--trace-frames requires a value"), { exitCode: 2 });
            continue;
        }
        if (arg.startsWith("--trace-frames=")) {
            out.traceFramesPath = arg.slice("--trace-frames=".length);
            continue;
        }
        if (out.command === "calendar" && [
            "--account", "--calendar-id", "--timezone", "--lookahead-days", "--consent-operator-summary",
        ].some((name) => arg === name || arg.startsWith(`${name}=`))) {
            out.positional.push(arg);
            continue;
        }
        if (out.command === "memory" && (arg === "--shelf" || arg.startsWith("--shelf="))) {
            out.positional.push(arg);
            continue;
        }
        if (out.command && UCP_COMMANDS.has(out.command)) {
            out.positional.push(arg);
            continue;
        }
        if (arg.startsWith("-") && !(out.command === "auth" && arg === "--paste")) {
            throw Object.assign(new Error(`unknown option: ${arg}`), { exitCode: 2 });
        }
        if (!out.command && out.positional.length === 0 && COMMANDS.has(arg))
            out.command = arg;
        else
            out.positional.push(arg);
    }
    return out;
}
function printHelp() {
    println(`excalibur ${CLI_VERSION} — shared Excalibur contact surface (internal preview; seal pending merged mainline)

Usage:
  excalibur                         shared Desktop/CLI conversation surface
  excalibur ask <message>           single-turn ask
  excalibur resume <session-id>     reattach an explicit shared conversation
  excalibur sessions                list scoped sessions
  excalibur context list            list principal/instance-safe contexts
  excalibur context use <id>        select operator-local or the bound instance
  excalibur health [--json]         full UCP health card + value-free receipt
  excalibur effects [--json]        typed effect registry and authorization modes
  excalibur effect <id> ...         run one typed effect from a JSON request file
  excalibur grant issue ...         Touch ID-gated protected capability grant (≤15m)
  excalibur grants [--json]         list open grants
  excalibur might                   MIGHT posture and capability-specific health
  excalibur views                   read authoritative aggregate observations
  excalibur actions                 typed actions, exact gates, and deterministic executors
  excalibur receipts                read deterministic execution receipts
  excalibur seats                   show inference seats and rotation readiness
  excalibur providers status        provider and entitlement status
  excalibur memory status           content-free sidecar memory readiness
  excalibur memory configure --shelf <absolute SESSION_LANDMARKS.md>
  excalibur memory disable          disable the operator-local memory adapter
  excalibur calendar status         private operator calendar adapter status
  excalibur calendar configure ...  consent to operator-thread schedule summaries
  excalibur calendar disable        disable the operator calendar adapter
  excalibur auth <login|logout|status>
  excalibur doctor                  MIGHT posture, component health, contracts, and launchers
  excalibur version

Flags:
  --classic                        readline surface instead of full-screen TUI
  --full                           expand tool/event output
  --no-thinking                    hide reasoning deltas
  --sidecar <loopback-url>         override the shared numeric-loopback origin
  --trace-frames <path>            private, redacted, expiring diagnostic JSONL
  --help, --version

Safety:
  The desktop-owned loopback sidecar owns Grok and the canonical conversation.
  Tenant sidecar loss permits authenticated reads only; chat, proposals,
  approvals, and effects lock. Direct Grok ACP launch is disabled.
  Calendar and memory configuration are 0600 operator-only state. The CLI never
  calls gog; account, calendar, and shelf identifiers are never printed by status.
  Posture is explicit: SHADOW reads, PREPARE conducts, WIELD executes a typed
  approval-bound action, and LAND exists only when a separately manifested
  landing capability is available. No posture is inferred from conversational prose.

Toolbar:
  Only Excalibur One Surface.app with an exact embedded launcher manifest is
  canonical. Every click runs doctor --launch-check before chat. Excalibur CLI
  Preview.app is a legacy shadow conductor and is never treated as ready.

Compatibility:
  excalibur is the canonical command. In beta.15, benchagi and bench remain
  parallel, unredirected 1.x compatibility commands; existing families stay intact.
`);
}
export const __testing = { parseArgs };
