# ADR-005 — Backend capability probe (streaming vs. batch)

**Status**: Accepted
**Date**: 2026-05-05
**Decision-maker**: Hammer (Claude Code) — to be reviewed by Anvil (Codex)

## Context

OpenClaw agents run on different backends. Per CLIBENCH §29 (recon
highlight), Pi-engine backends emit rich streaming events (the full
taxonomy at `agent-events.ts:5–17`); Claude CLI and OpenAI Codex
backends batch the assistant text and emit only a final event.

The CLI must distinguish these so it can:

1. Render the full taxonomy when it's available.
2. Show a liveness indicator (last-event-age countdown) when it's not,
   so silence is visible silence and never indistinguishable from a
   crashed process.

## Options

### A. Static heuristic on `model.primary` from `agents.list`

OpenClaw's `agents.list` returns each agent's `model.primary` as a
prefix-tagged string:

| Prefix | Backend | Streaming? |
|---|---|---|
| `pi/` | OpenClaw Pi engine | yes (rich) |
| `claude-cli/` | Claude Code shell-out | no (batch) |
| `openai-codex/` | Codex shell-out | no (batch) |
| `anthropic-direct/` | Anthropic Messages API direct | yes |
| `openai-direct/` | OpenAI Responses API direct | yes |
| anything else | unknown | assume streaming |

Verified in `mcp__openclaw__openclaw_agent_list` output during
recon — every agent's `model.primary` starts with one of those prefixes.

### B. Runtime probe — send a no-op message, count events in 5s, classify

- Sends a tiny test prompt at session start.
- Counts non-lifecycle events in the first 5s.
- 0 events → batch; ≥1 → streaming.

### C. Server-declared capability — gateway exposes
`agents.capabilities` with streaming flag

- The cleanest path.
- Doesn't exist today on the OpenClaw gateway. Out of scope for this
  build (modifying OpenClaw upstream, per CLIBENCH §55).

### D. Hybrid — static heuristic with timed-fallback override

- Use heuristic at session start (instant).
- If heuristic says "streaming" but no events arrive in 5s after
  `lifecycle:start`, downgrade to "batch" UI.
- If heuristic says "batch" but a non-lifecycle event arrives,
  upgrade to "streaming" UI (just hide the indicator).

## Decision

**Pick D — hybrid.**

- Static heuristic gives an *instant* classification (no probe latency).
- Timed-fallback corrects misclassification within 5 seconds in the
  worst case.
- Persisted per-agent override (`state.json:perAgent.<id>.liveness`)
  lets the user lock a classification if the heuristic mis-fires
  consistently.

Rationale:

1. Pure static (A) is wrong if a Pi-engine agent occasionally picks a
   batch backend mid-run, or if the prefix list goes stale.
2. Pure runtime probe (B) adds 5 seconds of latency at every session
   start. Batch backends already feel slow; making the first message
   take longer is the wrong tradeoff.
3. Server-declared (C) requires upstream OpenClaw work that's
   explicitly out of scope.
4. Hybrid (D) gives instant UX with self-healing.

## Heuristic table (initial; revisited as backends evolve)

```ts
// src/v2/probe/capability.ts
export function classifyByModel(modelPrimary: string): Liveness {
  if (modelPrimary.startsWith("pi/")) return "stream";
  if (modelPrimary.startsWith("claude-cli/")) return "batch";
  if (modelPrimary.startsWith("openai-codex/")) return "batch";
  if (modelPrimary.startsWith("anthropic-direct/")) return "stream";
  if (modelPrimary.startsWith("openai-direct/")) return "stream";
  return "unknown";   // assume streaming, downgrade after 5s if silent
}
```

## Override surfaces

1. **Flag**: `--liveness=auto|stream|batch|off`
2. **Env**: `BENCHAGI_LIVENESS`
3. **State file**: `state.json:perAgent.<agentId>.liveness` (set
   automatically when the user uses the flag with `--remember`, or
   manually via `benchagi agents config`).

`auto` is the default and engages the hybrid logic.

## Indicator UX (mirrors SPEC.md §7.2)

```
⠋ <agent> is working in batch mode (no live tool view)
  Last event 7s ago • Ctrl-C to abort
```

- Spinner: 10-frame Braille cycle, 80ms per frame.
- "Last event Xs ago": resets to 0 on every received event including
  `lifecycle`. Goes red at 120s+ with "(may be stuck — Ctrl-C to abort)".
- Fades out as soon as a non-`lifecycle` event arrives in the unknown/
  upgraded path.

## Failure modes

| Mode | Behavior |
|---|---|
| `model.primary` is empty/undefined | Treat as `unknown`, hybrid timer engages |
| Backend mid-classifies (Pi reports a batch model) | User flips with `--liveness=stream`; if persistent, save with `--remember` |
| `lifecycle:start` never fires | After 10s without any event, surface "Backend not responding" with Ctrl-C hint |
| Stream → batch within a single run (theoretical) | Whichever indicator was last shown stays; the renderer only adds, doesn't remove past output |

## Consequences

- Heuristic table goes in source; revisits are PRs not config drops.
- 5s downgrade timer + per-agent persistence keeps misclassifications
  rare and recoverable.
- Test coverage: SPEC.md §13 includes "pi/* → stream, claude-cli/* →
  batch" and "unknown classified after 5s timeout" cases.

## Revisit triggers

- A new backend prefix shows up in production agents (revisit table).
- OpenClaw upstream adds `agents.capabilities` (collapse to option C).
- Mis-classification rate exceeds 5% in real use (consider always running
  the runtime probe).
