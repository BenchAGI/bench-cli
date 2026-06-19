# agent-chat relay

A small, durable Python bridge between a web app and a locally-running
[OpenClaw](https://github.com/BenchAGI) agent gateway.

The web app never talks to the gateway directly. Instead it enqueues a chat turn
into Firestore; this relay — running on the same machine as the gateway — claims
the turn, forwards it to the gateway, and streams the response back through
Firestore to the browser. The cloud is the broker; **this** process is the
runtime, so agent execution stays on the machine that owns the gateway, its
workspace, memory, and skills.

## Architecture

```
[Browser]
   │  POST /api/agents/<agent>/say
   ▼
[Web app route]  — Admin SDK write
   ▼
[Firestore: agentChatInbound/{eventId}  status: pending]
   │  snapshot listener (this relay)
   ▼
[relay: claim → AgentRun doc → Outbound doc → POST /v1/chat/completions]
   │  HTTP SSE (token stream)
   ▼
[OpenClaw gateway  http://127.0.0.1:18789]
   │  token stream back
   ▼
[relay: write each token as chunks/{seq}, accumulate AgentRun steps]
   ▼
[Firestore: agentChatOutbound/{outboundId}/chunks/{seq...}]
   │  SSE relay (in the web app's API route)
   ▼
[Browser receives streamed tokens + live run updates]
```

The gateway is spoken to over the OpenAI-compatible
`POST /v1/chat/completions` endpoint with `Accept: text/event-stream`:

- **Agent selection** — `model="openclaw/<agentId>"` selects the agent; the
  `x-openclaw-agent-id` header is sent too as defense-in-depth.
- **Continuity** — `x-openclaw-session-key` pins the gateway session to the chat
  `sessionId` so successive turns in a conversation share memory.

Each SSE frame's `choices[0].delta.content` is written as a `token` chunk; a
multi-agent turn's sub-agent tree (carried on `delta.openclaw_workflow`) is
reduced into durable `workflowSessions` docs for the live UI.

## Durability features

The relay is built to survive a machine dying mid-turn and to run as a pair of
machines (a primary plus a liveness fallback) against the same instance:

- **Per-machine routing + failover** — set `MACHINE_ID` and a turn is claimed
  only by the machine it targets (`runOn`). A machine configured as a
  `FALLBACK_FOR` a primary takes over primary-targeted turns only when the
  primary's presence has gone stale (>90s without a heartbeat). With
  `MACHINE_ID` empty, the relay is unscoped and claims everything
  (single-machine setup).
- **Orphan reaper** — the snapshot listeners watch `status=='pending'` only, so
  a turn flipped to `processing` just before a hard death (`kill -9`, panic,
  power loss) would otherwise hang forever. A background reaper revisits stale
  `processing` docs whose claimer is provably dead and either resets them to
  `pending` (so the fallback migrates the in-flight turn) or fails them with a
  recoverable error chunk (so the user sees a retryable error, not a silent
  hang). The reap TTL is derived from the gateway timeout so it always exceeds
  the longest legitimate turn.
- **Presence heartbeats** — the relay writes a dedicated liveness doc
  (`gatewayStatus/chatRuntime` and a per-machine `chatRuntime-{MACHINE_ID}`)
  every heartbeat interval, enriched with role, gateway health, active-turn
  count, and the current run/model. This powers the web app's bridge-status
  liveness check and the failover staleness window.
- **In-app notify-back** — when a completed reply surfaces a BenchAGI PR URL,
  the relay writes a `pr` follow-up link doc (create-if-not-exists, so
  re-mentions never duplicate). The bundled `notify_back_daemon.py` watches that
  PR to a terminal state and posts an unprompted in-chat "done" follow-up. The
  relay itself never shells out to `gh`.
- **Token self-heal** — the gateway bearer token is re-resolved from the
  gateway's own config on every heartbeat and every turn, so a token rotation
  never 401s the chat and never needs a restart.
- **Disk watchdog + tmp reaper** — `bin/disk-watchdog.sh` alerts when the volume
  holding `~/.openclaw` runs low; `bin/reap-memory-tmp.sh` reclaims leaked
  memory-core reindex scratch files left by hard-killed reindexes. Both ship as
  LaunchAgents under `launchd/`.

## Setup

```bash
cd relay

# 1. Create a virtualenv (Python 3.13 recommended; avoid 3.14 — protobuf's C
#    extension hits a metaclass error there).
python3.13 -m venv .venv
source .venv/bin/activate

# 2. Install deps
pip install -r requirements.txt

# 3. Copy and fill the env template
cp .env.example .env
#   - INSTANCE_ID:                  the Firestore instance this relay serves
#   - FIREBASE_SERVICE_ACCOUNT_PATH: absolute path to a Firebase Admin SA JSON
#                                    (keep it OUTSIDE the repo)
#   - GATEWAY_TOKEN:                the OpenClaw gateway bearer token
#   - (optional) GATEWAY_URL, MACHINE_ID/MACHINE_NAME/FALLBACK_FOR, etc.

# 4. Verify the gateway is reachable
curl -sS http://127.0.0.1:18789/health   # expect 200

# 5. Run the relay in the foreground for a first sanity check
python runtime.py
```

You should see a log line like:

```
watching agentChatInbound where instanceId=... AND status=pending
```

### Running under launchd (production)

The LaunchAgent templates under `launchd/` point at this directory's `.venv` and
scripts. Edit the `/Users/youruser/...` paths to match where you cloned the repo,
then install:

```bash
cp launchd/com.benchagi.agent-chat-runtime.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.benchagi.agent-chat-runtime.plist
```

Logs land under `~/Library/Logs/BenchAGI/`. After editing `.env` or the plist's
environment block, reload with `bootout` + `bootstrap` (NOT `kickstart` —
`kickstart` does not reload the environment block):

```bash
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.benchagi.agent-chat-runtime.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.benchagi.agent-chat-runtime.plist
```

Optional companion agents (all under `launchd/`):

- `com.benchagi.notify-back-daemon.plist` — the in-app notify-back daemon.
- `com.benchagi.disk-watchdog.plist` — low-disk alerting.
- `com.benchagi.reap-memory-tmp.plist` — leaked-reindex-scratch cleanup.

## Files

| File | What it is |
|------|-----------|
| `runtime.py` | The relay: claim → forward → stream back, with routing, reaper, heartbeats, and notify-back link writing. |
| `notify_back_daemon.py` | Watches `sessionFollowups` links to terminal state and posts in-chat "done" follow-ups. |
| `.env.example` | Config template. Copy to `.env`. |
| `requirements.txt` | Pinned Python dependencies. |
| `launchd/` | LaunchAgent plists. |
| `bin/` | `disk-watchdog.sh` + `reap-memory-tmp.sh`. |
