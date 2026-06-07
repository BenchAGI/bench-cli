// Minimal mirror of OpenClaw's gateway protocol surface that benchagi
// V2 needs. The authoritative schema lives in the openclaw repo at
// src/gateway/protocol/schema/frames.ts —
// keep this file aligned. We re-derive shapes here rather than depend on
// the openclaw package because openclaw isn't published.

// Gateway requires v4 (MIN_CLIENT_PROTOCOL_VERSION = 4): chat deltas carry `deltaText`.
export const PROTOCOL_VERSION = 4;

export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events",
} as const;

export type GatewayClientCap =
  (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: string;
    instanceId?: string;
  };
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  role?: string;
  scopes?: string[];
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  auth?: {
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    password?: string;
  };
  locale?: string;
  userAgent?: string;
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[] };
  snapshot: unknown;
  canvasHostUrl?: string;
  auth?: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
    deviceTokens?: Array<{
      deviceToken: string;
      role: string;
      scopes: string[];
      issuedAtMs: number;
    }>;
  };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
};

export type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

// AgentEvent stream taxonomy per
// openclaw/src/infra/agent-events.ts:5-17
export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

// Approval data shape per agent-events.ts:55-72
export type ApprovalEventData = {
  phase: "requested" | "resolved";
  kind: "exec" | "plugin" | "unknown";
  status: "pending" | "unavailable" | "approved" | "denied" | "failed";
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  message?: string;
};

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: unknown;
  sessionKey?: string;
};
