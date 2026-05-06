# ACTION-PLAN — `benchagi` V2 follow-ups

**Last updated**: 2026-05-05
**Status**: V1 ships; v1.1 work captured below.
**Branch**: `feat/v2-streaming-cli` in `BenchAGI/bench-cli`

This is the durable cold-readable handoff. A new contributor (or me in
a future session) should be able to pick up from here without context.

---

## Where things stand

### What works in V1 (verified live against brew openclaw 2026.5.2)

- `benchagi doctor` — reachability, protocol v3 negotiation, full method
  validation (`chat.send`, `chat.history`, `chat.abort`, `sessions.list`,
  `sessions.patch`, approval RPCs), agent count.
- `benchagi agents list` / `benchagi agents use <name>` — short-name
  resolution + state persistence.
- `benchagi --agent <name> "<message>"` — single-turn ask, waits up to
  120s for chat-final or chat-error.
- `benchagi` — interactive REPL with multi-line input + history.
- `benchagi version`, `benchagi --help`.
- `benchagi auth login/logout/status` — Firebase Direct browser-to-loopback
  flow plumbed; not required for V1 local use.

Verified live: `benchagi --agent kestrel-coder "ping"` produced
`HEARTBEAT_OK` + `[run ended]` end-to-end. Verified P0 fix: chat-error
events now render `errorMessage` (e.g., openai-codex token expiry
surfaced clearly).

### Tests

34 unit tests, all green. Coverage:

- Event router (top-level dispatch, dedupe, taxonomy unwrap)
- Capability probe (model heuristic + override semantics)
- Agent short-name resolution
- Liveness formatter (TTY two-clock, stuck/unhealthy)
- State file round-trip

