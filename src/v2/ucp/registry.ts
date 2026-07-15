import { effectDefinition, EFFECT_DEFINITIONS } from "./definitions.js";
import { runAdapter, type AdapterContext } from "./adapters.js";
import { loadUcpConfig } from "./config.js";
import { GateKeeper } from "./gatekeeper.js";
import { GrantStore } from "./grants.js";
import { currentPrincipal, newReceiptId, ReceiptStore, requestDigest } from "./receipts.js";
import {
  UCP_SCHEMA_VERSION,
  UcpDeniedError,
  type CapabilityMode,
  type EffectReceipt,
  type EffectRequest,
  type EffectResult,
  type GrantRecord,
} from "./types.js";

export type EffectExecution = {
  result: EffectResult;
  receipt: EffectReceipt;
  receiptPath: string;
};

type RegistryDependencies = {
  env?: NodeJS.ProcessEnv;
  receiptStore?: ReceiptStore;
  grantStore?: GrantStore;
  gatekeeper?: GateKeeper;
  adapter?: (context: AdapterContext) => Promise<EffectResult>;
  now?: () => Date;
};

function dryRunFor(request: EffectRequest, supportsDryRun: boolean, defaultDryRun: boolean): boolean {
  if (request.execute === true && request.dryRun === true) {
    throw new UcpDeniedError("UCP_EXECUTION_MODE_INVALID", "Choose either --execute or --dry-run, not both");
  }
  const dryRun = request.execute === true ? false : request.dryRun === true ? true : defaultDryRun;
  if (dryRun && !supportsDryRun) {
    throw new UcpDeniedError("UCP_DRY_RUN_UNSUPPORTED", "This read-only effect does not have a dry-run mode");
  }
  return dryRun;
}

function authorizationModes(effectClass: string, required: CapabilityMode[], dryRun: boolean): CapabilityMode[] {
  if (!dryRun) return required;
  return effectClass === "session" || effectClass.endsWith("-read") ? ["observe"] : ["prepare"];
}

function safeGrantIds(value: string[] | undefined): string[] {
  const ids = [...new Set(value || [])];
  if (ids.some((item) => !/^[0-9a-f-]{36}$/.test(item))) {
    throw new UcpDeniedError("UCP_GRANT_INVALID", "Effect request contains an invalid grant ID");
  }
  return ids;
}

const INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "worktree.prepare": ["repoPath", "worktreePath", "branch", "baseRef"],
  "packet.freeze": ["packet", "outputPath"],
  "seat.dispatch": ["packetPath", "seat"],
  "github.watch_checks": ["repository", "pullRequest", "expectedHeadSha"],
  "stamp.roster": ["outputPath", "packetDigest"],
  "bench.health": ["instanceId"],
  "bench.deals.search": ["instanceId", "query", "limit"],
  "bench.deals.get": ["instanceId", "dealId"],
  "bench.deals.list": ["instanceId", "limit", "status"],
  "bench.cs.instance_summary": ["instanceId"],
  "bench.cs.grant": ["instanceId", "principal", "customerSuccessEnabled"],
  "mesh.control_health": [],
  "mesh.node_status": [],
  "mesh.preauth.mint": ["instanceId", "headscaleUserId", "reusable", "ttlSeconds", "aclTags"],
  "mesh.verify_customer_join": ["instanceId", "nodeName", "expectedTag"],
  "mail.doctor": [],
  "mail.draft": ["to", "subject", "body"],
  "mail.send": ["to", "subject", "body"],
  "session.health_card": [],
  "receipt.write": ["purpose"],
});

const SENSITIVE_INPUT_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)/i;
const CREDENTIAL_SHAPE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{20,}|op:\/\/[^\s]+)/;

function assertValueFree(value: unknown, depth = 0): void {
  if (depth > 12) throw new UcpDeniedError("UCP_INPUT_INVALID", "Effect input nesting is too deep");
  if (typeof value === "string") {
    if (CREDENTIAL_SHAPE.test(value)) throw new UcpDeniedError("UCP_SECRET_IN_INPUT_DENIED", "Effect input contains credential-shaped material");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertValueFree(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_INPUT_KEY.test(key)) throw new UcpDeniedError("UCP_SECRET_IN_INPUT_DENIED", "Effect input contains a credential-bearing field");
    assertValueFree(child, depth + 1);
  }
}

function assertTypedInput(effectId: string, input: Record<string, unknown>): void {
  const allowed = INPUT_FIELDS[effectId];
  if (!allowed) throw new UcpDeniedError("UCP_EFFECT_SCHEMA_MISSING", "Effect has no registered request schema");
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length) throw new UcpDeniedError("UCP_INPUT_FIELD_DENIED", "Effect input contains unsupported fields");
  assertValueFree(input);
}

export class EffectRegistry {
  private readonly env: NodeJS.ProcessEnv;
  private readonly receipts: ReceiptStore;
  private readonly grants: GrantStore;
  private readonly gatekeeper: GateKeeper;
  private readonly adapter: (context: AdapterContext) => Promise<EffectResult>;
  private readonly now: () => Date;

