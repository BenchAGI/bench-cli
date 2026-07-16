export const UCP_SCHEMA_VERSION = "excalibur.ucp.v1" as const;

export type CapabilityMode =
  | "observe"
  | "prepare"
  | "secret-use"
  | "mutate-tenant"
  | "publish-draft"
  | "outbound-draft";

export type EffectClass =
  | "session"
  | "local-prepare"
  | "orchestra"
  | "publish-draft"
  | "bench-read"
  | "tenant-mutation"
  | "mesh-read"
  | "mesh-mutation"
  | "outbound-draft"
  | "outbound-send";

export type EffectStatus =
  | "started"
  | "succeeded"
  | "dry_run"
  | "denied"
  | "missing_config"
  | "failed";

export type EffectDefinition = {
  id: string;
  description: string;
  effectClass: EffectClass;
  requiredModes: CapabilityMode[];
  supportsDryRun: boolean;
  defaultDryRun: boolean;
  secretUse: "none" | "optional" | "required";
  availability: "shipped" | "ceremony_stub" | "hard_denied";
  denialCode?: string;
};

export type EffectRequest = {
  effectId: string;
  input: Record<string, unknown>;
  dryRun?: boolean;
  execute?: boolean;
  grantIds?: string[];
};

export type SafeEffectDetails = Record<string, string | number | boolean | null>;

export type EffectResult = {
  status: Exclude<EffectStatus, "started">;
  summary: string;
  details?: SafeEffectDetails;
  /** Ephemeral operator output. The registry never persists this field. */
  output?: unknown;
};

export type ReceiptSecretUse = {
  reference: string;
  purpose: string;
  presence: "per_access" | "mission_bundle";
  ttlSeconds: number;
};

export type EffectReceipt = {
  schemaVersion: typeof UCP_SCHEMA_VERSION;
  receiptId: string;
  effectId: string;
  effectClass: EffectClass;
  requestDigest: string;
  status: EffectStatus;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  principal: string;
  capabilityModes: CapabilityMode[];
  grantIds: string[];
  secretUses: ReceiptSecretUse[];
  summary: string;
  details: SafeEffectDetails;
  denialCode: string | null;
};

export type GrantRecord = {
  schemaVersion: typeof UCP_SCHEMA_VERSION;
  grantId: string;
  mode: Exclude<CapabilityMode, "observe" | "prepare">;
  effectIds: string[];
  requestDigest: string;
  sourceReceiptId: string;
  issuedAt: string;
  expiresAt: string;
  principal: string;
  missionSecretBundle: boolean;
  purpose: string;
};

export type UcpConfig = {
  schemaVersion: typeof UCP_SCHEMA_VERSION;
  openclaw: {
    bin: string;
    gatewayTarget: string;
  };
  memory: {
    remoteMcpUrl: string | null;
  };
  bench: {
    apiBase: string | null;
    secretRef: string | null;
    requiredItem: string;
  };
  mesh: {
    controlUrl: string;
    derpUrl: string;
    secretRef: string | null;
    requiredItem: string;
  };
  github: {
    allowedOrgs: string[];
    secretRef: string | null;
    requiredItem: string;
  };
  mail: {
    draftDirectory: string | null;
  };
};

export type HealthState = "live" | "ready" | "locked" | "stub" | "missing" | "blocked" | "drift";

export type HealthLine = {
  id: string;
  state: HealthState;
  summary: string;
};

export type SessionHealthCard = {
  schemaVersion: typeof UCP_SCHEMA_VERSION;
  observedAt: string;
  identity: string;
  expectedRole: string;
  observedRole: string;
  capabilityModes: CapabilityMode[];
  openGrantIds: string[];
  lines: HealthLine[];
  blockers: string[];
};

export class UcpDeniedError extends Error {
  readonly code: string;
  readonly status: "denied" | "missing_config";

  constructor(code: string, message: string, status: "denied" | "missing_config" = "denied") {
    super(message);
    this.name = "UcpDeniedError";
    this.code = code;
    this.status = status;
  }
}
