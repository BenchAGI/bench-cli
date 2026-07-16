import { loadFreshFirebaseIdToken } from "../auth/firebase-token.js";
import { replLoop, runTuiSeat, singleTurn, type AgentLite } from "../launcher/cloud-seat.js";
import { loadAccount, resolveApiBase } from "../launcher/account.js";
import { resolveEntitledAgents } from "../launcher/entitlements.js";
import { c, println } from "../render/ansi.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import type { StateScope } from "../state/scope.js";
import {
  ExcaliburEffectsLockedError,
  ExcaliburHttpTransport,
  ExcaliburTransportError,
} from "./http-transport.js";
import {
  loadExcaliburState,
  recordReceipt,
  type ExcaliburSessionRecord,
} from "./scoped-state.js";
import { ExcaliburSidecarRuntime } from "./sidecar-runtime.js";

export type ExcaliburConversationOptions = {
  env?: NodeJS.ProcessEnv;
  scope: StateScope;
  contextId: string;
  message?: string;
  classic?: boolean;
  traceFramesPath?: string;
  sidecarUrl?: string;
  full?: boolean;
  noThinking?: boolean;
  resume?: ExcaliburSessionRecord;
  /** Synthetic-test seams; production resolves both transports from private credentials. */
  sidecarTransport?: ExcaliburHttpTransport;
  cloudReadTransport?: ExcaliburHttpTransport;
  firebaseToken?: string | null;
  entitlementResolver?: typeof resolveEntitledAgents;
};

function shouldUseTui(opts: ExcaliburConversationOptions): boolean {
  if (opts.message) return false;
  if (opts.classic || opts.env?.BENCHAGI_CLASSIC_REPL || process.env.BENCHAGI_CLASSIC_REPL) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function runConnected(
  runtime: ConversationRuntime,
  agent: AgentLite,
  opts: ExcaliburConversationOptions,
  locationLabel: string,
): Promise<void> {
  if (opts.message) {
    await singleTurn(runtime, opts.message, "excalibur");
  } else if (shouldUseTui(opts)) {
    await runTuiSeat(runtime, agent, "excalibur");
  } else if (process.stdin.isTTY) {
    await replLoop(runtime, "grok", agent.model, "excalibur", locationLabel);
  } else {
    throw Object.assign(new Error("no prompt supplied; use `excalibur ask <message>` outside a TTY"), { exitCode: 2 });
  }
}

function cloudControlBase(env: NodeJS.ProcessEnv, accountBase: string): string {
  const configured = env.EXCALIBUR_CLOUD_CONTROL_URL?.trim();
  if (configured) return configured;
  return new URL(accountBase).origin;
}

/**
 * Establishes the only permitted sidecar-loss fallback: exact tenant-bound,
 * authenticated control-plane reads. The returned transport rejects chat,
 * proposals, approvals, aborts, and every other mutation before fetch.
 */
export async function activateTenantCloudReadOnly(
  opts: ExcaliburConversationOptions,
  reason = "shared loopback sidecar unavailable",
): Promise<ExcaliburHttpTransport> {
  if (opts.contextId === "operator-local" || opts.scope.instanceId === "unbound"
      || opts.contextId !== opts.scope.instanceId) {
    throw Object.assign(
      new Error("cloud read fallback requires one exact principal-bound tenant context"),
      { exitCode: 13 },
    );
  }
  const env = opts.env ?? process.env;
  const firebaseToken = opts.firebaseToken === undefined
    ? await loadFreshFirebaseIdToken().catch(() => null)
    : opts.firebaseToken;
  if (!firebaseToken) {
    throw Object.assign(
      new Error("tenant cloud reads require a fresh authenticated human session"),
      { exitCode: 13 },
    );
  }
  const entitled = await (opts.entitlementResolver ?? resolveEntitledAgents)({
    env,
    scope: opts.scope,
    firebaseToken,
  });
  if (entitled === null) {
    throw Object.assign(new Error("tenant cloud reads require authenticated instance entitlements"), { exitCode: 13 });
  }

  let transport = opts.cloudReadTransport;
  if (!transport) {
    const account = await loadAccount(env);
    transport = new ExcaliburHttpTransport({
      baseUrl: cloudControlBase(env, resolveApiBase(account, env)),
      posture: "cloud_read_only",
      scope: { kind: "tenant", instanceId: opts.contextId },
      accessToken: firebaseToken,
    });
  }
  if (transport.posture !== "cloud_read_only" || transport.scope.kind !== "tenant"
      || transport.scope.instanceId !== opts.contextId) {
    throw Object.assign(new Error("cloud read transport is not bound to the selected tenant"), { exitCode: 13 });
  }
  const controlSession = await transport.getControlSession();
  if (controlSession.authMethod !== "firebase_human") {
    throw Object.assign(new Error("cloud read fallback did not return a Firebase human control session"), { exitCode: 13 });
  }
  await recordReceipt({
    kind: "fallback",
    status: "degraded",
    provider: "cloud-read-only",
    detail: `${reason}; reads available, chat/proposals/approvals/effects locked`,
  }, { scope: opts.scope, env });
  return transport;
}

export async function runExcaliburConversation(opts: ExcaliburConversationOptions): Promise<void> {
  if (opts.resume?.provider === "cloud-read-only") {
    throw Object.assign(
      new Error("cloud read-only state has no resumable conversation; restore the shared sidecar"),
      { exitCode: 13 },
    );
  }
  if (opts.resume?.provider === "grok-acp") {
    throw Object.assign(
      new Error("direct Grok ACP sessions are disabled; restore the shared Excalibur sidecar"),
      { exitCode: 13 },
    );
  }

  const runtime = new ExcaliburSidecarRuntime({
    env: opts.env,
    scope: opts.scope,
    contextId: opts.contextId,
    resumeSessionId: opts.resume?.sessionId,
    transport: opts.sidecarTransport,
    sidecarUrl: opts.sidecarUrl,
    cloudAccessToken: opts.firebaseToken,
    traceFramesPath: opts.traceFramesPath,
    showFullToolOutput: opts.full,
    showThinking: !opts.noThinking,
    tui: shouldUseTui(opts),
  });
  try {
    await runtime.connect();
  } catch (error) {
    await runtime.close().catch(() => {});
    const customerContext = opts.contextId !== "operator-local";
    const safeReason = error instanceof ExcaliburTransportError
      ? error.code.toLowerCase().replaceAll("_", "-")
      : "sidecar-unavailable";
    await recordReceipt({
      kind: "preflight",
      status: "blocked",
      provider: "excalibur-sidecar",
      detail: safeReason,
    }, { scope: opts.scope, env: opts.env }).catch(() => {});
    if (customerContext) {
      await activateTenantCloudReadOnly(opts, safeReason);
      println(c.yellow("tenant cloud read-only mode active; chat, proposals, approvals, and effects are locked"));
      throw new ExcaliburEffectsLockedError("chat");
    }
    throw Object.assign(
      new Error("shared Excalibur loopback sidecar is unavailable; start Excalibur Desktop and retry"),
      { exitCode: 6, cause: error },
    );
  }
  try {
    await runConnected(runtime, { id: "grok", model: runtime.currentModel() }, opts, "shared sidecar");
  } finally {
    // Detach only. The sidecar-owned conversation remains active so Desktop and
    // the next CLI invocation retain the exact same scoped conversation id.
    await runtime.close();
  }
}

export async function currentConversationState(
  scope: StateScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ contextId: string }> {
  const state = await loadExcaliburState({ scope, env });
  return { contextId: state.selectedContext };
}
