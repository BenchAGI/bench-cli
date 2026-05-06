// Transport interface — ADR-004.

import type { EventFrame, RequestFrame, ResponseFrame } from "../protocol/types.js";

export type ConnectOptions = {
  url: string;
  token?: string;
  password?: string;
  agentId?: string;
  sessionKey?: string;
  protocolVersion: number;
};

export interface Transport {
  readonly name: string;
  isReachable(): Promise<boolean>;
  connect(opts: ConnectOptions): Promise<HelloPolicy>;
  request(method: string, params?: unknown): Promise<unknown>;
  events(): AsyncIterable<EventFrame>;
  abort(runId: string): Promise<void>;
  close(): Promise<void>;
}

export type HelloPolicy = {
  protocol: number;
  serverVersion: string;
  connId: string;
  methods: string[];
  events: string[];
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
};

// Re-export for transport implementations.
export type { EventFrame, RequestFrame, ResponseFrame };
