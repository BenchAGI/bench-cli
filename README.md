# BenchAGI CLI

This package ships **two binaries** from one install:

- **`benchagi`** (V2, since 1.0) — streaming-aware terminal client. Connects
  to the local OpenClaw Gateway over WebSocket and renders the full event
  taxonomy: tool calls, assistant deltas, command output, patches, plans,
  approvals. Two-clock liveness indicator for batch backends so silence is
  visible silence with a countdown, never a frozen process. **Use this for
  daily interactive work.**
- **`bench`** (deprecated back-compat alias, kept working) — thin shell-out
  around `openclaw` for the everyday verbs `ask`, `chat`, `feed`, `tail`,
  `commitments`, `agents`, `sessions`, `tasks`, `status`, `setup`. These
  verbs run on the `bench` alias today; native `benchagi` equivalents are
  landing per the roadmap. New users should prefer `benchagi`.

`benchagi` is the canonical command going forward. `bench` continues to work
as a deprecated alias so existing scripts and muscle memory don't break. Both
binaries discover agents from the same `openclaw.json`, share the same install
URL, and live in the same npm package + Homebrew tap.

## The launcher (boot + agent picker)

Running `benchagi` on an interactive terminal opens the **BenchAGI launcher**: a
boot cinematic, then a picker of the agents your account/instance is entitled to.

```text
$ benchagi                 # boot → pick an agent
$ benchagi launch          # force the launcher
$ benchagi --no-launch     # skip it; open the REPL with your last agent
```

- **Picker:** a two-stage arrow-key setup flow. Pick an agent, then choose
  environment (**Cloud** tunnel, **Direct** gateway, **Claude** local seat, or
  **Codex** local seat), model, effort, thinking display, and **Launch**.
  Exit a session to return to the picker.
- **Login:** if you're not signed in, the launcher runs `benchagi auth login`
  (Firebase browser hand-off) first, so agents know who you are.
- **Roster = entitlements:** the agents shown are exactly what you're provisioned
  for (`GET /api/v1/cli/entitlements`), cached for offline; falls back to
  `agents list` for local dev.
- **Update-on-launch:** checks `/api/v1/cli/manifest.json` and prompts to
  `brew upgrade` when a newer CLI is out. Silent/graceful when current or offline.
- `--no-launch` / `BENCHAGI_NO_LAUNCH=1` keep the classic bare REPL; `benchagi
  <message>` and non-TTY use are unchanged.

## V2 (`benchagi`) at a glance

```text
$ benchagi doctor
✓ local OpenClaw Gateway reachable
✓ gateway protocol v3 (server 2026.5.2)
✓ required methods present
  policy: maxPayload=26214400B, tickInterval=30000ms
✓ 7 agent(s) discovered
⊘ not signed in (Firebase Direct optional in V1)

$ benchagi --agent kestrel-coder "ping"
[run started · 174502cd-…]
HEARTBEAT_OK
[run ended]

$ benchagi
benchagi 1.0.0-beta.1 · agent kestrel-aurelius · type /exit or Ctrl-D to quit
> What did Sage merge yesterday?
…streaming reply with live tool blocks…

> /exit
```

Full V2 docs: see `docs/v2/SPEC.md` and the wiki entry at
`~/.openclaw/wiki/main/_boards/nodes/master/benchagi.md`.

## V1 (`bench`, deprecated alias) at a glance

`bench` is the deprecated back-compat alias. It still works and gives you the
everyday verbs you already use in Codex / Claude Code — `ask`, `chat`, `feed`,
`tail` — pointed at your local OpenClaw agent runtime. These verbs run on the
`bench` alias today; native `benchagi` equivalents are landing per the roadmap.

```text
$ bench feed
Gateway: up  ws://127.0.0.1:18789  78ms
Agents: 7  492 sessions total
  ● kestrel-aurelius  sessions=388  last=33s ago

Recent sessions (last 240m)
  kestrel-aurelius  38s ago   agent:kestrel-aurelius:tui-…
  ...

Background tasks
  succeeded acp       Context engine turn maintenance  58s ago
```

## Install (customer)

