# ANVIL-3-REVIEW

## Verdict
Hold. The local Pi-style streaming path can work when `agent.assistant` events arrive, and the Firebase browser-to-listener shape is mostly corrected, but the implementation does not yet satisfy the V2 contract: batch `chat` final/error payloads can render no answer, reconnect/history recovery is absent, `verboseLevel=full` is not actually applied on first session create, liveness claims reconnect/stuck behavior it does not enforce, and the Wiki overpromises several unimplemented controls.

## Severity scale
P0 = blocks ship · P1 = land before tag · P2 = follow-up · P3 = nice to have

## Walkthrough findings

### 1. `benchagi auth login` end-to-end
The core post-ANVIL-2 flow is implemented: `loginFlow()` opens `https://benchagi.com/auth/cli?port=<port>&state=<csrf>` (`src/v2/auth/firebase-direct.ts:37`) and binds an HTTP listener to `127.0.0.1` (`src/v2/auth/firebase-direct.ts:82`). The callback path is `/cli-callback`, and tokens are written only after a valid POST (`src/v2/auth/firebase-direct.ts:124`, `src/v2/auth/firebase-direct.ts:179`).

- Origin mismatch: `OPTIONS` from non-`https://benchagi.com` gets 403 (`src/v2/auth/firebase-direct.ts:110`); POST from another origin gets 403 and the listener stays open until timeout (`src/v2/auth/firebase-direct.ts:130`). Correct security posture, mediocre UX because the CLI prints no explanation.
- CSRF mismatch: 400, `CSRF state mismatch`, listener closes, no keychain write (`src/v2/auth/firebase-direct.ts:136`).
- Payload too large: 64 KiB cap, 413, listener closes, no keychain write (`src/v2/auth/firebase-direct.ts:145`).
- Browser-launch failure: prints fallback URL and keeps listening (`src/v2/auth/firebase-direct.ts:83`). Good.
- Port collision: no retry. ADR-002 requires retry once (`docs/v2/ADR-002-browser-handoff-flavor.md:114`), but `server.on("error")` just rejects (`src/v2/auth/firebase-direct.ts:91`).
- 90s timeout: closes listener and rejects (`src/v2/auth/firebase-direct.ts:73`), but it does not surface the spec's cross-machine "browser cannot reach..." guidance (`docs/v2/SPEC.md:155`).

Finding: **P1 auth edge handling is incomplete**. Fix port retry, timeout wording, and explicit cleanup on Ctrl-C.

### 2. Login interrupted mid-flow
Browser closure is indistinguishable from no callback: the listener waits until the timeout, closes, and rejects (`src/v2/auth/firebase-direct.ts:73`). Tokens are written only in the `creds.kind === "ok"` branch after validation (`src/v2/auth/firebase-direct.ts:50`), so mid-flow browser closure does not write keychain.

Ctrl-C is not owned by `loginFlow()`. The top-level CLI installs a process SIGINT handler that exits immediately (`src/v2/render/ansi.ts:67`), so the OS cleans up the socket, but the listener does not do its own graceful close despite ADR-002 requiring it (`docs/v2/ADR-002-browser-handoff-flavor.md:127`).

Finding: **P2 cleanup is acceptable for process exit, not for reusable `loginFlow()`**.

### 3. Pi backend chat session
Path: `ChatRunner.sendMessage()` ensures a session, generates an idempotency key, then calls `chat.send` with `sessionKey`, `message`, `idempotencyKey`, and `deliver: true` (`src/v2/chat-runner.ts:192`). This matches the real OpenClaw schema requiring `idempotencyKey` and no client `runId` (`/Users/coryshelton/clawd/openclaw/src/gateway/protocol/schema/logs-chat.ts:35`).

Assistant text reaches the user only if `event: "agent"` carries `stream: "assistant"` with `data.text`/`data.delta` (`src/v2/render/event-router.ts:60`, `src/v2/render/stream.ts:121`). Real OpenClaw `event: "chat"` carries text in `payload.message.content[].text` (`/Users/coryshelton/clawd/openclaw/src/gateway/server-chat.ts:732`, `/Users/coryshelton/clawd/openclaw/src/gateway/server-methods/chat.ts:1548`), but `renderChatDelta()` and `renderChatFinal()` only read `text`/`delta` (`src/v2/render/stream.ts:68`, `src/v2/render/stream.ts:79`). So Pi streaming can look fine through `agent.assistant`, while `chat` rendering is effectively broken.

`session.tool` late-join dedupe works for the narrow same-event mirror case: both `agent` and `session.tool` use `agent|runId|seq|stream|toolCallId|itemId` (`src/v2/render/event-router.ts:70`, `src/v2/render/event-router.ts:106`). It does not include `sessionKey`, even though SPEC §6.8 says it must prevent cross-agent collisions (`docs/v2/SPEC.md:420`).

