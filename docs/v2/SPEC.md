# `benchagi` CLI V2 — Specification (revised post-ANVIL-2)

> Branch: `feat/v2-streaming-cli` in `BenchAGI/bench-cli`
> Phase: 1 of 3 (Spec → Implementation → Close)
> Reads: `PRE-SPEC-VERIFICATION.md` (sibling)
> Reviewed by: Codex (ANVIL 2) — see `ANVIL-2-REVIEW.md`
> **Revisions in this version**: addresses every P0 and P1 from
> `ANVIL-2-REVIEW.md`. Diff narrative at the bottom (§17).
>
> Locked decisions in `CLIBENCH.md` are inputs, not questions. Where this
> spec diverges from CLIBENCH (one place: §43–48, transport selection), the
> divergence is justified in PRE-SPEC-VERIFICATION.md and re-stated in
> ADR-004.

## 1. Mission

Ship a streaming-aware command-line interface to the Bench/OpenClaw agent
system that closes the visibility gap between the existing `bench`
shell-out wrapper and the quality bar set by Claude Code and Codex CLI.

`benchagi` is the **enhanced lineage of `bench`**:

- Same npm package (`@benchagi/cli`)
- Same Homebrew tap (`BenchAGI/homebrew-tap`)
- Same install URL (`https://benchagi.com/install.sh`)
- Same agent-discovery convention (`openclaw.json` / `agents.list`)
- New binary `benchagi` ships **alongside** legacy `bench` (both in the
  same npm package); legacy `bench` keeps working at v1 launch
- Major version bump: `0.2.0 → 1.0.0`

## 2. Binary, language, runtime

- **Binary**: `benchagi`. Bare command opens the chat REPL.
- **Legacy binary**: `bench` retained, unchanged in V1.
- **`bin` entries in `package.json`** (explicit per ANVIL §[P2] §10 fix):
  ```json
  "bin": {
    "bench":    "./bin/bench.mjs",        // legacy v0.2 wrapper, unchanged
    "benchagi": "./dist/v2/bin/benchagi.mjs"
  }
  ```
  Homebrew formula installs both binaries from the same package.
- **Language**: TypeScript, strict mode.
- **Runtime**: Node.js **>=20.10** (kept compatible with legacy `bench`'s
  current floor). ANVIL flagged the original >=22.12 bump as a
  bench-compatibility hazard. We can ship V2 on Node 20 — we use the `ws`
  package (no need for the Node 22 native `WebSocket`), `keytar`,
  `node:test`, ESM, `fetch` — all available in Node 20.10+. No Node 22
  features used. Revisit if a hard need surfaces.
- **Build**: `tsc` to ESM, no bundler. Output to `dist/v2/`. Source in
  `src/v2/`.
- **Production dependencies (audited, intentional)**:
  - `ws` — WebSocket client (matches OpenClaw)
  - `keytar` — OS keychain
  - `@sinclair/typebox` — share the OpenClaw protocol schemas without
    re-defining them
  - Nothing else for v1.

## 3. Command surface

```
benchagi                          → open chat REPL with last-used agent
benchagi <message>                → single-turn ask using last-used agent
benchagi --agent <name> ...       → use a specific agent for this invocation

# Optional in V1; only required for cloud-bound subcommands (none ship in V1)
benchagi auth login               → Firebase Direct browser-handoff
benchagi auth logout              → wipe token from keychain
benchagi auth status              → show signed-in identity + token validity

benchagi agents list              → list configured agents (from openclaw.json)
benchagi agents use <name>        → set default agent (persisted)

benchagi sessions list [--agent <name>]
benchagi sessions resume <key>    → resume a prior session

benchagi version                  → version + build SHA
benchagi doctor                   → diagnostics: gateway reachable, gateway auth ok, agent ok
```

**Bare-command behavior**: launch the REPL with the last-used agent (per
`~/.config/benchagi/state.json`). If no last-used agent, prompt-pick from
`agents.list`. **No Firebase auth requirement** for V1 local-only use.
Firebase Direct is opt-in (and only needed once cloud transport ships).