The one-liner installs Node 20+ checks, OpenClaw verification, and the CLI
itself. On macOS it also installs `~/Applications/BenchAGI.app` and pins the
BenchAGI glyph in the Dock. It is idempotent and safe to re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/BenchAGI/bench-cli/main/scripts/install.sh | sh
```

...or directly from the GitHub source tarball:

```bash
npm  install -g https://github.com/BenchAGI/bench-cli/archive/refs/heads/main.tar.gz
pnpm add    -g https://github.com/BenchAGI/bench-cli/archive/refs/heads/main.tar.gz
yarn global add https://github.com/BenchAGI/bench-cli/archive/refs/heads/main.tar.gz
```

The package name is `@benchagi/cli`; use that form once the public npm package
is published. Until then, the installer defaults to the GitHub tarball so a
fresh machine can install directly from `main`.

After install, run:

```bash
benchagi doctor
bench setup            # legacy readiness check (deprecated alias)
```

If the macOS app ever needs to be repaired or you installed through Homebrew,
run:

```bash
benchagi install-app
```

`benchagi doctor` is the canonical post-install check. It verifies the V2
streaming console: local Gateway protocol support, event-frame methods,
discovered agents, and Firebase Direct identity when signed in.
For local Claude/Codex seat memory capture, it must report the gateway method
`local-seat.capture`; if that method is missing, upgrade OpenClaw before
launching local seats.

`bench setup` is the legacy readiness check on the deprecated `bench` alias.
It verifies the legacy command surface and local OpenClaw readiness:
1. `openclaw` is on your `PATH`,
2. your local gateway is reachable,
3. at least one agent is configured,
4. (optional) the default agent answers a ping.

If something is off, `bench setup --fix` invokes `openclaw doctor --repair`
non-interactively to apply the safe migrations.

### Homebrew

```bash
brew install BenchAGI/tap/benchagi
```

The tap lives at <https://github.com/BenchAGI/homebrew-tap>. The canonical
`benchagi` formula installs both binaries; `brew install BenchAGI/tap/bench`
remains as a deprecated alias formula that installs the identical artifact. The
formula stub for publishing it is in `scripts/homebrew/benchagi.rb`.

Homebrew leaves Dock mutation to the user. Run `benchagi install-app` after
`brew install` for the same macOS Dock launcher experience as the curl
installer.

## Requirements

- macOS or Linux
- Node 20+
- [OpenClaw](https://docs.openclaw.ai) (`npm install -g openclaw`) with a
  running local gateway

## Local Claude and Codex seats

Local seats preserve the picker-selected agent through `BENCHAGI_SEAT_AGENT_ID`
and send bounded session captures to OpenClaw through `local-seat.capture` when
the gateway supports it. If the gateway is offline or too old, BenchAGI still
writes fallback JSONL under `~/.config/benchagi/seat-events/`, but those files
are not replayed automatically.

For Codex CLI seats, BenchAGI writes `.codex/hooks.json` in the seat workspace.
On first launch, if Codex reports hooks need review, run `/hooks` and trust the
BenchAGI seat bridge hook. Until trusted, Codex skips the hook and prompt
captures will not reach OpenClaw.

## Commands

These verbs run on the `bench` alias today; native `benchagi` equivalents are
landing per the roadmap. Until then, invoke them via `bench <verb>`.

| Command | Description |
| --- | --- |
| `bench ask <agent> "msg"` | Single-turn message; prints reply |
| `bench chat <agent>` | Per-agent interactive REPL |
| `bench feed` | Status + recent sessions + tasks in one view |
| `bench tail` | Live-tail the gateway log stream |
| `bench commitments` | Inferred follow-ups across agents |
| `bench agents` | List configured agents |
| `bench sessions [agent]` | Recent conversation sessions |
| `bench tasks` | Background tasks (subagent / acp / cron / cli) |
| `bench status` | Gateway + channel + agent health |
| `bench link` | Pair this Mac to your Aurelius with the signed-in Bench identity |
| `bench link <8-digit-code>` | Pair this Mac from a fresh/not-yet-signed-in install |
| `bench relink` | Re-pair this Mac after the Aurelius bridge drops |
| `bench setup` | Readiness checks for first-time installs |
| `bench version` | Print version |

Run `bench <cmd> --help` for full options.

## Examples

These examples use the `bench` alias because the verbs shown run there today;
native `benchagi` equivalents are landing per the roadmap.

```bash
# Single turn at high reasoning.
bench ask aurelius --high "Daily briefing please"