  constructor(deps: RegistryDependencies = {}) {
    this.env = deps.env ?? process.env;
    this.receipts = deps.receiptStore ?? new ReceiptStore(this.env);
    this.grants = deps.grantStore ?? new GrantStore(this.env);
    this.gatekeeper = deps.gatekeeper ?? new GateKeeper();
    this.adapter = deps.adapter ?? runAdapter;
    this.now = deps.now ?? (() => new Date());
  }

  list() {
    return EFFECT_DEFINITIONS;
  }

  async execute(request: EffectRequest): Promise<EffectExecution> {
    const definition = effectDefinition(request.effectId);
    if (!definition) throw new UcpDeniedError("UCP_EFFECT_UNKNOWN", "Unknown UCP effect ID");
    if (!request.input || typeof request.input !== "object" || Array.isArray(request.input)) {
      throw new UcpDeniedError("UCP_REQUEST_INVALID", "Effect input must be a JSON object");
    }
    const started = this.now();
    const receiptId = newReceiptId();
    const digest = requestDigest({ effectId: request.effectId, input: request.input });
    let dryRun = definition.defaultDryRun;
    let explicitGrantIds: string[] = [];
    let authorized: { grants: GrantRecord[]; capabilityModes: CapabilityMode[] } = {
      grants: [],
      capabilityModes: ["observe", "prepare"],
    };
    const baseReceipt = (): EffectReceipt => ({
      schemaVersion: UCP_SCHEMA_VERSION,
      receiptId,
      effectId: definition.id,
      effectClass: definition.effectClass,
      requestDigest: digest,
      status: "started",
      dryRun,
      startedAt: started.toISOString(),
      completedAt: started.toISOString(),
      principal: currentPrincipal(),
      capabilityModes: authorized.capabilityModes,
      grantIds: explicitGrantIds,
      secretUses: [],
      summary: "Effect authorized; execution not yet complete",
      details: {},
      denialCode: null,
    });

    try {
      assertTypedInput(definition.id, request.input);
      dryRun = dryRunFor(request, definition.supportsDryRun, definition.defaultDryRun);
      explicitGrantIds = safeGrantIds(request.grantIds);
      if (definition.availability === "hard_denied") {
        throw new UcpDeniedError(definition.denialCode || "UCP_EFFECT_HARD_DENIED", "This external effect is deliberately not shipped");
      }
      const modes = authorizationModes(definition.effectClass, definition.requiredModes, dryRun);
      authorized = await this.grants.authorize(definition.id, modes, explicitGrantIds, digest);
    } catch (error) {
      return await this.finishDenied(baseReceipt(), error);
    }

    // Persist an indeterminate-safe marker before any adapter can create an
    // external effect. If the process crashes, the `started` receipt survives.
    const startedReceipt = baseReceipt();
    const receiptPath = await this.receipts.write(startedReceipt);
    const secretUses: EffectReceipt["secretUses"] = [];
    try {
      const loaded = await loadUcpConfig(this.env);
      if (loaded.exists && loaded.safeFile !== true) {
        throw new UcpDeniedError("UCP_CONFIG_FILE_UNSAFE", "UCP configuration must be a non-symlinked, owner-private file in an owner-controlled directory");
      }
      const protectedModes = dryRun
        ? []
        : definition.requiredModes.filter((mode) => !["observe", "prepare", "secret-use"].includes(mode));
      if (protectedModes.length) {
        await this.gatekeeper.authorizeProtectedEffect(
          definition.id,
          `Authorize ${definition.id} for ${protectedModes.join(", ")} · request ${digest.slice(0, 12)}`,
        );
      }
      const result = await this.adapter({
        effectId: definition.id,
        input: request.input,
        dryRun,
        config: loaded.config,
        env: this.env,
        gatekeeper: this.gatekeeper,
        grants: authorized.grants,
        secretUses,
      });
      const completed = this.now();
      const modes = [...new Set<CapabilityMode>([
        ...authorized.capabilityModes,
        ...(secretUses.length ? ["secret-use" as const] : []),
      ])];
      const final: EffectReceipt = {
        ...startedReceipt,
        status: result.status,
        completedAt: completed.toISOString(),
        capabilityModes: modes,
        secretUses,
        summary: result.summary,
        details: result.details || {},
      };
      const finalPath = await this.receipts.write(final);
      return { result, receipt: final, receiptPath: finalPath };
    } catch (error) {
      const denied = await this.finishDenied({ ...startedReceipt, secretUses }, error, receiptPath);
      return denied;
    }
  }

  private async finishDenied(
    receipt: EffectReceipt,
    error: unknown,
    existingPath?: string,
  ): Promise<EffectExecution> {
    const denied = error instanceof UcpDeniedError;
    const status = denied ? error.status : "failed";
    const code = denied ? error.code : "UCP_EFFECT_EXECUTION_FAILED";
    const summary = denied ? error.message : "Effect failed without exposing raw error or child output";
    const final: EffectReceipt = {
      ...receipt,
      status,
      completedAt: this.now().toISOString(),
      summary,
      details: {},
      denialCode: code,
    };
    let path = existingPath || "";
    try {
      path = await this.receipts.write(final);
    } catch (receiptError) {
      if (!existingPath) throw receiptError;
      // The pre-effect `started` receipt remains the durable indeterminate marker.
    }
    return {
      result: { status, summary, details: {} },
      receipt: final,
      receiptPath: path,
    };
  }
}
