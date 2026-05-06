# PRE-SPEC-VERIFICATION — `benchagi` CLI V2

> Phase 0 artifact. Exists before `SPEC.md`. The HARD gate per
> `CLIBENCH.md` §70–95.
>
> Recon docs (`RECON-SUMMARY.md`, `INVENTORY.md`, `DIAGNOSTIC.md`) referenced
> in the brief **do not exist on disk**. Per the spec's own escape clause
> ("You are empowered to disagree with the recon. If implementation evidence
> contradicts it, surface the disagreement explicitly and proceed on the
> better evidence"), this document does the recon directly from code.

Date: 2026-05-05
Branch: `feat/v2-streaming-cli` in `BenchAGI/bench-cli`
Author: Claude Code (Hammer) — to be reviewed by Codex (Anvil) at ANVIL 2

---

## TL;DR

Three findings change the spec's planned architecture:

1. **Cloud identity migration is IN FLIGHT** (WIF Phases 1–4 shipped, Phase 5 pending). Spec must handle Firebase ID tokens today and isolate token acquisition behind an interface so the migration cutover is a one-file swap.

2. **There is no streaming chat endpoint on the cloud relay.** `https://benchagi.com/api/relay` exists and is operational, but it serves the customer-side relay daemon's *lifecycle and run-queue control plane*, not synchronous CLI chat. Direct WebSocket against the cloud relay (as the spec assumes) is **not implementable today**.

3. **OpenClaw Gateway IS native WebSocket** at `localhost:18789` and has the full event taxonomy already on the wire. This works for a streaming CLI today.

**Conclusion: V1 ships local OpenClaw Gateway WebSocket as the *primary* transport, with the cloud relay primary deferred to v1.1 once the cloud chat endpoint is built.** This is the only path that delivers a streaming-aware V2 CLI in this build cycle. The spec must mark this as an explicit, justified divergence from CLIBENCH.md's "cloud-primary, local-fallback" framing.

---

## Verification 1 — Cloud identity migration status

**Status: IN FLIGHT.** WIF (Workload Identity Federation) Phases 1–4 are shipped; Phase 5 (full cloud-identity cutover for end-user auth) has not yet started.

### Evidence

- **WIF Phases 1–3 shipped** — auto-memory entry
  `project_wif_migration_founder_fleet_2026-05-02.md`: "PR #776 merged
  (Phases 1-3); office mini relay on WIF; BENCH_CRED_MODE=wif required".
- **WIF Phase 4 (Firestore gateway) shipped 2026-05-03** — auto-memory entry
  `project_wif_shipped_2026-05-02.md`: "PR #782 + 3 follow-ups merged; manual
  deploy + flag flip + smoke green".
- **Firebase Admin auth still RAPT-blocked on the Mac mini as of 2026-05-04**
  (LCM session `4e896333-04df-4e97-b702-f054a7691e14`, seqs 64/72/78) — three
  consecutive control-plane daily check-ins skip writes because
  `gcloud auth print-access-token` returns reauth errors and there's no
  service-account key on disk. **This is operational dirt, not migration
  state**, but it confirms the migration is mid-cutover and ADC paths are
  not the right CLI auth target.
- **Web app currently authenticates with Firebase Web SDK 11.9.1** (recon
  highlight in `CLIBENCH.md:115`). User-facing auth is still Firebase Auth.
  The cloud-identity service has not yet replaced this surface.
- **Phase 5 referenced as future work** — the catch-all spec path "After
  Phase 5 identity migration complete | playerIdentities queries" appears in
  monorepo design docs (cited by recon agent in `docs/bolt-v2/`).

### Implication for the spec

- **Auth design target: Firebase ID tokens today.** That's what the web app
  produces and what `getAuthUser` in `apps/web/src/lib/firebase-admin.ts`
  verifies (`apps/web/src/app/api/relay/join/route.ts:18`).
- **Isolate token acquisition** behind an interface (`AuthBackend`) so the
  Phase-5 cutover is implemented as a swap of one module, not a CLI rewrite.
- **No service-account JSON keys on disk** is project policy
  (`apps/agents/shared/skills/deployment-orchestration/SKILL.md:22`). CLI
  must use user-issued Firebase ID tokens, never fall back to a static SA
  key.
- **Document the Phase-5 follow-up** as a known work item in
  `ACTION-PLAN.md`.

---

## Verification 2 — Cloud relay endpoint, auth contract, protocol shape

**Endpoint URL: `https://benchagi.com/api/relay` (confirmed in code).**

**The cloud relay does NOT expose a streaming chat surface.** It is a control
plane for the customer-side relay daemon; it cannot serve as the CLI's
synchronous chat transport without adding a new endpoint.

### Evidence — endpoint URL

- `apps/relay/relay-v3.mjs:28` — `let RELAY_API_BASE_URL = process.env.RELAY_API_BASE_URL || 'https://benchagi.com/api/relay';`
- `apps/relay/update-relay.sh:74` — `RELAY_API_BASE_URL="${RELAY_API_BASE_URL:-https://benchagi.com/api/relay}"`
- `apps/web/src/app/api/relay/[...path]/route.ts` — Next.js catchall route
  delegates to `handleRelayApiRoute` in `@/lib/relay-onboarding/server`.
- `apps/web/src/app/api/relay/join/route.ts` — single-purpose membership
  provisioning endpoint (`POST /api/relay/join`).
- `apps/web/src/app/api/relay/nav/route.ts` — relay navigation/hub.

### Evidence — what the relay actually serves

The catchall route handles the customer-side relay daemon's onboarding and
run-queue control:

- **Onboarding**: `relay-onboarding/server.ts` writes `RELAY_API_BASE_URL`
  into the daemon's local config (line 1405) and bootstraps the daemon's
  install-id, instance-id, agent-id, gateway URL, gateway token, session
  token, and session-expiry. The daemon caches secrets in macOS Keychain
  (`apps/relay/relay-v3.mjs:626`).
- **Lifecycle calls**: `apps/relay/relay-v3.mjs:573–593` — `postRelayLifecycle`
  POSTs JSON to `${RELAY_API_BASE_URL}${pathname}` with header
  `Authorization: Bearer ${sessionToken}`. The daemon owns the bearer token;
  the cloud relay verifies it server-side.
- **Runs**: `apps/relay/relay-v3.mjs:1251` — `POST /runs/${runId}/abort`.
  Runs are queued in Firestore (`hubThreads.../agentRuns`) and the daemon
  claims them, runs them locally against the OpenClaw Gateway, and reports
  results back to the cloud.

### Evidence — auth contract

- **Bearer token pattern** at `apps/relay/relay-v3.mjs:579`:
  `...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {})`.
- **Membership-protected routes use Firebase ID tokens** at
  `apps/web/src/app/api/relay/join/route.ts:18`: `const user = await
  getAuthUser(request);` — this resolves a Firebase Admin auth context.
- **Bench prohibits long-lived SA keys** per
  `apps/agents/shared/skills/deployment-orchestration/SKILL.md:22`:
  "The Bench project blocks raw Firebase service-account key creation. Use
  impersonated ADC for `benchagi-relay@benchagi-8ea90.iam.gserviceaccount.com`".

### Evidence — protocol envelope

- **HTTP/JSON only on the cloud relay.** No WebSocket. No SSE on the routes
  inspected. Lifecycle/runs use plain POST + JSON response.
- **OpenClaw Gateway IS WebSocket** at `localhost:18789`:
  `src/gateway/client.ts:2` — `import { WebSocket, type ClientOptions, type
  CertMeta } from "ws";`. Total file: 944 lines, full JSON-RPC envelope with
  device-auth handshake, capability negotiation, request/event frames.
- **Gateway protocol version** declared at
  `src/gateway/protocol/index.ts` (`PROTOCOL_VERSION` constant; gateway-chat.ts
  imports it at line 19).

### Evidence — full event taxonomy already on the wire

`/Users/coryshelton/clawd/openclaw/src/infra/agent-events.ts:5–17`:

```ts
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
```

This **exactly matches** the spec's required taxonomy
(`CLIBENCH.md:144`). The wire format is rich; the existing OpenClaw TUI
just doesn't render most of it. That's the gap V2 closes on the client side.

### Implication for the spec

The CLIBENCH spec's cloud-relay-primary architecture is **aspirational, not
implementable today.** Three options:

| Option | Description | Cost | When |
|---|---|---|---|
| A | Defer cloud transport entirely; ship local-Gateway-WS-primary V2 | Lowest | This build |
| B | Build a cloud chat endpoint (`POST /api/v1/agents/<id>/chat` + SSE) as part of V2 | Highest — adds web-app surface area + auth + streaming infra | Next session |
| C | Ship local-Gateway-WS-primary, scaffold an `AuthBackend`/`Transport` abstraction so v1.1 only adds a new transport adapter | Modest | This build + v1.1 follow-up |

**Recommended: Option C.** Honors the spec's intent (full streaming, no
batch silence), ships an actually-working V2 in this cycle, and leaves the
cloud chat endpoint as a clean adapter swap — not a rewrite.

