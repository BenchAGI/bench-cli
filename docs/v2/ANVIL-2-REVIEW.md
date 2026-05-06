# ANVIL-2-REVIEW

## Verdict
Revise then ship. The local-Gateway-primary V1 divergence is right, but the spec is not code-ready: the gateway connect/subscription shape is wrong, the auth handoff cannot work as written, and event/liveness/reconnect behavior is underspecified for the exact failure modes CLIBENCH asks about.

## Severity scale
P0 = blocks ship · P1 = must fix before code · P2 = fix during impl · P3 = defer

## Findings

### [P0] Gateway subscription frame is not the OpenClaw protocol
**Where**: SPEC.md §5.2; ADR-004 "The `Transport` interface"
**What's wrong**: The spec invents a connect frame with `clientName`, `clientMode`, `protocolVersion`, `capabilities`, `verboseLevel`, `agentId`, and `sessionKey`. Actual OpenClaw `ConnectParams` has `minProtocol`, `maxProtocol`, nested `client`, `caps`, `auth`, `role`, and `scopes`; `additionalProperties: false` rejects the spec frame. The tool cap is `"tool-events"`, not `"TOOL_EVENTS"`. `verboseLevel` is not connection-level.
**Impact**: The first WebSocket handshake fails, or it connects without tool-event capability. The hard `verboseLevel=full` requirement is not satisfied, so tool `result` / `partialResult` can still be stripped.
**Fix**: Spec against the real `GatewayClient` contract: `minProtocol/maxProtocol = PROTOCOL_VERSION`, `client.id = "cli"` or existing accepted id, `client.mode = "ui"` or `"cli"`, `caps = ["tool-events"]`. To force full tool output, either patch/create the benchagi-owned session with `sessions.patch { key, verboseLevel: "full" }` before `chat.send`, or add a run-scoped upstream param explicitly. Add a protocol fixture test that proves `tool.result` survives.

### [P0] Browser handoff cannot work as written
**Where**: SPEC.md §4.1-§4.2; ADR-002 "Decision"
**What's wrong**: §4.1 says the web page POSTs to `http://localhost:<port>`. §4.2 says a Next server route receives tokens and POSTs them to the CLI port. The server route cannot reach the user's loopback listener; it would POST to the server's localhost. ADR-002 also says "no new server endpoints" while SPEC.md adds one. The "manual-paste" URL is not a real fallback because no code-paste exchange exists.
**Impact**: `benchagi auth login` fails on the happy path, so refresh-token storage and mid-session reauth never work.
**Fix**: Pick one concrete flow. Option A: pure browser-to-listener, where page JS directly POSTs to `127.0.0.1:<port>` and the server route is removed. Option B: switch ADR-002 to code-paste/PKCE-style one-time code, where the CLI exchanges the code over HTTPS. In both cases, specify exactly how the refresh token is obtained, who sees it, nonce/state validation, TTL, and cross-machine behavior.

### [P1] Firebase auth is incorrectly a hard gate for local-only V1
**Where**: SPEC.md §3, §4.4, §5.1, §12
**What's wrong**: V1 transport is local Gateway only, and local Gateway auth is token/password/device auth. Firebase identity is for the deferred cloud path, but bare `benchagi` exits if Firebase auth is missing. The spec also references an `auth_expired` Gateway signal that the event taxonomy/protocol does not define.
**Impact**: A local streaming CLI becomes unusable during Firebase/web auth outages, even though the selected V1 transport does not need Firebase. Mid-session auth expiry and identity migration are hand-waved rather than handled.
**Fix**: Split user identity from transport auth. For V1 local transport, require Gateway auth only; make Firebase auth required only for cloud transport and cloud-bound commands. For v1.1, define an `AuthBackend` discovery/negotiation endpoint and normalize cloud 401/close codes into `AUTH_EXPIRED`, followed by refresh and run resume.