Run-start lifecycle is de-duped per `runId` (`src/v2/chat-runner.ts:116`), but only starts are de-duped; lifecycle end events can duplicate and can complete the current waiter without checking the active `runId` (`src/v2/chat-runner.ts:127`).

Findings: **P0 chat payload extraction is wrong for real `chat` events**; **P1 first-session verbose mode is not applied** because `sessions.create` sends unsupported `verboseLevel` (`src/v2/chat-runner.ts:245`) while real `SessionsCreateParamsSchema` rejects extra properties (`/Users/coryshelton/clawd/openclaw/src/gateway/protocol/schema/sessions.ts:84`).

### 4. Claude CLI backend chat session + liveness
Batch classification is present (`src/v2/probe/capability.ts:13`) and auto-batch threshold becomes immediate (`src/v2/probe/capability.ts:28`). The two-clock string exists and shows `run quiet`, `gateway tick`, pid, and abort hint (`src/v2/render/liveness.ts:136`).

But for Claude CLI batch output, SPEC §6.4 says final text arrives as `event: "chat"` (`docs/v2/SPEC.md:337`). As above, the renderer ignores `message.content[].text`, so a batch final can complete the run with no answer shown (`src/v2/render/stream.ts:79`).

The liveness indicator is also not run-scoped. It starts at connect time (`src/v2/chat-runner.ts:100`) and has no active-run gate, so batch agents can show a spinner while idle at the prompt. It resets on every non-tick event, not just active-run events (`src/v2/render/event-router.ts:32`, `src/v2/render/liveness.ts:37`).

Non-TTY status is reachable every 30s only after the threshold passes (`src/v2/render/liveness.ts:55`, `src/v2/render/liveness.ts:97`). For batch/always this is reachable; for stream auto with a 30s gateway tick it waits about 90s.

Stuck detection is formatted for TTY (`src/v2/render/liveness.ts:76`, `src/v2/render/liveness.ts:146`), but non-TTY output never includes stuck/unhealthy state (`src/v2/render/liveness.ts:97`). "Connection unhealthy — reconnecting" is just text; no reconnect callback exists.

Findings: **P0 batch final text can be invisible**; **P1 liveness is not active-run scoped and does not trigger reconnect**.

### 5. Cloud-relay v1.1 readiness
The interface leaves a name for future transports (`src/v2/transport/transport.ts:14`), but `ChatRunner` is hard-wired to `LocalGatewayWsTransport`, not `Transport` (`src/v2/chat-runner.ts:28`, `src/v2/chat-runner.ts:41`). Mid-session disconnect just rejects pending RPCs and ends the event iterator (`src/v2/transport/local-gateway.ts:309`); `ChatRunner.eventLoop()` has no reconnect, no `chat.history`, no seq cursor, and no run reattachment (`src/v2/chat-runner.ts:156`).

Finding: **P1 the door is nominal, not architectural**. Cloud relay can be added as another class, but the runner lacks the disconnect/resume contract the spec requires.

### 6. Intentionally-failing tool call
For `stream: "tool"` with `phase: "failed"` or `"error"`, the user sees only `└─ <name> failed` (`src/v2/render/stream.ts:194`). The renderer drops error details, result/stderr, exit code, and duration.

For `stream: "error"`, the user sees `Error: <message>` and stack if present (`src/v2/render/stream.ts:248`). For top-level `event: "chat"` with `state: "error"`, real OpenClaw sends `errorMessage` (`/Users/coryshelton/clawd/openclaw/src/gateway/server-methods/chat.ts:1587`), but `renderChatFinal()` ignores it (`src/v2/render/stream.ts:79`). That means some failed runs end with no visible error.

Finding: **P1 error rendering hides the actionable failure reason**.

### 7. Wiki entry as a new user
Not good enough as the first post-install read. It is confident and detailed, but it reads like an internal launch memo, assumes the reader already knows OpenClaw, agents, Aurelius, Claude CLI, and gateway pairing, and advertises behavior the implementation does not ship.

Confusing or wrong:

- It says `[r]` expands tools (`/Users/coryshelton/.openclaw/wiki/main/_boards/nodes/master/benchagi.md:43`), but no expand state or key handler is wired; the renderer just prints the hint (`src/v2/render/stream.ts:190`).
- It says liveness triggers reconnect (`/Users/coryshelton/.openclaw/wiki/main/_boards/nodes/master/benchagi.md:219`), but no reconnect exists.
- It says `Ctrl-C` aborts and restores the prompt (`/Users/coryshelton/.openclaw/wiki/main/_boards/nodes/master/benchagi.md:223`), but approval/repl key handling is not wired through `ChatRunner` and single-turn Ctrl-C exits.
- It says `benchagi version` includes build SHA (`/Users/coryshelton/.openclaw/wiki/main/_boards/nodes/master/benchagi.md:158`), but the command prints version, node, platform only (`src/v2/commands/version.ts:7`).
- It starts with protocol taxonomy instead of a plain first-run path: install OpenClaw/Gateway, run `benchagi doctor`, list agents, pick one, send first message.