The legacy `bench` command surface (`ask`, `chat`, `feed`, `tail`,
`commitments`, `agents`, `sessions`, `tasks`, `status`, `setup`) **does not
move into `benchagi`** in V1. v1.1 task.

## 4. Authentication

### 4.1 Two distinct auth surfaces (revised post-ANVIL P1)

The CLI has two auth contexts. They are **independent**:

| Surface | Used for | V1 status |
|---|---|---|
| Local Gateway auth | `ws://127.0.0.1:18789` connection | **Required**, inherits OpenClaw's existing modes |
| Firebase Direct (user identity) | Cloud relay (v1.1) and any `cloud-*` subcommand | **Optional in V1**; not required for local chat |

V1 only ships local transport, so V1 only requires Gateway auth. Firebase
Direct is plumbed and tested but not blocking.

### 4.2 Local Gateway auth (V1 hard path)

OpenClaw's gateway accepts (in precedence order):

1. `OPENCLAW_GATEWAY_TOKEN` env var
2. `OPENCLAW_GATEWAY_PASSWORD` env var
3. `device.token` field on `connect` (device handshake)

The CLI passes whichever it finds via the `auth` field of `ConnectParams`
(see §5.2). For loopback configurations this is often a no-op — OpenClaw
allows unauth'd loopback in many setups.

### 4.3 Firebase Direct flow (browser → listener; pure-client, no server route) [P0 fix]

Replaces the broken §4.1/§4.2 from the original spec. **Single concrete
flow**: pure browser-to-listener with the page's JS POSTing tokens
*directly* to the CLI's loopback listener — the web server never sees the
ID/refresh token.

1. User runs `benchagi auth login`.
2. CLI starts an HTTP listener on `127.0.0.1` on a random port (8000–9999),
   binds loopback only.
3. CLI prints + opens
   `https://benchagi.com/auth/cli?port=<port>&state=<csrf>` in the user's
   default browser.
4. Web page (`apps/web/src/app/auth/cli/page.tsx` — built as part of this
   project, **client-only**) signs the user in via the existing Firebase
   web SDK, gets `idToken` + `refreshToken`, then JS does:
   ```js
   await fetch(`http://127.0.0.1:${port}/cli-callback?state=${csrf}`, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ idToken, refreshToken, uid, email, expiresAt }),
   });
   ```
   No Next route, no server-held tokens, no server-to-localhost POST.
5. CLI listener verifies CSRF state (constant-time), persists tokens via
   keytar, prints `Signed in as <email>`, exits 0.
6. CSRF mismatch / 90s timeout / browser-closed → exit non-zero,
   no keychain write.

**CORS specifics on the loopback listener** (the only server-side concern):

- Bind: `127.0.0.1` only.
- Path: `/cli-callback` only; everything else → 404.
- `OPTIONS` from `Origin: https://benchagi.com` → 204 with
  `Access-Control-Allow-Origin: https://benchagi.com`,
  `Access-Control-Allow-Methods: POST`,
  `Access-Control-Allow-Headers: Content-Type`.
- All other origins → 403.

**Cross-machine fallback** (deferred): when the CLI is on a different
machine than the user's browser, browser-to-loopback fails. ADR-002
documents this as a v1.1 follow-up (`--device-flow` opt-in with PKCE
code-paste). V1 surfaces a clear "browser cannot reach <host>:<port>"
message after timeout and points the user to the v1.1 follow-up.

### 4.4 Token lifecycle

- **Storage**: ADR-003 — `keytar` with service `benchagi-cli`, account
  `firebase`, value is JSON of `{ idToken, refreshToken, uid, email,
  expiresAt }`.
- **Refresh**: when `expiresAt - now < 5 min`, hit
  `https://securetoken.googleapis.com/v1/token?key=<api_key>` with
  `grant_type=refresh_token`. Rewrite the keychain entry on success.
- **Refresh failure modes**:
  - Network failure → retry 3× exponential, then surface and pause
  - Refresh token revoked → wipe keychain, prompt re-login on next
    cloud-bound action (V1 has none, so this is a v1.1 path)
