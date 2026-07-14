import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { commandAuthLogin, commandAuthLogout, commandAuthStatus } from "../commands/auth.js";
import { CLI_VERSION, commandVersion } from "../commands/version.js";
import { inspectCliPathShadows, type PathResolution } from "../diagnostics/path-shadow.js";
import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { loadAccount } from "../launcher/account.js";
import { EntitlementResolutionError, resolveEntitledAgents } from "../launcher/entitlements.js";
import { c, println } from "../render/ansi.js";
import { resolveStateScope, scopeDirectory, type StateScope } from "../state/scope.js";
import {
  activateTenantCloudReadOnly,
  runExcaliburConversation,
  runLegacyGrokAcpDiagnostic,
} from "./conversation.js";
import { renderCapabilities, renderReceiptPage, renderSnapshot } from "./control-render.js";
import { inspectGrokProvider } from "./grok-managed.js";
import { ExcaliburHttpTransport, resolveSidecarConnection } from "./http-transport.js";
import {
  disableOperatorCalendar,
  parseOperatorCalendarConfigureArgs,
  readOperatorCalendarConfig,
  renderOperatorCalendarStatus,
  writeOperatorCalendarConfig,
} from "./operator-calendar.js";
import {
  disableOperatorMemory,
  parseOperatorMemoryConfigureArgs,
  readOperatorMemoryConfig,
  renderOperatorMemoryStatus,
  writeOperatorMemoryConfig,
} from "./operator-memory.js";
import {
  renderOneSurfaceStartupBrief,
  renderSidecarMemoryStatus,
  summarizeOneSurfaceReadiness,
} from "./readiness.js";
import {
  loadExcaliburState,
  scopedStatePath,
  setSelectedContext,
  stateFileMode,
  type ExcaliburState,
} from "./scoped-state.js";

type ParsedArgs = {
  command: string | null;
  positional: string[];
  classic: boolean;
  full: boolean;
  noThinking: boolean;
  sidecarUrl?: string;
  traceFramesPath?: string;
  help: boolean;
  version: boolean;
};

const COMMANDS = new Set([
  "ask",
  "resume",
  "sessions",
  "context",
  "views",
  "actions",
  "receipts",
  "seats",
  "providers",
  "memory",
  "calendar",
  "legacy-grok-acp",
  "auth",
  "doctor",
  "version",
  "help",
]);

export async function runExcalibur(argv: string[]): Promise<void> {
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
  const scope = await resolveStateScope({ env });
  const state = await loadExcaliburState({ scope, env });

  switch (parsed.command) {
    case "context":
      await runContext(parsed.positional, scope, state, env);
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
      await printSeats(scope, env);
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
    case "legacy-grok-acp":
      if (state.selectedContext !== "operator-local") {
        throw Object.assign(new Error("legacy Grok ACP diagnostic is forbidden while a tenant context is selected"), { exitCode: 13 });
      }
      await runLegacyGrokAcpDiagnostic({
        env,
        scope,
        contextId: "operator-local",
        message: parsed.positional.join(" ").trim() || undefined,
        classic: parsed.classic,
        full: parsed.full,
        noThinking: parsed.noThinking,
        traceFramesPath: parsed.traceFramesPath,
      });
      return;
    case "doctor":
      await runDoctor(parsed, scope, state, env);
      return;
    case "resume": {
      const id = parsed.positional[0];
      if (!id) throw Object.assign(new Error("usage: excalibur resume <session-id> [message]"), { exitCode: 2 });
      const session = state.sessions.find((item) => item.sessionId === id);
      if (!session) throw Object.assign(new Error(`unknown scoped session: ${id}`), { exitCode: 5 });
      const allowed = await availableContexts(scope, env);
      if (!allowed.includes(session.contextId)) {
        throw Object.assign(new Error("session context is not available to the current principal and instance"), { exitCode: 13 });
      }
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
      if (!message) throw Object.assign(new Error("usage: excalibur ask <message>"), { exitCode: 2 });
      await launchConversation(parsed, scope, state, env, message);
      return;
    }
    default: {
      let message = parsed.positional.join(" ").trim();
      if (!message && !process.stdin.isTTY) message = await readPipedPrompt();
      await launchConversation(parsed, scope, state, env, message || undefined);
    }
  }
}

