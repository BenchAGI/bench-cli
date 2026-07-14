// LocalGatewayWsTransport — ADR-004.
// Connects to ws://127.0.0.1:18789. Protocol per the openclaw repo
// src/gateway/client.ts (connect handshake):
//   1. WS open
//   2. Server emits event { event: "connect.challenge", payload: { nonce } }
//   3. Client sends req { type: "req", id, method: "connect", params: ConnectParams }
//   4. Server responds res { type: "res", ok: true, payload: HelloOk }
// Subsequent traffic is req/res for RPC + event for streaming.

import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { WebSocket, type RawData } from "ws";
import type { ConnectParams, EventFrame, HelloOk, RequestFrame, ResponseFrame } from "../protocol/types.js";
import { GATEWAY_CLIENT_CAPS, PROTOCOL_VERSION } from "../protocol/types.js";
import { CLI_VERSION } from "../commands/version.js";
import type { ConnectOptions, HelloPolicy, Transport } from "./transport.js";
import {
  buildDeviceAuthPayloadV3,
  loadOpenClawDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../auth/device-identity.js";
import { nextBackoffMs } from "./backoff.js";

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REACHABILITY_TIMEOUT_MS = 500;

export type ReconnectListeners = {
  onDisconnected?: () => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  onReconnected?: () => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
};

export class LocalGatewayWsTransport implements Transport {
  readonly name = "local-gateway-ws";

  private ws: WebSocket | null = null;
  private url: string;
  private pending = new Map<string, Pending>();
  private eventQueue: EventFrame[] = [];
  private eventResolvers: Array<(value: IteratorResult<EventFrame>) => void> = [];
  private closed = false;
  private userClosed = false;
  private hello: HelloOk | null = null;
  private debugLog: ((line: string) => void) | null = null;
  private rawFrameLog: ((direction: "in" | "out", raw: string) => void) | null = null;
  private connectNonce: string | null = null;

  // Reconnect state (V1.1 — Item 1).
  private lastConnectOpts: ConnectOptions | null = null;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectListeners: ReconnectListeners = {};

  constructor(opts: {
    url?: string;
    debugLog?: (line: string) => void;
    rawFrameLog?: (direction: "in" | "out", raw: string) => void;
  } = {}) {
    this.url = opts.url ?? "ws://127.0.0.1:18789";
    this.debugLog = opts.debugLog ?? null;
    this.rawFrameLog = opts.rawFrameLog ?? null;
  }

  async isReachable(): Promise<boolean> {
    return await new Promise((resolve) => {
      const m = /^wss?:\/\/([^:/]+)(?::(\d+))?/.exec(this.url);
      if (!m) return resolve(false);
      const host = m[1] ?? "127.0.0.1";
      const port = m[2] ? parseInt(m[2], 10) : 18789;

      const sock = netConnect({ host, port, timeout: REACHABILITY_TIMEOUT_MS }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  async connect(opts: ConnectOptions): Promise<HelloPolicy> {
    if (this.ws) throw new Error("already connected");

    // Snapshot the connect options for reconnect (V1.1 — Item 1).
    this.lastConnectOpts = opts;

    const url = opts.url || this.url;
    this.url = url;

    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 25 * 1024 * 1024 });
    this.ws = ws;

    return await new Promise<HelloPolicy>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms (${url})`));
      }, CONNECT_TIMEOUT_MS);

      const finishOk = (hello: HelloOk) => {
        clearTimeout(timeout);
        this.hello = hello;
        this.installSteadyStateHandlers();
        resolve({
          protocol: hello.protocol,
          serverVersion: hello.server.version,
          connId: hello.server.connId,
          methods: hello.features.methods,
          events: hello.features.events,
          policy: hello.policy,
        });
      };

      const finishErr = (err: Error) => {
        clearTimeout(timeout);
        try { ws.close(); } catch { /* ignore */ }
        reject(err);
      };

      ws.on("open", () => {
        // Wait for connect.challenge before sending connect req.
      });

      // Temporary handler — replaced by installSteadyStateHandlers on success.
      const initialMessage = (raw: RawData) => {
        const data = typeof raw === "string" ? raw : raw.toString();
        this.rawFrameLog?.("in", data);
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null) return;

        const m = msg as { type?: string; event?: string; payload?: unknown; id?: string; ok?: boolean; error?: { code?: string; message?: string } };

        if (m.type === "event" && m.event === "connect.challenge") {
          const payload = m.payload as { nonce?: string } | undefined;
          const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
          if (!nonce) {
            finishErr(new Error("gateway connect-challenge missing nonce"));
            return;
          }
          this.connectNonce = nonce;
          this.sendConnectRequest(opts).then((hello) => finishOk(hello), finishErr);
          return;
        }

        if (m.type === "res" && m.id === pendingConnectId) {
          // Will be handled by sendConnectRequest's pending entry.
          // (fall through — we install pending in sendConnectRequest)
        }

        if (m.type === "event" && m.event && m.event !== "connect.challenge" && m.event !== "tick") {
          // Ignore stray events before connect completes.
          return;
        }
      };

      let pendingConnectId = "";

      const realInitial = (raw: RawData) => initialMessage(raw);
      ws.on("message", realInitial);

      ws.on("error", (err) => {
        finishErr(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("close", (code, reason) => {
        const reasonText = typeof reason === "string" ? reason : reason?.toString?.() ?? "";
        finishErr(new Error(`gateway closed (${code}): ${reasonText || "before hello-ok"}`));
      });

      this.sendConnectRequest = async (connectOpts: ConnectOptions): Promise<HelloOk> => {
        const v = connectOpts.protocolVersion ?? PROTOCOL_VERSION;
        const role = "operator";
        const scopes = ["operator.read", "operator.write"];
        const signedAtMs = Date.now();
        const platform = process.platform;
        const clientId = "cli";
        const clientMode = "ui";

        // Load device identity for signed-handshake. V1 piggybacks on
        // openclaw's existing identity at ~/.openclaw/identity/device.json.
        const identity = await loadOpenClawDeviceIdentity();
        const device = buildDeviceParams({
          identity,
          nonce: this.connectNonce ?? "",
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs,
          token: connectOpts.token ?? null,
          platform,
        });

        const params: ConnectParams = {
          minProtocol: v,
          maxProtocol: v,
          client: {
            id: clientId,
            displayName: "benchagi",
            version: CLI_VERSION,
            platform,
            mode: clientMode,
          },
          caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
          role,
          scopes,
          ...(device ? { device } : {}),
          ...(connectOpts.token || connectOpts.password
            ? { auth: { token: connectOpts.token, password: connectOpts.password } }
            : {}),
        };
        const id = randomUUID();
        pendingConnectId = id;
        const req: RequestFrame = { type: "req", id, method: "connect", params };

        return await new Promise<HelloOk>((resolveConnect, rejectConnect) => {
          const onMsg = (raw: RawData) => {
            const data = typeof raw === "string" ? raw : raw.toString();
            let msg: unknown;
            try { msg = JSON.parse(data); } catch { return; }
            if (typeof msg !== "object" || msg === null) return;
            const m = msg as { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: { code?: string; message?: string } };
            if (m.type !== "res" || m.id !== id) return;
            ws.off("message", onMsg);
            ws.off("message", realInitial);
            if (m.ok && m.payload) {
              resolveConnect(m.payload as HelloOk);
            } else {
              const detail = JSON.stringify((m.error as { details?: unknown })?.details ?? {});
              rejectConnect(new Error(`connect rejected: ${m.error?.code ?? "ERR"} — ${m.error?.message ?? "unknown"} ${detail}`));
            }
          };
          ws.on("message", onMsg);
          const rawReq = JSON.stringify(req);
          this.rawFrameLog?.("out", rawReq);
          ws.send(rawReq);
        });
      };
    });
  }

  // Filled in by connect(); typed here to make TS happy.
  private sendConnectRequest: (opts: ConnectOptions) => Promise<HelloOk> = async () => {
    throw new Error("not initialized");
  };

  // Class continues with installSteadyStateHandlers, request, events, etc.
  // (helpers below the class)

  // (removed earlier accidental class closure)
  // BEGIN_REPLACED_HELPER_PLACEHOLDER
  __unused_inner_helper(_args: {
    identity: DeviceIdentity | null;
    nonce: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token: string | null;
    platform: string;
  }): null {
    void _args;
    return null;
  }

  private installSteadyStateHandlers(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.removeAllListeners("message");
    ws.removeAllListeners("close");
    ws.removeAllListeners("error");

    ws.on("message", (raw) => {
      const data = typeof raw === "string" ? raw : raw.toString();
      this.rawFrameLog?.("in", data);
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string };

      if (m.type === "res") {
        const r = msg as ResponseFrame;
        const p = this.pending.get(r.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(r.id);
        if (r.ok) {
          p.resolve(r.payload);
        } else {
          const err = r.error;
          p.reject(
            new Error(
              `${err?.code ?? "ERR"}: ${err?.message ?? "unknown error"}`,
            ),
          );
        }
        return;
      }

      if (m.type === "event") {
        const e = msg as EventFrame;
        if (this.eventResolvers.length > 0) {
          const next = this.eventResolvers.shift();
          if (next) next({ value: e, done: false });
        } else {
          this.eventQueue.push(e);
          if (this.eventQueue.length > 10_000) {
            // Backpressure: drop oldest tick events; keep agent/chat/error.
            const idx = this.eventQueue.findIndex((f) => f.event === "tick");
            if (idx >= 0) this.eventQueue.splice(idx, 1);
          }
        }
      }
    });

    ws.on("close", () => {
      // Stale-close guard: a prior socket's close event MUST NOT poison
      // the active socket if a reconnect already swapped `this.ws` out.
      // Codex Anvil P1.
      if (this.ws !== ws) return;

      // Pending requests can never be auto-replayed; reject them so the
      // caller can decide. Event resolvers stay pending across a network
      // reconnect — only drain them on user-initiated close.
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
      }
      this.pending.clear();

      this.ws = null;

      if (this.userClosed) {
        for (const r of this.eventResolvers) {
          r({ value: undefined as unknown as EventFrame, done: true });
        }
        this.eventResolvers.length = 0;
        this.closed = true;
        return;
      }

      // Network close — keep events() iterator alive, kick off reconnect.
      this.reconnectListeners.onDisconnected?.();
      void this.reconnectLoop();
    });

    ws.on("error", (err) => {
      this.debug(`ws error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Register reconnect lifecycle listeners. Replaces any prior registration.
   * V1.1 — Item 1.
   */
  setReconnectListeners(listeners: ReconnectListeners): void {
    this.reconnectListeners = listeners ?? {};
  }

  /**
   * Reconnect loop (V1.1 — Item 1). Backoff sequence per `nextBackoffMs`.
   * Keeps trying until either reconnected or the user calls close().
   * Exposed only via callbacks; the events() iterator does NOT yield
   * reconnect events directly.
   */
  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempt = 0;
    try {
      while (!this.userClosed) {
        this.reconnectAttempt += 1;
        const delay = nextBackoffMs(this.reconnectAttempt);
        this.reconnectListeners.onReconnecting?.(this.reconnectAttempt, delay);
        await new Promise<void>((r) => setTimeout(r, delay));
        if (this.userClosed) return;
        if (!this.lastConnectOpts) {
          this.debug("reconnect aborted: no connect opts cached");
          return;
        }
        try {
          // Reset transport state so connect() can run cleanly.
          this.ws = null;
          this.closed = false;
          this.connectNonce = null;
          this.hello = null;
          await this.connect(this.lastConnectOpts);
          this.reconnectAttempt = 0;
          this.reconnectListeners.onReconnected?.();
          return;
        } catch (err) {
          this.debug(`reconnect attempt ${this.reconnectAttempt} failed: ${err instanceof Error ? err.message : String(err)}`);
          // Loop again with next backoff.
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.closed) throw new Error("not connected");
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const raw = JSON.stringify(frame);
      this.rawFrameLog?.("out", raw);
      this.ws!.send(raw);
    });
  }

  async *events(): AsyncIterable<EventFrame> {
    // Iterator stays alive across network reconnects; only exits when
    // the user calls close() (V1.1 — Item 1).
    while (!this.userClosed) {
      if (this.eventQueue.length > 0) {
        const e = this.eventQueue.shift();
        if (e) yield e;
        continue;
      }
      const next = await new Promise<IteratorResult<EventFrame>>((resolve) => {
        this.eventResolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  async abort(runId: string): Promise<void> {
    try {
      await this.request("chat.abort", { runId });
    } catch (err) {
      this.debug(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    this.userClosed = true;
    this.closed = true;
    // Drain any pending event waiters so a parked events() loop exits.
    for (const r of this.eventResolvers) {
      r({ value: undefined as unknown as EventFrame, done: true });
    }
    this.eventResolvers.length = 0;
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  helloPolicy(): HelloOk["policy"] | null {
    return this.hello?.policy ?? null;
  }

  features(): { methods: string[]; events: string[] } | null {
    return this.hello?.features ?? null;
  }

  private debug(line: string): void {
    if (this.debugLog) this.debugLog(`[transport] ${line}`);
  }
}

function buildDeviceParams(args: {
  identity: DeviceIdentity | null;
  nonce: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  platform: string;
}): {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
} | null {
  if (!args.identity || !args.nonce) return null;
  const payload = buildDeviceAuthPayloadV3({
    deviceId: args.identity.deviceId,
    clientId: args.clientId,
    clientMode: args.clientMode,
    role: args.role,
    scopes: args.scopes,
    signedAtMs: args.signedAtMs,
    token: args.token,
    nonce: args.nonce,
    platform: args.platform,
  });
  return {
    id: args.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(args.identity.publicKeyPem),
    signature: signDevicePayload(args.identity.privateKeyPem, payload),
    signedAt: args.signedAtMs,
    nonce: args.nonce,
  };
}