### [P1] Reconnect/resume loses active runs
**Where**: SPEC.md §5.4, §12; ADR-004 "Failure modes"
**What's wrong**: "Reconnect with last `sessionKey`" is not enough. The real Gateway client rejects pending RPCs on close, schedules reconnect, and reports sequence gaps, but the spec does not define how to recover an in-flight `chat.send`, re-register tool-event recipients, catch up missed `chat`/`agent` events, or avoid duplicate sends.
**Impact**: Flaky networks can lose final output, orphan a running agent, duplicate a user message, or leave the liveness line claiming work is active after the client stopped receiving the run.
**Fix**: Make run recovery explicit: generate one `runId`/idempotency key before send; never resend blindly; on reconnect, re-open the session, reconcile via `chat.history` and `agent.wait` or equivalent, reattach tool-event routing, and handle `onGap` by showing a gap warning plus history reconciliation.

### [P1] Event handling is missing the Gateway event router
**Where**: SPEC.md §6; ADR-005 "Indicator UX"
**What's wrong**: Rendering only `AgentEventPayload.stream` is incomplete. The Gateway sends top-level `EventFrame.event` values: `chat`, `chat.side_result`, `agent`, `session.tool`, `sessions.changed`, `tick`, `shutdown`, approval events, and more. Batch backend final text can arrive as `chat`, not `assistant`. `session.tool` mirrors `agent` tool events and must be deduped.
**Impact**: Batch output can disappear, side results are dropped, tool cards can duplicate, session changes are stale, shutdown looks like a crash, and many simultaneous runs interleave incoherently.
**Fix**: Add an event-router section before renderer rules: switch on `EventFrame.event`; render `chat` as assistant delta/final; unwrap `agent` into taxonomy renderer; accept `session.tool` only for late-join/resume and dedupe by `(runId, seq, stream, toolCallId/itemId)`; use `tick` for connection heartbeat; render `shutdown`; update session lists on `sessions.changed`; explicitly ignore or handle every listed Gateway event.

### [P1] Approval UX has no resolution path
**Where**: SPEC.md §6 `approval`; §13 tests
**What's wrong**: The spec renders `[A]pprove / [D]eny / [Q]uit` but does not name the RPCs, decision values, scopes, or IDs. OpenClaw has `exec.approval.resolve` and `plugin.approval.resolve` plus top-level requested/resolved events; the spec only mentions taxonomy stream rendering.
**Impact**: A run that asks for approval blocks forever, or Ctrl-C cannot reliably default-deny.
**Fix**: Specify a pending-approval state machine keyed by `approvalId`/`approvalSlug`; map exec approvals to `exec.approval.resolve` and plugin approvals to `plugin.approval.resolve`; define approve/deny decision strings; handle resolved/expired events; add tests for approve, deny, Ctrl-C deny, reconnect with pending approval.

### [P1] Liveness is still not distinguishable from a frozen process
**Where**: SPEC.md §7.2; ADR-001 "Consequences"; ADR-005 "Indicator UX"
**What's wrong**: Streaming-classified backends get no liveness line, even though provider/tool silence can last minutes. Non-TTY mode drops the liveness indicator entirely. The batch spinner proves only that the Node event loop is repainting, not that the Gateway or run is alive. "Last event" also conflates Gateway ticks with run events.
**Impact**: During long batch runs, CI logs and non-TTY captures go silent. In TTY, a frozen render loop and a crashed process are still visually close. Users cannot tell "gateway alive, run quiet" from "client disconnected".
**Fix**: Always track two ages: last Gateway frame/tick and last run event. TTY line should show `run quiet Xs | gateway tick Ys | pid N | Ctrl-C abort`. Non-TTY should print status every 30s. Show the liveness line for any run after N seconds without non-tick events, not only statically batch-classified backends.