async function launchConversation(
  parsed: ParsedArgs,
  scope: StateScope,
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
  message?: string,
): Promise<void> {
  const allowed = await availableContexts(scope, env);
  if (!allowed.includes(state.selectedContext)) {
    throw Object.assign(
      new Error(`selected context ${state.selectedContext} is outside the current principal/instance boundary; run \`excalibur context use operator-local\``),
      { exitCode: 13 },
    );
  }
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

async function readPipedPrompt(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value.trim();
}

async function availableContexts(scope: StateScope, env: NodeJS.ProcessEnv): Promise<string[]> {
  const account = await loadAccount(env);
  const contexts = new Set<string>(["operator-local"]);
  const instance = env.EXCALIBUR_INSTANCE_ID?.trim() || env.BENCHAGI_INSTANCE_ID?.trim() || account?.instanceId?.trim();
  if (instance && instance !== "unbound" && instance !== "operator-local" && instance === scope.instanceId) {
    contexts.add(instance);
  }
  return [...contexts];
}

async function runContext(
  args: string[],
  scope: StateScope,
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
): Promise<void> {
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
    if (!context) throw Object.assign(new Error("usage: excalibur context use <context-id>"), { exitCode: 2 });
    if (!contexts.includes(context)) {
      throw Object.assign(new Error(`context ${context} is not bound to the current principal and instance`), { exitCode: 13 });
    }
    await setSelectedContext(context, { scope, env });
    println(`active context: ${c.cyan(context)}`);
    return;
  }
  throw Object.assign(new Error("usage: excalibur context <list|use>"), { exitCode: 2 });
}

function printSessions(state: ExcaliburState): void {
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

function printControlLines(lines: string[]): void {
  for (const [index, line] of lines.entries()) println(index === 0 ? c.bold(line) : line);
}

async function resolveControlReadTransport(
  parsed: ParsedArgs,
  scope: StateScope,
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
): Promise<ExcaliburHttpTransport> {
  const contexts = await availableContexts(scope, env);
  if (!contexts.includes(state.selectedContext)) {
    throw Object.assign(
      new Error(`selected context ${state.selectedContext} is outside the current principal/instance boundary`),
      { exitCode: 13 },
    );
  }
  const conversationScope = state.selectedContext === "operator-local"
    ? { kind: "operator" as const }
    : { kind: "tenant" as const, instanceId: state.selectedContext };
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
  } catch (error) {
    if (conversationScope.kind !== "tenant") {
      throw Object.assign(
        new Error("shared Excalibur loopback sidecar is unavailable; operator reads have no cloud fallback"),
        { exitCode: 6, cause: error },
      );
    }
    const reason = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code).toLowerCase().replaceAll("_", "-")
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

async function printSeats(scope: StateScope, env: NodeJS.ProcessEnv): Promise<void> {
  const grok = await inspectGrokProvider({ env, scope });
  println(c.bold("Inference seats"));
  println(`  ${c.green("canonical")} shared Excalibur sidecar  ${c.dim("desktop-owned conversation and ordered event ledger")}`);
  println(`  ${grok.ready ? c.yellow("diagnostic") : c.dim("unavailable")} direct Grok ACP  ${c.dim(grok.version || grok.issue || "not found")}`);
  try {
    const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
    const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
    const ready = Boolean(firebaseToken && entitled !== null);
    println(`  ${ready ? c.yellow("fallback") : c.red("blocked")} cloud control reads  ${c.dim(ready ? "Firebase human + exact-instance posture" : "fresh Firebase human authentication required")}`);
  } catch (error) {
    println(`  ${c.red("blocked")} cloud read-only  ${c.dim((error as Error).message)}`);
  }
  println(`  ${c.yellow("preview")} Claude / Codex rotation  ${c.dim("declared but not routed by this preview")}`);
}

async function runProviders(args: string[], scope: StateScope, env: NodeJS.ProcessEnv): Promise<void> {
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
  } catch (error) {
    println(`  Shared sidecar: ${c.red("blocked")} · ${(error as Error).message}`);
  }
  const grok = await inspectGrokProvider({ env, scope });
  println(`  Direct Grok ACP diagnostic: ${grok.ready ? c.yellow("ready") : c.dim("unavailable")} · ${grok.model}${grok.version ? ` · ${grok.version}` : ""}`);
  try {
    const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
    const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
    if (!firebaseToken || entitled === null) println(`  Cloud reads: ${c.dim("fresh Firebase human session required")}`);
    else println(`  Cloud reads: ${c.green("exact-instance authentication verified")} · ${entitled.length} entitlement(s)`);
  } catch (error) {
    println(`  Cloud: ${c.red("blocked")} · ${(error as Error).message}`);
  }
}

