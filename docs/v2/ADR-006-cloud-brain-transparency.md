# ADR-006 — Cloud-brain transparency for benchagi V2

**Status**: Accepted
**Date**: 2026-05-05 (added mid-session after user surfaced cloud-brain PRs)
**Decision-maker**: Hammer (Claude Code) — informed by user pointer to PRs

## Context

Five PRs landed/in-flight on 2026-05-05–06 implementing "cloud brain via
relay" per ADR-0002 in the BenchAGI mono repo
(`docs/adr/0002-cloud-brain-via-relay.md`):

- [#850](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/850) — Phase 0 ADR-0002 (doc-only)
- [#872](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/872) — W1 schema (`tier`, `runtime`, `installBinding`)
- [#874](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/874) — W4 schema (`relayDirectives` discriminated union)
- [#878](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/878) — W2 orchestrator dispatch (functionally inert until W3 + relay extension)
- [#870](https://github.com/BenchAGI/BenchAGI_Mono_Repo/pull/870) — Bailey persona pivot to cloud-brain

The cloud-brain architecture moves LLM-runtime decisions cloud-side for
agents marked `runtime: 'remote-brain'`. Persona files stay off customer
disks. Customer's local OpenClaw install becomes a tool-execution
runtime that the cloud-brain orchestrator dispatches to via Firestore
`relayDirectives`.

## The architectural question

Should benchagi V2 be aware of the cloud-brain runtime split? Should it
have a separate transport adapter for `runtime: 'remote-brain'` agents?

## Decision

**No.** benchagi V2 sits **below** the local OpenClaw Gateway abstraction.
Cloud-brain sits **above** it (orchestrator → relay → local OpenClaw
install → LLM provider). The gateway emits the same `chat`/`agent` events
to subscribed clients (TUI, benchagi CLI) regardless of where the LLM
turn was actually computed.

### Concretely

- benchagi V2 connects to `ws://127.0.0.1:18789` and subscribes with
  `caps: ["tool-events"]` and `verboseLevel: "full"` (per ADR-004 +
  SPEC §5.2–§5.3).
- For an agent with `runtime: 'local'`, the gateway's local Pi /
  claude-cli / codex backends compute the LLM turn and stream events
  back. benchagi sees `chat`, `agent.assistant`, etc.
- For an agent with `runtime: 'remote-brain'` (after W3 + relay
  extension land), the gateway delegates the LLM turn to the cloud-brain
  orchestrator via the new openclaw `/v1/llm_turn` endpoint (W3) plus
  the relay claim path. The orchestrator calls the LLM provider
  cloud-side, then posts the assistant text and tool calls back as the
  same `chat`/`agent` events. benchagi sees an identical event stream.

### What benchagi V2 must NOT do

- Invent a parallel "cloud-brain transport" that talks directly to
  `/api/relayDirectives` or to the cloud orchestrator. That bypasses
  the gateway abstraction and duplicates routing logic that lives
  cloud-side.
- Pass the user's Firebase ID token to the local gateway. Identity
  for cloud-brain billing is attached at the orchestrator boundary by
  the existing web/Slack ingress paths (see PR #878's
  `executeAgentRunViaCloudBrain`); the local gateway is not the right
  place to assert user identity for cloud-brain runs.
- Block the user with a "set up cloud-brain" message when an agent has
  `runtime: 'remote-brain'`. The CLI doesn't care.

### What benchagi V2 may do (v1.1)

- Render a small badge in the REPL header indicating "remote-brain"
  when the active agent's deployment has that runtime, so the user
  understands the LLM call is cloud-side under their billing.
- Surface a friendly error when the cloud-brain dispatch path fails
  (the gateway will surface this; benchagi just renders it).
- In `benchagi doctor`, report the active deployment's runtime and
  install binding alongside the existing gateway/auth checks.

## Consequences

- benchagi V2's V1 ships against the **current** gateway behavior
  unchanged. No cloud-brain awareness needed.
- Once cloud-brain ships end-to-end (W3 + relay extension), benchagi
  V2 inherits remote-brain support **for free** — same gateway,
  same events, same renderer.
- The `Transport` adapter abstraction from ADR-004 stays small.
  Cloud-brain doesn't need its own adapter; it lives upstream.

## Why this was easy to get wrong

The original spec named "Bench cloud relay" as the primary transport
(CLIBENCH §43–48). Combined with the cloud-brain PRs landing
mid-session, it's tempting to assume the cloud-brain orchestrator IS
the cloud relay benchagi should target. But:

1. The cloud-brain `relayDirectives` queue is async, batch-style. The
   CLI needs interactive streaming. Wrong shape.
2. The local gateway already emits the streaming events benchagi needs.
   The cloud-brain doesn't replace this; it augments the LLM-turn
   computation behind the gateway.
3. The customer-side relay daemon (`apps/relay/relay-v3.mjs`) is the
   bridge between Firestore directive queue and local OpenClaw — but
   that's between cloud-brain and gateway, not between CLI and
   gateway.

This ADR exists to make the relationship explicit so a future
contributor doesn't try to add a `CloudBrainDirectiveTransport` to
benchagi.

## Revisit triggers

- Cloud-brain ships a synchronous streaming-chat surface (not the
  current async directive queue) — would warrant a benchagi adapter.
- Customer-side relay daemon goes away (replaced by direct cloud-side
  WebSocket to local install) — adapter shape changes.
- benchagi grows non-OpenClaw backends (e.g., direct Anthropic chat
  for users without OpenClaw installed) — would need its own
  transport, not a cloud-brain adapter.

## Cross-references

- BenchAGI mono repo: `docs/adr/0002-cloud-brain-via-relay.md`
- PR series: #850, #872, #874, #878, #870 (above)
- This spec: SPEC.md §18, PRE-SPEC-VERIFICATION.md "Verification 3"
- ADR-004 (transport selection) — local-WS-primary remains the V1
  choice; this ADR explains why cloud-brain doesn't change that.
