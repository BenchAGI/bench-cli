# BenchAGI CLI

`bench` is the BenchAGI command line. It gives you the everyday verbs you
already use in Codex / Claude Code — `ask`, `chat`, `feed`, `tail` — pointed
at your local OpenClaw agent runtime.

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
itself. It is idempotent and safe to re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/BenchAGI/bench-cli/main/scripts/install.sh | sh
```

…or directly via your favourite package manager:

```bash
npm  install -g @benchagi/cli
pnpm add    -g @benchagi/cli
yarn global add @benchagi/cli
```

After install, run:

```bash
bench setup
```

This verifies that:
1. `openclaw` is on your `PATH`,
2. your local gateway is reachable,
3. at least one agent is configured,
4. (optional) the default agent answers a ping.

If something is off, `bench setup --fix` invokes `openclaw doctor --repair`
non-interactively to apply the safe migrations.

### Homebrew

```bash
brew install BenchAGI/tap/bench
```

The tap lives at <https://github.com/BenchAGI/homebrew-tap>. The formula stub
for publishing it is in `scripts/homebrew/bench.rb`.

## Requirements

- macOS or Linux
- Node 20+
- [OpenClaw](https://docs.openclaw.ai) (`npm install -g openclaw`) with a
  running local gateway

## Commands

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
| `bench setup` | Readiness checks for first-time installs |
| `bench version` | Print version |

Run `bench <cmd> --help` for full options.

## Examples

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

The CLI does not write to disk and does not read or print secrets. It only
shells out to the local `openclaw` binary, which owns auth + gateway state.

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
npm test   # 25 smoke tests covering parser, formatter, --help, live JSON
npm run lint
```

## Roadmap

- [x] Per-agent `bench chat` REPL (in-process, sidesteps openclaw TUI's
      single-default-agent limitation)
- [x] `bench tail` over `openclaw logs --follow --json`
- [x] `bench commitments`
- [x] `bench setup` readiness check (incl. optional `--fix`)
- [x] Shell completion (bash + zsh)
- [x] `scripts/install.sh` curl-pipe installer
- [ ] Homebrew tap (`benchagi/homebrew-tap`) with formula `bench`
- [ ] `bench send <agent> <session> ...` to address an explicit session id
- [ ] First-class streaming via gateway WebSocket (replaces shelling out)
- [ ] `bench update` self-update against npm registry

## License

MIT © BenchAGI