# Pipe a longer prompt in.
cat prompt.md | bench ask cole --thinking medium

# Per-agent REPL — type, get an answer, repeat. /exit to leave.
bench chat aurelius --thinking high

# Live log stream for one agent at WARN+.
bench tail --agent kestrel-aurelius --level warn

# Just the running tasks.
bench tasks --status running

# Sessions everywhere in the last hour.
bench sessions --all-agents --active 60 --limit 20

# Inferred follow-ups for one agent.
bench commitments --agent aurelius
```

## Agent name resolution

Short names map to canonical OpenClaw ids. The mapping is loaded at runtime
from `openclaw agents list --json`, with static fallbacks for offline use.

| Short | Canonical |
| --- | --- |
| `aurelius` | `kestrel-aurelius` |
| Anything matching the trailing segment of an id | auto-resolved |

## Shell completion

```bash
# bash
sudo cp completions/bench.bash /etc/bash_completion.d/bench

# zsh
mkdir -p ~/.zsh/completions
cp completions/bench.zsh ~/.zsh/completions/_bench
echo 'fpath=(~/.zsh/completions $fpath); autoload -U compinit; compinit' >> ~/.zshrc
```

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `BENCH_OPENCLAW_BIN` | Path to the `openclaw` binary | `openclaw` |
| `NO_COLOR` | Disable ANSI colors | unset |

The legacy OpenClaw verbs shell out to the local `openclaw` binary, which owns
gateway state. `bench link`/`bench relink` call Bench cloud pairing endpoints
and write the Aurelius bridge credential under
`~/.openclaw/agents/aurelius-<principal>/bridge-credential.json` with private
file permissions. The CLI does not print stored tokens.

## Design notes

- **Zero runtime dependencies.** Only the Node 20 standard library — read the
  source before trusting it.
- **Wrapper, not protocol client.** We spawn `openclaw ... --json` and
  normalize output. That keeps the surface tiny and stable across OpenClaw
  upgrades; if/when streaming or latency matters, we can grow a native
  WebSocket client without breaking the CLI.
- **Readable error messages.** The OpenClaw banner and stale plugin warnings
  are filtered before output so JSON is parseable and errors stay legible.
- **No git operations.** This CLI never invokes git.

## Tests

```bash
npm test            # legacy bench smoke tests (V1)
npm run build       # compile V2 TypeScript to dist/
npm run test:v2     # V2 unit tests (event router, probe, liveness, state, agents)
npm run lint
```

## Roadmap

V1 (`bench` wrapper):

- [x] Per-agent `bench chat` REPL
- [x] `bench tail` / `bench commitments` / `bench setup`
- [x] Shell completion (bash + zsh)
- [x] `scripts/install.sh` curl-pipe installer

V2 (`benchagi` native streaming):

- [x] First-class streaming via Gateway WebSocket (closes V1's roadmap line)
- [x] Full event-taxonomy renderer (`agent-events.ts`'s 11 streams)
- [x] Two-clock liveness indicator for batch backends
- [x] Approval state machine (exec.approval.resolve, plugin.approval.resolve)
- [x] Device-identity signed handshake (piggybacks on openclaw's pairing)
- [x] Auto-discovery of gateway token from `openclaw.json`
- [x] Hammer-Anvil reviewed spec (PRE-SPEC-VERIFICATION + 6 ADRs + ANVIL-2)
- [ ] Homebrew tap version bump for v1.0.0
- [ ] Cloud-relay primary transport (v1.1, gated on cloud chat endpoint)
- [ ] Cross-machine `--device-flow` (PKCE code-paste)
- [ ] Migrate useful `bench` verbs into `benchagi` native protocol

V2 spec docs in `docs/v2/`. Wiki entry at
`~/.openclaw/wiki/main/_boards/nodes/master/benchagi.md`.

## License

MIT © BenchAGI