Missing: prerequisites, what to do if there are zero agents, how gateway pairing works, what "Firebase optional" means in plain English, known V1 limitations, and a minimal "first successful command" path.

## Bugs (P0/P1)

- **P0: Batch `chat` final text can be invisible** · `src/v2/render/stream.ts:79` · real OpenClaw final text is `payload.message.content[].text`, not `payload.text`; Claude CLI/Codex batch runs can finish with a blank answer · extract text from OpenAI-style content blocks for delta/final and render `errorMessage` on `state:error`.
- **P1: `sessions.create` silently rejects `verboseLevel=full`** · `src/v2/chat-runner.ts:245` · real schema allows `agentId`, `key`, `label`, `model`, etc., but not `verboseLevel` (`/Users/coryshelton/clawd/openclaw/src/gateway/protocol/schema/sessions.ts:84`); the catch falls back to `agent:<id>` and tool verbosity is not asserted · create the session with supported fields, then call `sessions.patch { key, verboseLevel: "full" }`.
- **P1: Missing required method/cap validation** · `src/v2/chat-runner.ts:71` · only `chat.send`, `chat.history`, `sessions.list` are checked; SPEC also requires `sessions.patch`, approval RPCs, and `tool-events` capability handling (`docs/v2/SPEC.md:255`) · validate the full method set and warn/continue only for missing tool-events per SPEC.
- **P1: No reconnect/history recovery** · `src/v2/chat-runner.ts:156` · disconnect ends the event loop; `waitForFinal()` waits until timeout and no `chat.history` replay happens · add reconnect state, seq cursor, history replay, dedupe, and in-flight run reattach.
- **P1: Liveness claims reconnect without reconnect** · `src/v2/render/liveness.ts:143` · unhealthy status says "reconnecting" but no callback or transport action exists · either wire reconnect or change the text before tag.
- **P1: Auth port collision not retried** · `src/v2/auth/firebase-direct.ts:91` · ADR-002 says retry once; current login fails immediately on `EADDRINUSE` · retry a fresh random port before opening the browser.
- **P1: Tool/chat errors hide useful details** · `src/v2/render/stream.ts:194` · failed tools show only "failed"; chat errors show nothing · render `error`, `exitCode`, `stderr`/result summary, and `errorMessage`.

## Worst UX moments

- A Claude CLI backend can finish successfully and show no answer.
- The terminal says "press [r] to expand" but `[r]` does nothing.
- The liveness line can say "reconnecting" while no reconnect is happening.
- A first-time login timeout does not explain the cross-machine loopback failure the spec explicitly calls out.
- The Wiki makes a new user parse internal architecture before giving them a simple first successful command.

## What the hammer skipped from the spec

- SPEC §5.4: full method validation, `tool-events` cap handling, and `maxPayload`-aware warnings.
- SPEC §5.5/§5.6: run recovery, seq-gap detection, `chat.history` replay, and reconnect cadence.
- SPEC §6.4: real `chat.message` payload rendering and chat/agent assistant dedupe by `runId`.
- SPEC §6.5: approval key handling is defined in `ApprovalState`, but the REPL never passes `onKey` to it (`src/v2/cli.ts:168`).
- SPEC §6.7: large client-side tool result temp files and slow-terminal backpressure.
- SPEC §7.1: active-run-scoped liveness, reconnect trigger, and no idle spinner.
- SPEC §13: the minimum auth, reconnect, renderer, and approval tests are not present; current tests cover only state, agents, probe, liveness formatting, and event-router routing.

## What's not broken

- The Firebase flow is now browser-to-listener, not server-to-localhost (`src/v2/auth/firebase-direct.ts:37`).
- Loopback bind and origin checks are sane (`src/v2/auth/firebase-direct.ts:82`, `src/v2/auth/firebase-direct.ts:130`).
- The connect frame shape matches the real `ConnectParams` schema (`src/v2/protocol/types.ts:16`, `/Users/coryshelton/clawd/openclaw/src/gateway/protocol/schema/frames.ts:20`).
- `chat.send` uses `idempotencyKey` and does not invent a client-side `runId` (`src/v2/chat-runner.ts:204`).
- `session.tool` mirror dedupe works for identical mirrored events (`src/v2/render/event-router.ts:70`).
- TTY liveness formatting does show both clocks (`src/v2/render/liveness.ts:136`).