- **Identity migration mid-session** (Verification 1 finding, P5):
  `AuthBackend` interface has one implementation in V1
  (`FirebaseAuthBackend`). When Phase 5 cutover lands, swap a single
  module. No CLI rewrite required.

## 5. Streaming transport

### 5.1 Selection (V1)

**Local OpenClaw Gateway WebSocket is primary in V1.** Cloud is deferred
(ADR-004).

```
benchagi → ws://127.0.0.1:18789  ← OpenClaw Gateway (only V1 transport)
```

If the local gateway is unreachable, the CLI emits a doctor-style error
and exits non-zero. No silent fallback in V1.

### 5.2 Connect frame [P0 fix]

The CLI sends an actual OpenClaw `ConnectParams` (verified shape in
`openclaw/src/gateway/protocol/schema/frames.ts:20–69`):

```ts
const params: ConnectParams = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id:       "cli",                            // existing accepted id
    mode:     "ui",                             // existing accepted mode
    version:  CLI_VERSION,
    platform: process.platform,
    displayName: "benchagi",
  },
  caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],      // resolves to "tool-events"
  auth: { token, password },                    // omit if neither set
};
```

`additionalProperties: false` on the schema rejects any field the spec
invents. The cap value is **`"tool-events"`** (lowercase, hyphenated) per
`openclaw/src/gateway/protocol/client-info.ts:48–49`. The strings
`"benchagi-cli"`, `"TOOL_EVENTS"`, and a top-level `verboseLevel` from the
original spec **do not work on the wire** and are removed.

### 5.3 verboseLevel = full mechanism [P0 fix]

`verboseLevel` is **session/run scoped, not connect-frame scoped**. The CLI
asserts it via the existing `sessions.patch` RPC after `connect`:

```ts
await client.request("sessions.patch", {
  key: sessionKey,
  verboseLevel: "full",
});
```

If the session doesn't exist yet (first message in a new session), the CLI
creates it with `sessions.create` (or whichever the gateway exposes —
verified at code time during impl; see SPEC.md §13 test list) including
`verboseLevel: "full"` in the create params.

**Test that proves it works**: a fixture run with a tool result that
exceeds default-strip thresholds; `tool.result` survives end-to-end into
the renderer.

### 5.4 HelloOk consumption [NEW post-ANVIL P1]

After `connect`, the gateway returns `hello-ok` with:

- `protocol` — agreed protocol version
- `features.methods` / `features.events` — what the gateway supports
- `policy.maxPayload` (bytes), `policy.maxBufferedBytes`,
  `policy.tickIntervalMs`

The CLI:

- Stores all three policy values; uses `tickIntervalMs` to set the
  liveness "no-tick threshold" (default 3× the interval).
- Stores `maxPayload`; warns when a single-frame `tool.result` would
  exceed it (we may receive the truncation upstream-side).
- Validates required methods — `chat.send`, `chat.history`,
  `sessions.list`, `sessions.patch`, plus approval RPCs (§6.5) — and
  refuses to start with a clear error if any are missing.
- Validates `caps` were honored: if the server does not return
  `tool-events` in the agreed caps (gateway feature), surface "tool
  events not available — install/upgrade openclaw".

### 5.5 Run identity, idempotency, recovery [P1 fix]

Per ANVIL [P1] reconnect/resume:

- The CLI generates **one** `runId` per outgoing `chat.send` before
  emitting it. Same id on retries.
- The CLI **never resends** a `chat.send` blindly after disconnect.
- On reconnect:
  1. Re-`connect` + re-`sessions.patch verboseLevel=full`.
  2. Call `chat.history` for the active session, with a `since-seq`
     cursor saved from the last received `EventFrame.seq`.
  3. Replay any history not already seen by the renderer (deduped on
     `(runId, seq)` for events, `(runId, kind)` for one-shot final-text
     replays).
  4. If `chat.history` shows the run already completed during the
     disconnect, render the missed final text and clear the liveness
     line.
  5. If the run is still in flight, reattach to the run via
     `chat.send`'s reconciliation pattern OR (if available)
     `agent.wait(runId)` — verified at impl time.