### [P1] Large full-output handling happens too late
**Where**: SPEC.md §6, §12; ADR-004 "Wire-format normalization"
**What's wrong**: The spec says tool results over 10 MB are saved to a temp file, but with `verboseLevel=full` the result must first cross the WebSocket. Gateway policy is max payload 25 MB and max buffered bytes 50 MB; targeted tool events are not drop-if-slow. Renderer-side truncation does not protect transport memory or disconnects.
**Impact**: Large tool outputs can close the socket before the CLI can save/truncate them, especially with many agents or slow terminals. The "full firehose" requirement fails exactly when outputs are biggest.
**Fix**: Spec transport limits from `hello.policy.maxPayload`. For V1, state that payloads above Gateway max cannot be recovered client-side and must be offloaded upstream or capped before broadcast. Add client backpressure handling, slow-consumer messaging, and tests for near-limit payloads. Do not claim `>10 MB` temp-file support unless the wire path supports it.

### [P2] Capability probe depends on unstable model-prefix assumptions
**Where**: SPEC.md §7.1; ADR-005 "Heuristic table"
**What's wrong**: The heuristic treats `model.primary` prefixes as backend capability. That is useful, but not authoritative: fallback can change actual runtime mid-run, configured model names do not always equal transport behavior, and "unknown assumes streaming" can suppress liveness until a timeout.
**Impact**: New providers or changed prefixes make long-running agents look streaming-capable when they are batch-only, recreating silent CLI behavior.
**Fix**: Keep the heuristic, but make runtime observation primary after run start. If no non-tick event arrives within 5s for any backend, show liveness. If actual events contradict the heuristic, update only the current run unless the user persists with `--remember`.

### [P2] Bench-compatibility constraints are not internally clean
**Where**: SPEC.md §2, §9, §10, §16
**What's wrong**: The spec says legacy `bench` is unchanged, but the same package bumps the engine from Node >=20 to >=22.12. It inherits "filter OpenClaw banner noise from JSON" while rejecting shell-out as the wire, so that constraint no longer applies to `benchagi`. Homebrew examples install `bench`, not `benchagi`, without saying whether the formula exposes both binaries.
**Impact**: Existing `bench` users on Node 20 can break on upgrade, and implementation may preserve irrelevant wrapper behavior in the V2 path.
**Fix**: Either keep the package Node floor at >=20 if V2 code can run there, or state plainly that `bench` is unchanged only on supported Node >=22.12. Move banner-noise filtering under legacy `bench` only. Specify package `bin` entries and Homebrew formula output for both `bench` and `benchagi`.

## Cross-check vs. recon and verification

Verification is right over the original cloud-primary brief. The inspected relay is HTTP/JSON run-queue/control-plane code, not a synchronous streaming CLI chat transport. ADR-004's local-Gateway-primary V1 is therefore the correct divergence.

The spec contradicts actual OpenClaw on the WebSocket connect shape and `verboseLevel=full` mechanism; actual code is right. `verboseLevel` is session/run context, not a connect-frame field. Fix the spec, not the gateway.

The spec also contradicts Phase 0 by making Firebase auth mandatory for V1 local chat. Phase 0 says the CLI does not need the cloud relay until v1.1; therefore Firebase identity should not block local Gateway use in V1.

Recon's event taxonomy is correct but incomplete as an implementation plan. The taxonomy lives inside top-level Gateway events. `benchagi` must handle `chat`, `agent`, `session.tool`, `chat.side_result`, `tick`, `shutdown`, and approval events before taxonomy-specific rendering is reliable.

Bench compatibility is directionally right but internally inconsistent around the shared package Node floor, Homebrew binary exposure, and legacy-only JSON filtering.

## What's not broken (a short list)

- Local-Gateway-primary V1 is the only implementable streaming path given Phase 0.
- Keeping `benchagi` alongside legacy `bench` is the right compatibility framing.
- Raw ANSI is a defensible renderer choice if the event router and liveness model are tightened.
- `keytar` as the primary token store is right; any fallback must be explicit and degraded.
- The required taxonomy list matches `openclaw/src/infra/agent-events.ts`.
- Tool output collapsed by default is right at the UX layer; the missing part is transport/offload safety.
