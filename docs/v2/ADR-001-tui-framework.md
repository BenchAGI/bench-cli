# ADR-001 — TUI framework

**Status**: Accepted (will be revisited at ANVIL 2)
**Date**: 2026-05-05
**Decision-maker**: Hammer (Claude Code) — to be reviewed by Anvil (Codex)

## Context

The CLI's main UX is a streaming event renderer with a chat REPL on top.
Per `CLIBENCH.md:133`, the TUI library is picked from candidates "already
present or trivially available in the Node/TS ecosystem. Candidates: Ink,
blessed, raw ANSI, `pi-tui`."

The renderer needs:

1. Precise cursor positioning for the live tool-call block (animated
   borders, progress text updates in place, expand/collapse without
   redrawing the whole stream).
2. Inline streaming text (assistant + thinking deltas) that feels native,
   not like a re-rendered React component.
3. A live liveness indicator that updates every 1s without flicker.
4. Multi-line REPL input with arrow-key history and `\` continuation.
5. Ctrl-C interrupt at any point, including mid-stream and mid-tool-call.
6. Smooth degradation in dumb terminals (CI logs, `script(1)`, plain
   `ssh`).

## Options

### A. Ink (`ink` + React)

- React-flavored. Component re-renders on state changes.
- Pros: Familiar component model. Big ecosystem (forms, spinners, gradient
  text). Layout is easy.
- Cons: ~30 transitive deps. Re-render model is a poor fit for streaming
  text — every delta would re-render the whole transcript or require
  manual `static` blocks. Adds React + Yoga (layout) + Pastel + ink-spinner.
  Some terminals have flicker issues in 5.x. The CLI is not a TUI app
  in the classical sense; it's a streaming event renderer with a prompt.

### B. `blessed` / `neo-blessed`

- Older, full-screen TUI framework. Window-and-widgets model.
- Pros: Powerful for complex layouts.
- Cons: Heavy. Full-screen mode is wrong for a CLI that interleaves with
  shell history. Maintenance is patchy.

### C. Raw ANSI (escape codes via `node:process.stdout`, no library)

- Direct control over cursor, color, line clearing.
- Pros: Zero deps. Smallest possible surface. Streaming model fits exactly:
  each event prints lines; tool-call blocks reserve N lines, repaint via
  cursor up + clear-line; liveness indicator is one line cleared and
  rewritten on a 1s timer. Plays well with shell scrollback (no
  alternate screen). Degrades cleanly in dumb terminals — just plain text.
- Cons: We write the rendering primitives ourselves. Estimated
  300–500 lines of `ansi.ts` + `renderer.ts`.

### D. `pi-tui` (`@mariozechner/pi-tui`)

- OpenClaw's TUI library. Custom, written by an active OpenClaw
  contributor.
- Pros: Already in the OpenClaw codebase; same author writes the streaming
  primitives we'd be consuming.
- Cons: Not a published-stable library — version churn comes with each
  OpenClaw release. Coupling our CLI to OpenClaw's internal TUI choice
  binds our release cadence to theirs. The library is built for
  OpenClaw's specific full-screen TUI use; we are not building a
  full-screen TUI.

## Decision

**Pick C — raw ANSI.**

The renderer is small enough that the dep cost of Ink/blessed/pi-tui
exceeds the cost of writing it ourselves. The streaming model is a poor
fit for React's re-render cycle. Raw ANSI gives us the cursor control we
need for the liveness indicator and the tool-call block without paying
for a TUI framework's layout engine.

The split:

- `src/v2/render/ansi.ts` — primitives (color, cursor, clear-line)
- `src/v2/render/stream.ts` — translate `AgentEventPayload` → output
  lines, owns the tool-call block state machine
- `src/v2/repl/prompt.ts` — multi-line prompt with arrow history (uses
  `node:readline` with `line` events; no TUI framework needed)
- `src/v2/render/liveness.ts` — single-line indicator, 1s timer, cursor
  save/restore around it

Total budget: ~600 LOC for the rendering layer. If we exceed that during
implementation, revisit and consider Ink.

## Consequences

- Test strategy: snapshot tests on `stream.ts` against fixture event
  sequences. The deterministic line output makes diffs trivial.
- Color handling: respect `NO_COLOR=1` env var (already a convention in
  legacy `bench`).
- Dumb-terminal handling: detect `process.stdout.isTTY === false` →
  drop ANSI, drop the liveness indicator (CI/log captures get plain
  text).
- Width: dynamically read `process.stdout.columns`; fallback to 80.

## Revisit triggers

- Render layer grows past ~800 LOC with sprawl → Ink might be cheaper.
- Need for genuinely complex layouts (split panes, scrollable side
  panels) → Ink or blessed.
- ANVIL 2 review surfaces a UX failure mode raw ANSI can't address.