Missing per SPEC §13: live transport tests, auth flow happy-path test
(needs the Firebase web app's CLI completion page), reconnect tests
(reconnect not yet implemented), approval flow tests, large-output
tests.

---

## P1s landed pre-tag (from ANVIL-3 review)

- **Chat payload extraction** — was reading `payload.text`; now reads
  `payload.message.content[]` per the real OpenClaw schema. Without
  this, batch backends (Claude CLI, Codex) finished with blank answers.
  Fixed in `src/v2/render/stream.ts:extractChatText`.
- **`sessions.create` schema** — was sending `verboseLevel: "full"` as a
  create param, which the schema rejects. Now creates with `agentId`
  only, then asserts `verboseLevel: "full"` via `sessions.patch`.
- **Required-method validation** — was checking 3 methods; now checks 7
  (incl. `sessions.patch`, `chat.abort`, `exec.approval.resolve`,
  `plugin.approval.resolve`).
- **Wiki trimmed** — removed over-claims about reconnect, `[r]` expand,
  build SHA in version, Ctrl-C-restores-prompt; added a Quick Start
  section and a Known Limitations section.

---

## Deferred to v1.1

ANVIL-3 flagged 4 items as P1 (items 1–4 below). Items 5–7 are
quality-of-life follow-ups (P2-grade per ANVIL-3) that are sequenced
into the V1.1 cycle alongside the P1s for convenience.

### 1. Reconnect + history recovery (SPEC §5.5–§5.6) — ANVIL-3 P1

The CLI does not currently reconnect after gateway disconnect mid-run.
On disconnect, the event loop ends and `waitForFinal` times out.

**Required**:
- Track last `EventFrame.seq` per session as cursor.
- On disconnect, schedule reconnect with backoff (1s, 2s, 5s, 10s, 30s).
- After re-`connect` + re-`sessions.patch verboseLevel=full`, call
  `chat.history` with `since-seq`; replay missed events through the
  router, deduped via the existing `(runId, seq, stream, toolCallId)`
  key.
- If the run completed during the disconnect, render the missed final.
- If still in flight, reattach via the runId; do not resend the user
  message (idempotency key was generated client-side).

**Files**: `src/v2/transport/local-gateway.ts` (reconnect machinery),
`src/v2/chat-runner.ts` (history replay, run reattach).

**Tests required** (per SPEC §13): "Reconnect: in-flight run recovery
via chat.history", "Reconnect: network drop backoff sequence",
"Renderer: seq gap warning". Mock by injecting fake disconnect events.

### 2. Liveness reconnect wiring + active-run scoping — ANVIL-3 P1

ANVIL-3 P1: liveness says "(connection unhealthy — reconnecting)" but
no reconnect callback is wired. Either:

- Wire reconnect (covered by item 1), and the liveness label becomes
  truthful, OR
- Change the label until reconnect ships ("(connection unhealthy)").

ANVIL-3 also noted liveness is connection-scoped, not active-run-scoped.
Idle REPL between turns shouldn't engage the indicator. Fix: track a
"run in flight" boolean in `ChatRunner` and pass to `LivenessIndicator`;
indicator only visible when `inFlight && runQuietMs > threshold`.

**Files**: `src/v2/render/liveness.ts`, `src/v2/chat-runner.ts`.

### 3. Approval REPL key handling — ANVIL-3 P1

`ApprovalState.handleKey` exists but the REPL does not pass keystrokes
to it. The bordered approval prompt renders correctly (state machine
runs), but `[A]`/`[D]` aren't intercepted from `node:readline`'s line
input. Ctrl-C currently exits the process, not default-deny.

**Required**:
- Switch `repl/prompt.ts` to raw-mode keypress events in addition to
  line input.
- Route single-character keys to `ApprovalState.handleKey` while a
  pending approval exists.
- Wire SIGINT to `ApprovalState.denyOnInterrupt` when pending.

**Files**: `src/v2/repl/prompt.ts`, `src/v2/cli.ts`.

### 4. Tool-block error detail rendering — ANVIL-3 P1

ANVIL-3 P1: failed tool calls show only `└─ <name> failed`. Should show:

- exit code (if present in payload)
- stderr summary (truncated like result)
- error message (from `data.error`)
- duration

**File**: `src/v2/render/stream.ts:renderTool` (error branch).

### 5. `[r]` interactive tool-output expand — V1.1 follow-up (ANVIL-3 P2)

The hint `(press [r] to expand)` is rendered but no key handler exists.
Two paths:

- Per-tool-call expand: track tool blocks by `(runId, toolCallId)`,
  store full result, repaint when `[r]` pressed within the prompt
  buffer for that block. Complex.
- Always-expand global toggle: `[r]` flips `--full` for the rest of the
  REPL session. Simple.

Recommend the simple path for v1.1; defer per-block expand to v1.2.

**File**: `src/v2/repl/prompt.ts`, `src/v2/render/stream.ts`.

### 6. Auth port-collision retry — V1.1 follow-up (ADR-002 housekeeping)

ANVIL-3 P1: ADR-002 says retry once on `EADDRINUSE`. Current code
fails immediately. Wrap the listener creation in a single retry loop.

**File**: `src/v2/auth/firebase-direct.ts`.

### 7. Cross-machine `--device-flow` — V1.1 follow-up (separate from A1–A6)

ADR-002 documented the cross-machine fallback. Implement when V1.1
cloud transport ships (PKCE code-paste against
`https://benchagi.com/auth/cli/code` exchanging for tokens via the
Firebase web app).

---

## P2 / P3 follow-ups

### Cloud-relay primary transport (ADR-004 + ADR-006)

Wait for cloud-brain Phase 1B + W3 (the openclaw `/v1/llm_turn`
endpoint) to ship. Then either:

- Add a `CloudRelayTransport` adapter that speaks the same `chat.send`
  / event taxonomy over WSS to `wss://benchagi.com/relay/cli` (if a
  streaming endpoint is built).
- Or bypass — keep local-Gateway-WS-primary, since cloud-brain
  delegates LLM turns at a layer below the gateway, and the CLI sees
  identical events.

ADR-006 explicitly rejects building a directive-queue (LlmTurnDirective)
adapter into benchagi; that's the wrong shape.

### Tests per SPEC §13 (the rest)

- Auth: localhost-listener happy path + CSRF mismatch + 90s timeout
  (needs the Firebase web app's CLI completion page deployed).
- Auth: refresh-token revoked → wipe keychain.
- Connect: ConnectParams accepted by real gateway (live integration
  test).
- Connect: protocol-version mismatch.
- verboseLevel=full lands in session (live test using a fixture tool).
- Renderer: tool result truncation + expand (after [r] ships).
- Probe: classification overridden by runtime.
- REPL: Ctrl-C interrupt during stream (needs raw-mode key handling).
- REPL: multi-line input continuation.

### Multi-account support

Out of scope per CLIBENCH §111. v1.x feature once Firebase Direct
becomes the default.

### Redaction policy

CLIBENCH §111 — "NO redaction in v1." Spec'd as a known follow-up.
v1.x.

### Windows support

V1 documented as macOS + Linux only. Windows path is per-feature:

- `keytar`: works on Windows Credential Vault.
- Loopback listener: works.
- ANSI rendering: needs Windows Terminal or PowerShell 7+; older
  consoles need a polyfill (`@colors/colors` or similar).
- `xdg-open` → `start` shell-out for browser launch.

Logged as v1.x.

### Migrating legacy `bench` verbs

`bench feed`, `bench tail`, `bench commitments`, `bench tasks` are still
shell-out wrappers. Port to native protocol if/when meaningful.

---

## Top 3 risks at v1.0 launch

1. **Reconnect missing** — flaky networks lose the run silently. Mitigation:
   document loud-and-clear in Wiki + README; ship reconnect in v1.1
   within 2 weeks of v1.0.
2. **Approval keystrokes not intercepted** — runs that hit an `exec` or
   `plugin` approval prompt block the user. Mitigation: pre-launch,
   most operator workflows have already approved their tool set; this
   is a rare path. v1.1 fixes.
3. **Tool error details thin** — failed tool calls show "failed" only,
   not the why. Mitigation: errors at the run level (chat-final
   `state: error`) DO render `errorMessage`; only mid-run tool failures
   are thin. v1.1 fixes.

---

## How to ship v1.0 from here

1. Bump `package.json` version `1.0.0-beta.1` → `1.0.0`.
2. Tag `v1.0.0` in `BenchAGI/bench-cli`.
3. `npm publish` (requires `@benchagi` npm org access).
4. Update Homebrew formula at `BenchAGI/homebrew-tap/Formula/bench.rb`
   with the new tarball SHA and version (formula already supports both
   binaries).
5. Push the wiki entry change to the vault (already on disk; the
   wiki sync runs on next dream cycle).
6. Update the Aurelius daily Captain's Log with the launch line.
7. Optionally run a Codex Anvil smoke against the merged PR before
   tagging — apply the `anvil` label.

---

## Source layout cheat sheet

```
~/clawd/bench-cli/
├── bin/
│   ├── bench.mjs              # legacy V1 wrapper (unchanged)
│   └── benchagi.mjs           # new V2 entry point
├── src/v2/
│   ├── cli.ts                 # main dispatch
│   ├── chat-runner.ts         # transport ↔ router ↔ renderer ↔ liveness
│   ├── protocol/types.ts      # ConnectParams, EventFrame, taxonomy
│   ├── transport/
│   │   ├── transport.ts       # Transport interface (cloud v1.1 plug-in point)
│   │   └── local-gateway.ts   # LocalGatewayWsTransport with device-id signing
│   ├── auth/
│   │   ├── device-identity.ts # ed25519 sign of v3 auth payload
│   │   ├── gateway-token.ts   # token resolution (env > openclaw.json)
│   │   └── firebase-direct.ts # browser-to-loopback OAuth flow
│   ├── render/
│   │   ├── ansi.ts            # primitives
│   │   ├── stream.ts          # taxonomy renderers + extractChatText
│   │   ├── event-router.ts    # top-level event dispatch + dedupe
│   │   ├── liveness.ts        # two-clock indicator
│   │   └── approval.ts        # approval state machine
│   ├── probe/capability.ts    # backend classification heuristic
│   ├── repl/prompt.ts         # readline-based REPL
│   ├── state/
│   │   ├── state-file.ts      # ~/.config/benchagi/state.json
│   │   └── keychain.ts        # keytar + AES-GCM fallback
│   ├── commands/
│   │   ├── agents.ts
│   │   ├── auth.ts
│   │   ├── doctor.ts
│   │   └── version.ts
│   └── test/                  # 34 unit tests
├── docs/v2/
│   ├── PRE-SPEC-VERIFICATION.md
│   ├── SPEC.md
│   ├── ADR-001..006
│   ├── ANVIL-2-REVIEW.md
│   ├── ANVIL-3-REVIEW.md
│   └── ACTION-PLAN.md         # this file
├── package.json               # 1.0.0-beta.1, both bins, deps: ws keytar typebox
├── tsconfig.json              # ES2022, strict, dist/v2/
├── README.md                  # V1+V2 overview
└── scripts/homebrew/bench.rb  # formula stub for tap (both binaries)
```

Wiki entry: `~/.openclaw/wiki/main/_boards/nodes/master/benchagi.md`

## How to debug if something breaks

1. `benchagi doctor` — first stop. Tells you whether the gateway is
   reachable, the protocol matches, methods are present, and how many
   agents are configured.
2. `benchagi agents list` — confirms agent enumeration over the wire.
3. Tail the gateway: `openclaw logs --follow --json`.
4. Probe directly with `~/clawd/bench-cli/scripts/ws-probe.mjs` —
   sends a hand-crafted ConnectParams and prints the gateway's
   response. Useful to isolate "is it benchagi or the gateway."
5. Look at fixture event sequences in
   `src/v2/test/event-router.test.ts` — they show exactly what the
   router expects.

## Hammer-Anvil receipts

- Hammer (Claude Opus 4.7) — wrote spec docs + impl + this plan
- Anvil (Codex CLI 5.5) — ran ANVIL 2 (spec) and ANVIL 3 (impl)
- ANVIL 2 verdict: revise then ship; 2 P0s + 6 P1s, all addressed in
  the revised SPEC pre-code (`docs/v2/ANVIL-2-REVIEW.md`)
- ANVIL 3 verdict: hold; 1 P0 + 6 P1s. P0 + 2 P1s landed before tag;
  remaining 4 P1s captured here as deferred work
  (`docs/v2/ANVIL-3-REVIEW.md`)
