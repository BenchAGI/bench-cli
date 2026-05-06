# ADR-004 — Transport selection (local-vs-cloud)

**Status**: Accepted (with explicit divergence from CLIBENCH.md §43–48)
**Date**: 2026-05-05
**Decision-maker**: Hammer (Claude Code) — to be reviewed by Anvil (Codex)

## Context

`CLIBENCH.md:42–48` locks the transport hierarchy:

> - Primary transport: **Bench cloud relay**
> - Secondary fallback: **local OpenClaw Gateway** at `localhost:18789`
> - CLI auto-detects which is reachable; cloud relay wins when both are
>   available unless explicitly overridden

`PRE-SPEC-VERIFICATION.md` documents that **no streaming chat endpoint
exists on the cloud relay today**. The cloud relay
(`https://benchagi.com/api/relay`) serves the customer-side daemon's
lifecycle and run-queue control. Building a cloud chat endpoint would
add ~1 day of web-app work + auth + tests — outside this build cycle.

## Options

### A. Build the cloud chat endpoint as part of this work

- Adds `apps/web/src/app/api/v1/agents/[id]/chat/route.ts` with SSE
  streaming, server-side Firebase token verification, openclaw forwarding.
- Cloud-primary works on day one.
- **Cost**: large. Touches the web app, requires deploy, requires SSO
  with the gateway's auth model, adds streaming infra to Next.js (which
  has known SSE / runtime caveats on App Hosting). Mostly: it's a
  *separate workstream* from the CLI itself.

### B. Ship local-Gateway-WS-primary, deferring cloud entirely

- V1 CLI never tries the cloud relay.
- Code is simplest.
- **Cost**: Forecloses the spec's intent; v1.1 work means revisiting
  transport selection logic + fallback ordering, not just adding an
  adapter.

### C. Ship local-Gateway-WS-primary with a `Transport` adapter
abstraction; cloud transport added in v1.1 by writing a new adapter and
flipping the priority

- V1 has one implementation; v1.1 adds a second.
- The selection logic and detection are written once.
- **Cost**: small — the `Transport` interface is ~30 LOC.

## Decision

**Pick C.** Ship local-Gateway-WS-primary in V1 with a `Transport`
adapter abstraction. Cloud-relay is a v1.1 swap-in.

This is the explicit divergence from CLIBENCH §43–48. It is justified by
verification evidence and acknowledged in PRE-SPEC-VERIFICATION.md.

## The `Transport` interface

```ts
// src/v2/transport/transport.ts
export interface Transport {
  readonly name: string;
  isReachable(): Promise<boolean>;
  connect(opts: ConnectOptions): Promise<void>;
  send(req: RequestFrame): Promise<ResponseFrame>;
  events(): AsyncIterable<EventFrame>;
  abort(runId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  url: string;
  token?: string;
  password?: string;
  agentId: string;
  sessionKey?: string;
  verboseLevel: "off" | "low" | "high" | "full";   // hard "full" in benchagi
  protocolVersion: number;
}
```

V1 implementations:

- `LocalGatewayWsTransport` — uses `ws` library against
  `ws://127.0.0.1:18789` with the OpenClaw protocol.

V1.1 implementations (deferred):

- `CloudRelaySseTransport` — HTTPS + SSE against
  `https://benchagi.com/api/v1/agents/<id>/chat` (when the endpoint
  exists). Speaks the same `EventFrame` shape via a translation layer
  if the wire envelopes diverge (probably they will — see ADR note).
- `CloudRelayWsTransport` — alternate v1.1 path if the cloud endpoint
  is WebSocket instead of SSE.

## Selection logic (V1)

```
1. If --transport=local|cloud is set, use that and fail loudly if
   unreachable.
2. Read $BENCHAGI_TRANSPORT env var; same effect as the flag.
3. Default order:
   - Try local OpenClaw Gateway WS. If reachable, use it. Done.
   - (V1) No cloud transport exists; emit clear error.
   - (V1.1) Try cloud relay. If reachable, use it. Done.
4. If nothing is reachable, emit a doctor-style error message:
   "Could not reach OpenClaw Gateway at <url>. Ensure the gateway is
   running, or run `openclaw doctor`."
```

V1.1 changes the order to: cloud-primary, local-fallback, matching the
spec's original intent — without rewriting selection logic, just by
registering the cloud transport adapter and changing the order.

## Reachability probes

- `LocalGatewayWsTransport.isReachable()`: TCP connect to `localhost:18789`
  with 500ms timeout. Avoid full WebSocket handshake at probe time
  because the handshake validates auth and we don't want to consume a
  retry budget.
- `CloudRelaySseTransport.isReachable()` (v1.1): HTTPS HEAD to
  `https://benchagi.com/api/v1/health` with 1500ms timeout. Cached
  for 60s.

## Wire-format normalization

The `Transport.events()` AsyncIterable yields `EventFrame` objects in
**OpenClaw's** taxonomy (`agent-events.ts:5–17`). If a future cloud
transport speaks a different envelope, that adapter translates inside
its iterator implementation; the renderer never sees a non-OpenClaw
frame shape. This is the "transport adapter layer" from CLIBENCH §142.

## Failure modes

| Mode | V1 behavior |
|---|---|
| Gateway up, auth wrong | WS handshake fails with auth error → exit 7 + suggestion |
| Gateway up, protocol mismatch | Hard exit 6 |
| Gateway down | Clear error + suggestion to run `openclaw doctor` |
| Network drop after connect | Reconnect loop; SPEC §5.4 |

V1.1 will add cloud-side reachability into the selection but not change
local behavior.

## Consequences

- V1 is implementable in this build cycle.
- v1.1 cloud-primary is a clean adapter add.
- The spec's original "cloud-primary" UX is delayed by exactly one
  release.
- The `Transport` interface costs ~30 LOC of overhead now.

## Revisit triggers

- ANVIL 2 surfaces a hard block on local-only V1 (e.g., a contractual
  commitment to ship cloud-primary in this cut).
- Cloud chat endpoint lands before V1 ships → add `CloudRelayTransport`
  to V1 and flip the order.