If the user prefers Option B, this plan can be paused at SPEC time and the
work re-scoped. **Option A is rejected** because it forecloses the
cloud-primary path the spec calls for.

---

## What this means for the Phase 1 spec

These verifications drive the following spec decisions (ADR fodder):

1. **Transport selection** — Local OpenClaw Gateway WS is **primary** in V1.
   Cloud relay primary is deferred to v1.1 with a documented adapter
   contract. ADR justifies this divergence from CLIBENCH §43–48.

2. **Auth flow** — Firebase Direct, browser-handoff via localhost-listener
   (gcloud/firebase-cli pattern). Firebase ID tokens are the artifact;
   verification is server-side via the existing web-app pattern. The CLI
   never needs to talk to the cloud relay until v1.1 — but it still uses
   the same Firebase token surface so credential acquisition is forward-
   compatible.

3. **Token storage** — `keytar` for OS keychain (macOS Keychain, Linux
   Secret Service, Windows Credential Manager). Same library Bench's
   relay daemon uses.

4. **Local Gateway auth** — In V1, the CLI also accepts the local
   gateway's existing auth modes (token, password) via env vars
   `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`. Firebase Direct
   is for the *user* identity; gateway auth is for the *connection*. They
   don't conflict; gateway auth is a no-op for loopback in many configs.