async function runMemory(
  args: string[],
  parsed: ParsedArgs,
  scope: StateScope,
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const subcommand = args[0] || "status";
  if (["configure", "disable"].includes(subcommand) && state.selectedContext !== "operator-local") {
    throw Object.assign(new Error("operator memory configuration is available only in the operator-local context"), { exitCode: 13 });
  }
  if (subcommand === "configure") {
    printControlLines(renderOperatorMemoryStatus(await writeOperatorMemoryConfig(
      parseOperatorMemoryConfigureArgs(args.slice(1)),
      env,
    )));
    return;
  }
  if (subcommand === "disable") {
    if (args.length !== 1) throw Object.assign(new Error("usage: excalibur memory disable"), { exitCode: 2 });
    printControlLines(renderOperatorMemoryStatus(await disableOperatorMemory(env)));
    return;
  }
  if (subcommand !== "status" || args.length > 1) {
    throw Object.assign(new Error("usage: excalibur memory <configure|status|disable>"), { exitCode: 2 });
  }
  if (state.selectedContext === "operator-local") {
    printControlLines(renderOperatorMemoryStatus(await readOperatorMemoryConfig(env)));
  } else {
    println(c.dim("Operator memory configuration is isolated from tenant context; no fallback is permitted."));
  }
  const transport = await resolveControlReadTransport(parsed, scope, state, env);
  if (transport.posture === "sidecar") {
    const memoryStatus = await transport.getMemoryStatus();
    printControlLines(renderSidecarMemoryStatus(memoryStatus));
    printControlLines(renderSnapshot(await transport.getSnapshot(), "memory.status"));
  } else {
    println(c.yellow("Sidecar memory · unavailable in authenticated cloud read-only mode"));
    printControlLines(renderSnapshot(await transport.getSnapshot(), "memory.status"));
  }
  println(`  model memory: ${c.green("disabled")} ${c.dim("(shared sidecar attestation excludes native provider memory)")}`);
  println(`  conversation sessions: ${state.sessions.length} scoped metadata record(s)`);
  println(`  state scope: ${scope.principalHash}/${scope.instanceId}`);
  println(c.dim(`  ${scopedStatePath(scope, env)}`));
}

async function runCalendar(
  args: string[],
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (state.selectedContext !== "operator-local") {
    throw Object.assign(
      new Error("operator calendar configuration is available only in the operator-local context"),
      { exitCode: 13 },
    );
  }
  const subcommand = args[0] || "status";
  let result;
  if (subcommand === "configure") {
    result = await writeOperatorCalendarConfig(parseOperatorCalendarConfigureArgs(args.slice(1)), env);
  } else if (subcommand === "disable") {
    if (args.length !== 1) throw Object.assign(new Error("usage: excalibur calendar disable"), { exitCode: 2 });
    result = await disableOperatorCalendar(env);
  } else if (subcommand === "status") {
    if (args.length > 1) throw Object.assign(new Error("usage: excalibur calendar status"), { exitCode: 2 });
    result = await readOperatorCalendarConfig(env);
  } else {
    throw Object.assign(new Error("usage: excalibur calendar <configure|status|disable>"), { exitCode: 2 });
  }
  printControlLines(renderOperatorCalendarStatus(result));
}