- On `EventFrame.seq` gap (received `seq=N+2` after `seq=N`), surface
  "(events from <agent> may be incomplete; reconciling…)" and call
  `chat.history` with a tight window.

### 5.6 Reconnect cadence

- Idle disconnect: silent reconnect with last `sessionKey`.
- Network drop mid-message: render a "Reconnecting… (attempt N, elapsed
  Xs)" line, backoff `1s, 2s, 5s, 10s, 30s` capped at 30s.
- Server-side close on auth expiry: refresh ID token (cloud only;
  irrelevant in V1), reconnect with fresh subscription.
- Ctrl-C during reconnect: aborts immediately.

## 6. Event handling — top-level router [P1 fix]

The CLI must handle `EventFrame.event` at the top level **before**
applying taxonomy-specific renderer rules. Top-level event names observed
in OpenClaw (`grep -rn "event:" src/gateway/server-shared* src/infra/*`):

| `event` value | Meaning | Router action |
|---|---|---|
| `chat` | Assistant text delta or final | Renderer §6.4 — assistant stream |
| `chat.side_result` | Side result associated with a run | Renderer §6.7 — side block |
| `agent` | Wrapped `AgentEventPayload` (the taxonomy) | Unwrap, dispatch §6.3 |
| `session.tool` | Late-join mirror of run-scoped tool events | Dedupe by `(runId, seq, stream, toolCallId\|itemId)`; render only if not already seen |
| `sessions.changed` | Session list changed | Update local session cache |
| `tick` | Server heartbeat (every `policy.tickIntervalMs`) | Update last-tick clock; never render |
| `shutdown` | Server is going away | Render "Gateway shutting down (<reason>)"; reconnect after `restartExpectedMs` |
| `exec.approval.resolved` | Exec approval decision posted | Update pending-approval state machine §6.5 |
| `plugin.approval.resolved` | Plugin approval decision posted | Same as above |
| anything else | Unknown event | Log to `~/.config/benchagi/debug.log`, never crash |

**Dedupe key for late-join `session.tool` mirroring**:
`hash(runId + ":" + seq + ":" + stream + ":" + (toolCallId ?? itemId))`.
Cache last 1024 keys per run; older runs evict.

### 6.3 AgentEvent stream taxonomy renderer

Once unwrapped from `event: "agent"`, dispatch by `payload.stream` (the
taxonomy from `agent-events.ts:5–17`):

| Stream | Rendering rule |
|---|---|
| `lifecycle` | One-liner: "Run started • <runId>" / "Run ended" |
| `assistant` | Streaming text (delta on partial, final on end) |
| `thinking` | Greyed italics; `--no-thinking` hides; deltas live |
| `tool` | Bordered block; default collapsed; `[r]` to expand |
| `item` | Per-item progress (kind, title, status); inline status bar |
| `command_output` | Yellow code-fence block; truncated to 32 lines or 4 KB |
| `patch` | File path + `+N/-M` + hunks; `<path>:<line>` headers |
| `plan` | Bullet list with title; updates replace prior plan |
| `approval` | §6.5 approval state machine handles this — no inline rendering |
| `compaction` | One-liner: "Context compacted • freed N tokens" |
| `error` | Red text with stack if present; never truncated |

### 6.4 Assistant `chat` event

Batch backends (Claude CLI, Codex) deliver final text as
`event: "chat"`, **not** as `agent.assistant`. The renderer accepts both:

- `chat` → render in the assistant block; on `phase: "final"`, mark
  block complete.
- `agent` with `payload.stream=assistant` → same target block, deltas
  appended.