5. **Existing bench-cli is the V2 base.** Same `@benchagi/cli` npm package,
   same `BenchAGI/homebrew-tap`, same `benchagi.com/install.sh`. New
   binary `benchagi` ships **alongside** legacy `bench` (legacy stays
   working, deprecation later). Bump 0.2.0 → 1.0.0.

6. **Verbose level** — CLI subscribes to local Gateway with
   `verboseLevel=full` (the existing `Gateway` strip behavior already
   honors this knob — `CLIBENCH.md:117`).

7. **Backend liveness** — Pi-backend agents stream rich events; CLI-batch
   backends (Claude CLI, Codex) emit final-only. The probe is on the
   `agent` model identifier returned by `agents.list`, not a separate RPC.

---

## Disagreements with the recon highlights in CLIBENCH.md

- **CLIBENCH.md §27 (recon highlight #1)**: "current OpenClaw TUI is connected
  to the Gateway and subscribes to tool events, but its handler suppresses
  tool visibility unless verbose is on, and strips outputs unless verbose is
  `full`." — **Confirmed.** No disagreement. `verboseLevel=full` is the right
  CLI subscription level.

- **CLIBENCH.md §28 (recon highlight #2)**: rich event taxonomy already exists
  on the wire. — **Confirmed exactly** in `src/infra/agent-events.ts:5–17`.

- **CLIBENCH.md §29 (recon highlight #3)**: Pi backends stream richly; Claude
  CLI / Codex backends batch. — **Cannot fully verify in this pass**; design
  the liveness probe as a runtime detection, not a static config map.

- **CLIBENCH.md §30 (recon highlight #4)**: Existing bench is shell-out, no
  WebSocket streaming. — **Confirmed** at
  `~/clawd/bench-cli/src/cli.mjs` and the package's stated roadmap line
  "First-class streaming via gateway WebSocket (replaces shelling out)" at
  `README.md:175`.

- **CLIBENCH.md §31 (recon highlight #5)**: "No working Firebase device-flow
  implementation exists. The Cowork JWT bridge exists but is **not** the
  chosen path." — **Confirmed.** No device-flow code in the monorepo.

- **CLIBENCH.md §43–48 (locked decision: cloud-relay primary)**:
  **DISAGREEMENT.** No cloud streaming chat endpoint exists today. The
  spec needs to formally re-scope this; `feat/v2-streaming-cli` ships
  local-Gateway-WS-primary or it doesn't ship.

---

## Open questions remaining for SPEC.md

These do not block Phase 1; they belong in the spec's "Open questions"
section.

1. **TUI framework** — pick from Ink, blessed, raw ANSI, or `pi-tui` (which
   OpenClaw uses). ADR required.
2. **Browser-handoff flavor** — localhost-listener vs. code-paste. ADR
   required.
3. **Wiki vault placement** — verify `~/.openclaw/wiki/main/_boards/` layout
   matches the recon citation before placing `BENCHAGI-WIKI.md`.
4. **Cloud chat endpoint design** — for v1.1; should it be SSE on
   `/api/v1/agents/<id>/chat` or a WebSocket on `wss://benchagi.com/relay/ws`?
   ADR deferred until v1.1.

---

## Verification 3 — Cloud-brain workstreams (added 2026-05-05 mid-session)

The user surfaced a 5-PR cloud-brain workstream landed/in-flight today.
Reviewed all five before any code:

- **[#850](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/850)** —
  Phase 0 ADR-0002, "Cloud Brain via Relay." Doc-only. Architectural
  framing: persona files off customer disks; cloud orchestrator
  dispatches LLM turns; relay carries directives between cloud and
  customer-local OpenClaw install.
- **[#872](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/872)** —
  Phase 1B W1, schema: adds `instances/{id}.tier`,
  `agentDeployments/{id}.runtime` (`local | remote-brain`), and
  `installBinding` discriminated union. Default behavior unchanged
  (additive fields).
- **[#874](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/874)** —
  Phase 1B W4, schema: `relayDirectives/{directiveId}` collection with
  `LlmTurnDirective | ToolDirective | ReauthDirective` discriminated
  union. Composite index `(status, installId, priority, createdAt)` for
  the relay claim path.
- **[#878](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/878)** —
  Phase 1B W2, orchestrator dispatch: `executeAgentRunViaCloudBrain`
  routes through cloud-brain when `runtime === 'remote-brain'`. **PR's
  own scope notes: "Without W3 + relay extension, this PR is
  functionally inert at runtime"** — directives written to Firestore
  would never get claimed.
- **[#870](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/870)** —
  Personal Bailey rollout pivot to cloud-brain. Reframes Bailey from
  per-user-Mac-install to cloud-routed via shared Slack app.

### Architectural impact on benchagi V2

**Net zero on V1.** Cloud-brain is **upstream of the local OpenClaw
Gateway**, not a separate transport benchagi consumes:

```
                         V1 (today)              V1.1 (some agents)
                         ──────────              ──────────────────
benchagi  ──[ws]──> local OpenClaw Gateway <── cloud-brain orchestrator
                          │                          │
                          ↓                          ↓
                  local LLM (Pi /              cloud LLM call,
                  claude-cli / codex)          tools delegated back
                                               via relayDirectives
```

- The CLI sees the **same** `chat`/`agent` events whether the LLM ran
  locally or cloud-side. The gateway abstracts the runtime location.
- Cloud-brain's directive model (`LlmTurnDirective` written to Firestore
  → polled by relay → forwarded to OpenClaw `/v1/llm_turn` (W3, not yet
  built)) is **async, batch-style**. This is the wrong shape for
  interactive CLI chat anyway, and reinforces ADR-004's local-WS-primary
  decision.
- The cloud-brain Phase 1B work uses **Hammer-Anvil discipline already**
  (multiple Codex passes per workstream). Benchagi V2's own H/A pattern
  in this session is consistent.

### What benchagi V2 inherits transparently

Once W3 + relay extension land, agents with `runtime: 'remote-brain'`
will route LLM turns cloud-side **without any change to benchagi**. The
local gateway emits `chat` deltas and `agent.tool` events the same way;
the only difference is that the LLM provider call happens in
`apps/web/src/lib/cloud-brain/dispatch.ts` instead of locally.

### What benchagi V2 may need (v1.1 follow-up, not V1)

A future "you are connected to a remote-brain agent" badge in the REPL
header, indicating that the user's prompts will be processed cloud-side
under the customer's billing profile. This is UX, not architecture.
Logged in `ACTION-PLAN.md` once Phase 2 ships.

### Citations

- `apps/web/src/lib/cloud-brain/dispatch.ts` (new in #878, +376) —
  `LlmTurnDirective` builder + Firestore writer + 1s/5min poll
- `apps/web/src/lib/cloud-brain/run.ts` (new in #878, +284) —
  `executeAgentRunViaCloudBrain` wrapper
- `apps/web/src/lib/relay/agent-run-server.ts` (modified in #878, +50) —
  branch on `shouldDispatchViaCloudBrain`
- `apps/web/functions/src/agent-runtime/directive-types.ts` (new in
  #874, +420) — `RelayDirective` discriminated union
- `docs/adr/0002-cloud-brain-via-relay.md` (new in #850, +216) —
  architectural ADR

---

## Gate exit

All three verifications complete:

1. Cloud identity migration — IN FLIGHT (WIF Phase 4 shipped, Phase 5
   pending).
2. Cloud relay endpoint — exists at `https://benchagi.com/api/relay`
   for control-plane only; no streaming chat surface today.
3. Cloud-brain workstream — directive-queue model upstream of the
   gateway; transparent to benchagi V1.

**Phase 1 — Specification — STARTS NOW.**