async function runAuth(args: string[]): Promise<void> {
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

async function actualCliEntry(raw = process.argv[1]): Promise<string> {
  const entry = resolve(raw || "bin/excalibur.mjs");
  return await realpath(entry).catch(() => entry);
}

export function legacyBenchExcaliburWarning(resolution: PathResolution): string | null {
  if (!resolution.winner) return null;
  return `${resolution.winner} excalibur is the legacy Aurelius shadow conductor; it cannot attach to the Excalibur One-Surface sidecar or shared conversation`;
}

async function runDoctor(
  parsed: ParsedArgs,
  scope: StateScope,
  state: ExcaliburState,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let failed = false;
  const binary = await actualCliEntry();
  const pathResolutions = await inspectCliPathShadows(env);
  const excaliburPath = pathResolutions.find((item) => item.name === "excalibur");
  println(`excalibur ${CLI_VERSION} doctor`);
  println(c.green(`✓ CLI identity: excalibur ${CLI_VERSION}`));
  println(c.dim(`  actual binary: ${binary}`));
  const directExcaliburTargets = excaliburPath?.realTargets.filter((item) => item.endsWith("/excalibur.mjs")) || [];
  if (excaliburPath?.winner && directExcaliburTargets.length > 0 && !directExcaliburTargets.includes(binary)) {
    failed = true;
    println(c.red(`✗ PATH launches ${excaliburPath.winner}, not this One-Surface binary`));
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
      ? { kind: "operator" as const }
      : { kind: "tenant" as const, instanceId: state.selectedContext };
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
    // This call initializes and verifies the content-free memory adapter status.
    // Read the snapshot afterwards so doctor never reports the pre-load projection.
    const memoryStatus = await transport.getMemoryStatus();
    const [snapshot, capabilities] = await Promise.all([
      transport.getSnapshot(),
      transport.getCapabilities(),
    ]);
    const readiness = summarizeOneSurfaceReadiness({ controlSession, snapshot, capabilities, memoryStatus });
    println(c.green(`✓ shared Excalibur sidecar control and capability manifest verified (${sidecar.baseUrl})`));
    println(c.dim(`  protocol digest: ${controlSession.digests.protocol}`));
    println(c.dim(`  manifest digest: ${controlSession.digests.manifest}`));
    println(c.dim(`  routing digest:  ${controlSession.digests.routing}`));
    println(c.dim(`  capabilities: ${capabilities.length} · snapshot: ${snapshot.observedAt}`));
    const brief = renderOneSurfaceStartupBrief(readiness);
    println(c.bold(brief[0]!.replace("startup", "diagnostic")));
    for (const line of brief.slice(1)) println(c.dim(line));
    if (readiness.servedModel !== "grok-4.5" || readiness.conversationState !== "active") {
      failed = true;
      println(c.red("✗ shared conversation lacks exact active Grok 4.5 served-model attestation"));
    } else {
      println(c.green("✓ shared conversation and Grok 4.5 served-model attestation ready"));
    }
    if (readiness.schedules.freshness === "unavailable") {
      failed = true;
      println(c.red("✗ schedules projection unavailable"));
    } else {
      println(c.green(`✓ schedules projection ${readiness.schedules.freshness}`));
    }
    if (readiness.memory.state !== "available") {
      failed = true;
      println(c.red(`✗ sidecar memory adapter ${readiness.memory.state}`));
    } else {
      println(c.green(`✓ sidecar memory adapter available (${readiness.memory.adapter}/${readiness.memory.mode})`));
    }
  } catch (error) {
    failed = true;
    println(c.red(`✗ shared Excalibur sidecar blocked: ${(error as Error).message}`));
  }
  const grok = await inspectGrokProvider({ env, scope });
  if (grok.ready) println(c.dim(`⊘ legacy direct Grok ACP diagnostic available (${grok.version}, ${grok.model})`));
  else println(c.dim(`⊘ legacy direct Grok ACP diagnostic unavailable: ${grok.issue || "unknown"}`));

  const mode = await stateFileMode({ scope, env });
  if (mode === 0o600) println(c.green(`✓ scoped state private (0600)`));
  else {
    failed = true;
    println(c.red(`✗ scoped state mode is ${mode == null ? "missing" : mode.toString(8)}; expected 600`));
  }
  println(c.dim(`  ${scopeDirectory(scope, env)}`));

  if (state.selectedContext === "operator-local") {
    try {
      const memory = await readOperatorMemoryConfig(env);
      const memoryLines = renderOperatorMemoryStatus(memory);
      println(memory.config ? c.green(`✓ ${memoryLines[0]}`) : c.dim(`⊘ ${memoryLines[0]}`));
      for (const line of memoryLines.slice(1)) println(c.dim(line));
    } catch (error) {
      failed = true;
      println(c.red(`✗ operator memory configuration unsafe: ${(error as Error).message}`));
    }
    try {
      const calendar = await readOperatorCalendarConfig(env);
      const lines = renderOperatorCalendarStatus(calendar);
      println(calendar.config ? c.green(`✓ ${lines[0]}`) : c.dim(`⊘ ${lines[0]}`));
      for (const line of lines.slice(1)) println(c.dim(line));
    } catch (error) {
      failed = true;
      println(c.red(`✗ operator calendar configuration unsafe: ${(error as Error).message}`));
    }
  } else {
    println(c.dim("⊘ operator calendar configuration is isolated from tenant context"));
  }

  try {
    const firebaseToken = await loadFreshFirebaseIdToken().catch(() => null);
    const entitled = await resolveEntitledAgents({ env, scope, firebaseToken });
    if (!firebaseToken || entitled === null) println(c.dim("⊘ Firebase human auth absent; tenant sidecar-loss reads unavailable"));
    else println(c.green(`✓ authenticated entitlements bound (${entitled.length} agent(s))`));
  } catch (error) {
    failed = true;
    const label = error instanceof EntitlementResolutionError ? error.message : (error as Error).message;
    println(c.red(`✗ cloud entitlements blocked: ${label}`));
  }

  const benchResolution = pathResolutions.find((item) => item.name === "bench");
  const legacyWarning = benchResolution ? legacyBenchExcaliburWarning(benchResolution) : null;
  if (legacyWarning) println(c.yellow(`⚠ ${legacyWarning}`));

  for (const resolution of pathResolutions) {
    if (!resolution.winner) {
      println(c.yellow(`⚠ ${resolution.name} is not on PATH`));
      if (resolution.name === "excalibur") failed = true;
      continue;
    }
    if (resolution.shadowed) {
      failed = true;
      println(c.red(`✗ ${resolution.name} PATH shadow: ${resolution.candidates.join(" → ")}`));
    } else {
      println(c.green(`✓ ${resolution.name} resolves to ${resolution.winner}`));
    }
  }
  if (failed) process.exitCode = 1;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    positional: [],
    classic: false,
    full: false,
    noThinking: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--classic") { out.classic = true; continue; }
    if (arg === "--full") { out.full = true; continue; }
    if (arg === "--no-thinking") { out.noThinking = true; continue; }
    if (arg === "--help" || arg === "-h") { out.help = true; continue; }
    if (arg === "--version" || arg === "-v") { out.version = true; continue; }
    if (arg === "--sidecar") {
      out.sidecarUrl = argv[++i];
      if (!out.sidecarUrl) throw Object.assign(new Error("--sidecar requires a value"), { exitCode: 2 });
      continue;
    }
    if (arg.startsWith("--sidecar=")) { out.sidecarUrl = arg.slice("--sidecar=".length); continue; }
    if (arg === "--trace-frames") {
      out.traceFramesPath = argv[++i];
      if (!out.traceFramesPath) throw Object.assign(new Error("--trace-frames requires a value"), { exitCode: 2 });
      continue;
    }
    if (arg.startsWith("--trace-frames=")) { out.traceFramesPath = arg.slice("--trace-frames=".length); continue; }
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
    if (arg.startsWith("-") && !(out.command === "auth" && arg === "--paste")) {
      throw Object.assign(new Error(`unknown option: ${arg}`), { exitCode: 2 });
    }
    if (!out.command && out.positional.length === 0 && COMMANDS.has(arg)) out.command = arg;
    else out.positional.push(arg);
  }
  return out;
}