If both arrive (shouldn't, but possible), dedupe on `runId` — first
target block wins; second is logged.

### 6.5 Approval state machine [P1 fix]

State table:

```
NONE                      (no pending approval)
  ↓ event: agent payload.stream=approval phase=requested → PENDING(approvalId)

PENDING(approvalId)
  ↓ user presses [A]    → call exec.approval.resolve  / plugin.approval.resolve
                          { id: approvalId, decision: "approve" }
                        → wait for matching exec.approval.resolved event → NONE
  ↓ user presses [D]    → resolve { decision: "deny" } → NONE
  ↓ Ctrl-C              → resolve { decision: "deny" } → NONE  [default-deny]
  ↓ event: exec.approval.resolved (peer resolved) → NONE
  ↓ timeout (gateway-driven) → render "approval expired" → NONE
  ↓ disconnect          → keep PENDING in memory; on reconnect, replay
                          approval requested events from chat.history; if
                          approval.resolved already arrived during the gap,
                          clear PENDING; else re-render the prompt
```

RPC method names verified in
`openclaw/src/infra/approval-gateway-resolver.ts:56`:
`exec.approval.resolve` for exec approvals (kind `exec`),
`plugin.approval.resolve` for plugins (kind `plugin`). Decision values
verified in `exec-approval-channel-runtime.test.ts:196`: `"approve"` /
`"deny"`.

### 6.6 Tool-block rendering

Match Claude Code's visibility bar:

```
┌─ ToolName ────────────────────── 1.2s
│ args: {"file": "foo.ts", "limit": 50}
│ result: <50 lines, sha256=f8a3…>
└─ done · press [r] to expand
```

Default size cap on tool results: **16 lines or 4 KB**, whichever first.
Expand: `[r]` in REPL, `--full` flag for non-interactive.

### 6.7 Large-output handling [P1 fix]

The original spec said "tool result > 10 MB → save to temp file." That's
post-receive. The reality is the gateway has `policy.maxPayload` (default
~25 MB observed) and `policy.maxBufferedBytes` (default ~50 MB).

V1 behavior:

- Read `policy.maxPayload` from `hello-ok` and surface in `benchagi
  doctor` output.
- If a tool result would exceed `policy.maxPayload` upstream, the gateway
  truncates / errors before the CLI sees it. The CLI cannot save what it
  never received; we render whatever metadata the gateway provides about
  the truncation.
- For tool results that arrive but are large in renderer terms (>10 MB
  client-side), save to `~/.cache/benchagi/results/<runId>-<itemId>` and
  render `path + size`.
- Backpressure: the CLI reads the WebSocket as fast as the renderer can.
  If the renderer falls behind, the CLI's read buffer pressure
  approaches `policy.maxBufferedBytes`. We:
  1. Render less per frame (drop deltas, only show final).
  2. Surface "rendering paused (slow terminal)" to the user.
  3. Resume normal rendering when caught up.

V1 does **not** attempt to expand the gateway's `maxPayload`. That's
upstream OpenClaw work — out of scope per CLIBENCH §55.

### 6.8 Many-simultaneous-agents handling

V1 launches one connection per CLI process, one agent per session. The
CLI is single-agent at the user surface. Multi-agent multiplexing is a
v1.1 task. Until then, each `agent` event we receive applies to the
single active agent; if the gateway sends an event for a different
agent (e.g., a session.tool late-join from a separate agent's run), the
dedupe key in §6 includes the `sessionKey` from the event payload so
cross-agent collisions are impossible.

## 7. Liveness — two-clock model [P1 fix]

Two clocks, both surfaced:

- **`runQuietMs`** = ms since last non-tick `agent`/`chat`/etc. event for
  the active run. Resets to 0 on every non-tick frame.
- **`gatewayTickMs`** = ms since last `tick` event from the gateway.
  Resets to 0 on every `tick`.

### 7.1 TTY indicator

After `runQuietMs > LIVENESS_THRESHOLD` (default: max(5000, 3 ×
`policy.tickIntervalMs`)) the CLI shows a one-line indicator:

```
⠋ <agent> · run quiet 7s · gateway tick 1s · pid 12345 · Ctrl-C abort
```

- Spinner: 10-frame Braille, 80ms.
- Updates every 1s.
- `gateway tick Xs` proves the *connection* is alive even when the run
  is silent.
- `pid` lets the user `kill -INFO <pid>` for diagnostics.
- At `runQuietMs > 120s` AND `gatewayTickMs < 5s`: still healthy
  connection but stuck run — append red "(may be stuck — Ctrl-C
  abort)".
- At `gatewayTickMs > 3 × tickIntervalMs`: connection issue — render
  "(connection unhealthy — reconnecting)" and trigger reconnect.

### 7.2 Non-TTY indicator [P1 fix]

When `process.stdout.isTTY === false` (CI logs, redirected output), the
CLI prints one status line every **30 seconds**:

```
[benchagi liveness] runQuiet=37s gatewayTick=2s pid=12345
```

Suppressing the indicator entirely (the original spec) made non-TTY
captures look frozen. Now: regular cadence, one line at a time.

### 7.3 Backend classification → indicator selection [P2 fix]

ADR-005 covers the heuristic. Revisions:

- **Heuristic is a hint, not authoritative.** Every run gets the
  two-clock liveness display once `runQuietMs > LIVENESS_THRESHOLD`,
  regardless of static classification.
- **Classification only changes the indicator's *first-show*
  timing**: classified-batch backends show the indicator at
  `LIVENESS_THRESHOLD = 0` (immediately after `lifecycle:start`),
  classified-stream backends wait the threshold.
- **Override**: `--liveness=auto|always|stream|batch|off` — `always`
  forces immediate, `off` suppresses. Persisted per-agent via
  `--remember`.

## 8. Agent selection + state

(Unchanged from prior spec; included for completeness.)

- **Discovery**: `agents.list` over the gateway. Static fallback: read
  `openclaw.json`.
- **Short-name resolution**: same rule as legacy bench — match the
  trailing segment of the agent id.
- **Default agent**: persisted in `~/.config/benchagi/state.json`.
- **Project override**: `.benchagi/agent` in the project working
  directory.

State file shape:

```jsonc
{
  "version": 1,
  "defaultAgent": "kestrel-aurelius",
  "recentAgents": ["kestrel-aurelius", "cole"],
  "perAgent": {
    "cole": { "liveness": "batch" }
  }
}
```

## 9. Install path

**Primary install path: npm global** (already wired). Same package, version
bump:

```bash
npm install -g @benchagi/cli@1.0.0
# or:
curl -fsSL https://benchagi.com/install.sh | sh
```

**Homebrew tap** (already wired at `BenchAGI/homebrew-tap`):

```bash
brew install BenchAGI/tap/bench
```

Formula update (Phase 2 step 10): bump `version`, refresh `sha256`,
**install both `bench` and `benchagi` symlinks** (P2 fix from ANVIL §10).

macOS works at v1 launch. Linux works the same npm path; tested on
Ubuntu 22.04 + Debian 12. Windows is not in scope for v1.

## 10. Bench compatibility — what's inherited, what's rejected [revised post-ANVIL P2]

### Inherited

- npm package name: `@benchagi/cli`
- Homebrew tap: `BenchAGI/homebrew-tap`
- Install URL: `https://benchagi.com/install.sh`
- Agent discovery via `openclaw.json` / `agents.list`
- Short-name resolution rule
- "Readable error messages" principle
- "No git operations" principle
- README format (commands table, examples, configuration)
- **Node engines floor: `>=20.10`** (kept; original spec's >=22.12 bump
  caused unnecessary breakage)

### Rejected (V2 path only — V1 path keeps these)

- **Shell-out as the wire.** `benchagi` speaks WebSocket natively.
- **OpenClaw banner-noise filtering.** Only relevant to legacy `bench`
  (which shells out and parses `--json` stdout). V2 doesn't shell out;
  no banner. **This filter applies to legacy `bench` only.**
- **Single-default-agent limitation.** V2 keeps a per-agent recent list
  and lets you switch mid-session.
- **No streaming.** V2 renders the full event taxonomy live.
- **Zero-runtime-dependency principle.** V2 needs `ws`, `keytar`,
  `@sinclair/typebox`. Defended in §2.

## 11. Out of scope (explicit list)

- Modifying OpenClaw upstream to make CLI-batch backends stream.
- Bench deprecation campaign.
- Redaction policy for tool args/results.
- Multi-account support.
- Cloud relay primary transport (ADR-004; v1.1).
- Windows.
- Migrating legacy `bench` verbs to `benchagi`.
- Cross-machine `--device-flow` browser handoff.
- Multi-agent in one process.

## 12. Failure modes

| Failure | V1 handling |
|---|---|
| Gateway not running | Doctor-style error + "run `openclaw doctor`". Exit 2 |
| Gateway protocol mismatch | Hard exit with version comparison. Exit 6 |
| Required gateway method missing (`features.methods` check) | Doctor-style error pointing at openclaw upgrade. Exit 6 |
| `tool-events` cap not granted by server | Render "tool events unavailable; tool details limited" warning, continue |
| Gateway auth wrong (token/password) | Clear error + how to set env vars. Exit 7 |
| Auth needed (cloud-bound subcommand in V1.1) | Prompt `benchagi auth login`. Exit 3 (V1: never reached) |
| Browser closed mid-login | 90s timeout, no keychain write |
| Refresh token revoked | Wipe keychain, prompt re-login |
| Agent doesn't exist | Show available agents from `agents.list`. Exit 5 |
| Session-resume key invalid | Fall back to new session, warn |
| Network drop mid-stream | §5.5 reconnect + §5.6 cadence |
| Tool result exceeds gateway maxPayload | Gateway-side error surfaced; render whatever metadata is delivered |
| Tool result large client-side (>10 MB) | Save to `~/.cache/benchagi/results/`, render path + size |
| Approval timeout (gateway-driven) | Render "approval expired" |
| Identity migration completes mid-session | `AuthBackend` swap at module boundary; existing local-only V1 unaffected |

## 13. Tests (V1 minimum)

| Test | Surface |
|---|---|
| **Auth: localhost-listener happy path** | `auth login` opens listener, accepts callback from `https://benchagi.com` origin only, writes keychain |
| Auth: CSRF mismatch rejected | Bad state in callback → 400, no keychain write |
| Auth: timeout | 90s no callback → exit, no keychain write |
| Auth: refresh-token revoked | Refresh returns 401 → wipe keychain, exit 4 |
| **Connect: ConnectParams accepted by real gateway** | Spin up local gateway, connect, assert `hello-ok` payload shape |
| Connect: protocol-version mismatch | Hard exit 6 with message |
| Connect: missing required method | Hard exit 6 with method name |
| **verboseLevel=full lands in session** | `sessions.patch verboseLevel=full`, then run a tool with output > strip threshold; assert `tool.result` arrives non-stripped |
| **Event router: every top-level event** | Fixture with `chat`, `chat.side_result`, `agent`, `session.tool`, `sessions.changed`, `tick`, `shutdown`, `exec.approval.resolved`, `plugin.approval.resolved`; assert each routed |
| Event router: dedupe `session.tool` mirror | Fire twice with same key, assert one render |
| Event router: seq gap warning | Skip seq, assert "(events may be incomplete)" line |
| **Renderer: every taxonomy stream** | Fixture stream → stable output snapshot |
| Renderer: tool result truncation + expand | 1000-line result renders at cap, expand restores full |
| **Reconnect: in-flight run recovery via chat.history** | Disconnect mid-stream, reconnect, assert no duplicate output, no missed final |
| Reconnect: network drop backoff sequence | 1s, 2s, 5s, 10s, 30s |
| **Approval: approve + deny + Ctrl-C-default-deny** | Three test cases against fixture stream |
| Approval: resolved by peer mid-pending | PENDING → NONE without local input |
| Approval: reconnect with pending approval | Replay, re-prompt |
| **Liveness: two-clock model** | `runQuietMs` and `gatewayTickMs` independent; indicator content correct |
| Liveness: non-TTY 30s cadence | One status line every 30s |
| Probe: pi/* → stream, claude-cli/* → batch, unknown → hint=stream | Static heuristic test |
| **Probe: classification overridden by runtime** | Classified stream, no events for 5s, indicator appears anyway |
| REPL: Ctrl-C interrupt during stream | Stream aborts, prompt restored |
| REPL: multi-line input | "\\" continuation works |
| REPL: history | Up-arrow recalls prior message |

Bold tests are the ones added/strengthened post-ANVIL.

The legacy `bench` test suite (`test/smoke.mjs`) keeps running unchanged.

## 14. Wiki entry placement

Per CLIBENCH §185 and the user's vault layout:
`~/.openclaw/wiki/main/_boards/nodes/master/benchagi.md`.

Phase 2 step 9 verifies layout on disk before placement; if the layout
differs from CLIBENCH's citation, the entry follows the discovered
layout. **Wiki entry ships after Phase 2 testing per the user's
2026-05-05 directive** ("make sure we get a wiki entry once this is
tested").

## 15. ADR map

- ADR-001 — TUI framework: raw ANSI. Unchanged post-ANVIL.
- ADR-002 — Browser handoff: localhost-listener. Updated in §4.3 to fix
  the broken server-route loop.
- ADR-003 — Token storage: keytar with documented Linux fallback.
  Unchanged post-ANVIL.
- ADR-004 — Transport selection: local-Gateway-WS-primary in V1, cloud
  via adapter in v1.1. Unchanged post-ANVIL (verified correct).
- ADR-005 — Capability probe: heuristic + runtime-primary. Updated in
  §7.3 to make runtime observation primary.

## 16. Outstanding questions for the user (defaults baked in)

1. **Engines** — kept at `>=20.10` (post-ANVIL revision). If user
   prefers the >=22.12 bump for forward-compat, override.
2. **Cloud chat endpoint design** — defer to v1.1.
3. **`benchagi` vs. `bench` binary names** — both ship; `benchagi` is the
   new streaming binary.
4. **Wiki entry post-test placement** — placed after Phase 2.8 tests
   green per user directive.

## 18. Cloud-brain transparency (added 2026-05-05 mid-session)

The user surfaced 5 in-flight PRs implementing cloud-brain via relay
(see PRE-SPEC-VERIFICATION.md "Verification 3"). benchagi V2 is
**transparent** to the cloud-brain runtime split:

- Agents with `runtime: 'local'` → LLM runs locally; CLI behavior unchanged
- Agents with `runtime: 'remote-brain'` → LLM runs cloud-side; CLI sees
  the same `chat`/`agent` events because the local gateway abstracts
  the LLM provider location.

V1 makes no UX distinction between local and remote-brain agents.
V1.1 may add a badge in the REPL header indicating remote-brain so
users understand their prompts go cloud-side under their billing
profile. ADR-006 captures this architectural relationship.

This is a one-way constraint: the cloud-brain workstream is **the
upstream owner of LLM-runtime location**; benchagi V2 must not invent a
parallel cloud-chat adapter that bypasses the gateway abstraction.

## 17. Diff narrative (what changed post-ANVIL-2)

| Change | ANVIL finding | New section/spec |
|---|---|---|
| Connect frame replaced with real `ConnectParams` | [P0] | §5.2 |
| `verboseLevel=full` moved to `sessions.patch` post-connect | [P0] | §5.3 |
| Auth flow: pure browser-to-listener, no Next route | [P0] | §4.3 |
| Firebase auth no longer required for V1 | [P1] | §3, §4.1, §4.2 |
| HelloOk policy values consumed (maxPayload, tickInterval) | [P1] | §5.4 |
| Run identity, idempotency, history-replay reconnect | [P1] | §5.5 |
| Top-level event router with dedup for session.tool | [P1] | §6 |
| Approval state machine with explicit RPC names | [P1] | §6.5 |
| Liveness two-clock model + non-TTY 30s cadence | [P1] | §7.1, §7.2 |
| Large-output handling clarified (gateway-side limits) | [P1] | §6.7 |
| Probe: heuristic is hint; runtime drives liveness | [P2] | §7.3 |
| Bench-compat: Node floor stays >=20.10, banner filter is legacy-only, both bins explicit | [P2] | §2, §10 |

This addresses every P0 and P1 finding from `ANVIL-2-REVIEW.md`.
P2/P3 findings are addressed where ↑; the remainder are accepted as
implementation-time concerns.