function printHelp(): void {
  println(`excalibur ${CLI_VERSION} — shared Excalibur contact surface (internal preview; seal pending merged mainline)

Usage:
  excalibur                         shared Desktop/CLI conversation surface
  excalibur ask <message>           single-turn ask
  excalibur resume <session-id>     reattach an explicit shared conversation
  excalibur sessions                list scoped sessions
  excalibur context list            list principal/instance-safe contexts
  excalibur context use <id>        select operator-local or the bound instance
  excalibur views                   read authoritative aggregate observations
  excalibur actions                 read capabilities and every blocking gate
  excalibur receipts                read deterministic execution receipts
  excalibur seats                   show inference seats and rotation readiness
  excalibur providers status        provider and entitlement status
  excalibur memory status           content-free sidecar memory readiness
  excalibur memory configure --shelf <absolute SESSION_LANDMARKS.md>
  excalibur memory disable          disable the operator-local memory adapter
  excalibur calendar status         private operator calendar adapter status
  excalibur calendar configure ...  consent to operator-thread schedule summaries
  excalibur calendar disable        disable the operator calendar adapter
  excalibur legacy-grok-acp [text]  operator-only direct ACP diagnostic
  excalibur auth <login|logout|status>
  excalibur doctor                  provider, state, entitlement, and PATH checks
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
  approvals, and effects lock. Direct Grok ACP is an explicit operator diagnostic.
  Calendar and memory configuration are 0600 operator-only state. The CLI never
  calls gog; account, calendar, and shelf identifiers are never printed by status.

Compatibility:
  excalibur is the canonical command. In beta.15, benchagi and bench remain
  parallel, unredirected 1.x compatibility commands; existing families stay intact.
`);
}

export const __testing = { parseArgs };
