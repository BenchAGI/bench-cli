# Excalibur / BenchAGI CLI

This package ships **three binaries** from one install:

- **`excalibur`** (beta.15 candidate) — the canonical command and shared Desktop/CLI contact surface. It
  attaches to the Excalibur app's authenticated numeric-loopback HTTP sidecar,
  uses the same scoped conversation ID, and resumes its ordered SSE ledger from
  the last accepted cursor. Operator and tenant identity are explicit headers;
  tenant federation forwards a fresh Firebase human token to loopback in a
  dedicated request header without copying it into CLI state, receipts, or traces;
  a lost tenant sidecar can fall back only to authenticated control-plane reads,
  with chat, proposals, approvals, and effects locked. Grok chat is sidecar-only;
  the CLI has no direct provider ACP launch path. There is no alias cutover in
  this preview.
  **Use this as the beta preview landing surface.** The legacy
  `Excalibur CLI Preview.app` toolbar item is a Native/Aurelius shadow conductor,
  not this surface, and must not be used for a One-Surface test drive.

- **`benchagi`** (1.x compatibility surface) — streaming-aware terminal client. Connects
  to the local OpenClaw Gateway over WebSocket and renders the full event
  taxonomy: tool calls, assistant deltas, command output, patches, plans,
  approvals. Two-clock liveness indicator for batch backends so silence is
  visible silence with a countdown, never a frozen process. **Use this for the
  existing BenchAGI launcher and seat workflow.**
- **`bench`** (1.x compatibility surface, kept working) — thin shell-out
  around `openclaw` for the everyday verbs `ask`, `chat`, `feed`, `tail`,
  `commitments`, `agents`, `sessions`, `tasks`, `status`, `setup`. These
  verbs run on the `bench` alias today; native `benchagi` equivalents are
  landing per the roadmap. New Excalibur work should use `excalibur`.

`benchagi` retains its current behavior while the Excalibur preview is
tempered. `bench` continues to work as a compatibility command so existing scripts
and muscle memory don't break. All three binaries live in the same npm package;
the published Homebrew formula remains on its current release until beta.15 is
published.

```sh
excalibur                         # shared Desktop/CLI conversation surface
excalibur ask "summarize this"    # single turn
excalibur context list           # local + exact bound instance only
excalibur sessions               # explicit scoped resume IDs
excalibur providers status       # sidecar + cloud-read posture
excalibur doctor                 # state modes, boundaries, and PATH shadows
```

### MIGHT and operator posture

Every interactive startup and `excalibur doctor` reports a content-free MIGHT
card instead of a single ambiguous ready light:

- **Mission** — exact context and sidecar-owned conversation.
- **Intelligence** — requested/served conductor model plus attestation.
- **Grants** — typed capabilities, live gates, and current effects posture.
- **Hands** — support-seat roster, isolated worktree lease/head, and the
  deterministic draft-PR publisher.
- **Truth** — shared append-only receipt projection and endpoint sample.

The card always names one of four postures. `SHADOW` is read-only; `PREPARE`
can conduct and build but cannot execute an effect; `WIELD` has at least one
typed, approval-bound deterministic action; `LAND` appears only if a separate
merge/landing capability is present and usable. Both WIELD and LAND also
require the canonical draft-publisher capability and exact executor binding;
a missing or drifted binding stays PREPARE. Memory, calendar, schedules,
support-seat, worktree, receipt, and publisher failures degrade only their own
capability. Missing sidecar endpoints, mismatched contract digests, an inactive
shared conversation, or a served-model mismatch block canonical core readiness.

The first WIELD action is `github.draft_pr.publish.v1`. Its proposal binds the
allowlisted repository, clean worktree, base/head refs and SHAs, patch,
changed-path and packet digests, Pattern A mission ID/digest, publication-gate
digest, metadata, and `draftOnly: true`. WIELD requires the exact
`excalibur.sidecar.github-draft-pr.v1` action/executor binding. The approval
card never prints its single-use confirmation nonce. Raw `git push`, `gh`,
ready-for-review, merge, and deploy are not CLI authority paths.
Every canonical draft receipt must also carry the GitHub login and numeric user
ID read back by the kernel, plus the dedicated publisher-config digest and
publisher-identity attestation digest; mission/gate fields remain proposal-only.

`/orchestra` is the narrow Pattern A broker contact surface. Its configuration
is an absolute JSON file path in `EXCALIBUR_ORCHESTRA_CONFIG`; the file has the
exact shape below and points to a sealed `/bin/sh` wrapper. That wrapper invokes
an absolute, versioned Node executable plus the absolute Pattern A broker. A raw
`#!/usr/bin/env node` broker is not accepted as the configured entry because a
restricted launch `PATH` cannot execute or attest it reliably.

```json
{
  "schemaVersion": "excalibur.pattern-a-broker-config.v1",
  "brokerExecutable": "/absolute/package/path/excalibur-pattern-a-wrapper",
  "brokerSha256": "<64 lowercase hex characters for the wrapper bytes>",
  "resourceSetDigest": "<64 lowercase hex characters>",
  "stateRoot": "/absolute/canonical/owner-private/pattern-a-state"
}
```

The config must be a current-operator-owned `0600`-equivalent regular file;
the wrapper must resolve beside or below it, be operator-owned, executable,
single-linked, and not group/world writable. `stateRoot` must already be its
canonical realpath and an owner-private directory. Before every mission
command, Excalibur hashes the wrapper bytes and invokes only bare `status` with
this bounded request on stdin:

```json
{
  "schema": "excalibur-pattern-a-publication-verifier-preflight-request-v1",
  "stateRootRealpath": "/the/exact/configured/state-root",
  "expectedResourceSetDigest": "<the exact configured digest>"
}
```

The broker must return the exact resource-set/state-root attestation and its
canonical SHA-256. The resource-set pin is
`canonicalSha256({schema:"excalibur-pattern-a-resource-set-v1",resources:[...]})`;
`resources` is ordered as `broker`, `contract`, `seat-adapters`, with each entry
equal to `{name,sha256}` over raw file bytes. Wrapper drift, resource drift,
state-root drift, malformed output, or a bad attestation blocks the command.
Only the configured state root is passed as `EXCALIBUR_PATTERN_A_STATE_ROOT`;
legacy ambient state-root overrides are removed.

`/orchestra init <absolute-mission-json>` freezes owner-private local mission
state and invokes no model or external effect, so it does not require an
approval-bound session. `/orchestra status <mission-id>` is read-only.
`/orchestra advance <mission-id> <exact-mission-digest>` is available only in
an approval-bound Excalibur session. Both commands invoke that exact executable
with an argument vector and `shell: false`, require a bounded
`excalibur.pattern-a-broker-result.v1` JSON response, and render mission state
plus receipt counts. There is no PATH discovery or provider fallback; missing
or invalid configuration renders `Orchestra · unavailable` and invokes
nothing.

After `ANVIL_GATED`, use
`/orchestra propose <mission-id> <absolute-owner-private-details-json>`. The CLI
asks that same pinned broker for its exact
`github.draft_pr.publish.v1` intent, verifies the intent and publication-action
binding digests, and submits it unchanged to `transport.createProposal` for the
current sidecar conversation. The response must bind the same target, payload,
and idempotency key before the existing approval card becomes active. `[A]`
carries the hidden single-use nonce and `[D]` denies. `/orchestra` has no Git
executor, provider fallback, or direct publication path.

### Canonical toolbar bundle (staging only)

`scripts/make-excalibur-app.sh` packages `Excalibur One Surface.app`. It copies
one exact Node runtime plus the CLI's `bin`, `dist`, `package.json`, and complete
`node_modules` closure into the app, embeds the checked-in protocol, manifest,
and routing digests, binds the launch command's SHA-256, declares
`selfContainedRuntime: true` and `directProviderLaunch: false`, verifies the
bundle with `codesign --verify --deep --strict`, and then runs
`excalibur doctor --launch-check` before every interactive launch. It has no
PATH, BenchAGI, Grok, Claude, or Codex fallback.

Build into a staging directory without changing the installed toolbar or Dock:

```bash
npm run build
EXCALIBUR_APP_DIR="$PWD/.staging-apps" \
EXCALIBUR_CLI_NODE="$(command -v node)" \
EXCALIBUR_CLI_ENTRY="$PWD/bin/excalibur.mjs" \
EXCALIBUR_ORCHESTRA_CONFIG="/absolute/package/path/orchestra-config.json" \
bash scripts/make-excalibur-app.sh
```

Inspect the staged bundle and run `excalibur doctor` against the matching
sidecar before any separately approved installation. The builder deliberately
does not remove, replace, launch, or pin the legacy preview. Omit
`EXCALIBUR_ORCHESTRA_CONFIG` to build an honestly unbound launcher;
`/orchestra` will report unavailable. The builder validates and path-binds the
owner-private config, wrapper SHA-256, broker closure preflight, and canonical
state root, but never copies the config or any secret into the app.

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
- **Local-seat PR contract:** local Claude/Codex seats include the Hammer/Anvil
  readiness rule: crew-authored PRs stay draft until Anvil passes them, and
  handoffs include scope, touched surfaces, Firebase/deploy impact, local gates,
  smoke evidence, blockers, and follow-ups.
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

## V1 (`bench`, 1.x compatibility command) at a glance

`bench` is the retained 1.x compatibility command. It still works and gives you the
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

## Install (CLI only)

After beta.15 is published from merged mainline, install that exact package
version. Do not install from `main` or another moving branch:

```bash
npm  install -g @benchagi/cli@1.0.0-beta.15
pnpm add    -g @benchagi/cli@1.0.0-beta.15
yarn global add @benchagi/cli@1.0.0-beta.15
```

After the matching release tag exists, the portable installer is likewise
pinned to beta.15 and rejects branch/git inputs:

```bash
curl -fsSL https://raw.githubusercontent.com/BenchAGI/bench-cli/v1.0.0-beta.15/scripts/install.sh | sh
```

For the pre-release internal preview, use only the checksum-pinned transfer
tarball produced by the package canary; do not describe it as sealed until the
source has merged and the release digest has been verified. In every case the
installer changes only the CLI package. It does not install, replace, rename,
launch, or pin any desktop application. In particular,
`/Applications/Excalibur.app` build 7 remains untouched until a separate
explicit desktop installation approval.

After install, verify the command actually selected by `PATH` and the sidecar
contract/model/memory/schedules posture:

```bash
excalibur version
excalibur doctor
```

`benchagi doctor` and `bench setup` remain available as compatibility-console
and OpenClaw readiness checks, respectively. They are not substitutes for
`excalibur doctor` and the installer does not invoke either automatically.

### Homebrew

The candidate formula in `scripts/homebrew/benchagi.rb` is pinned to the beta.15
release tag and installs all three terminal commands. Publish it only after its
placeholder SHA-256 is replaced with the sealed release digest. The formula is
also CLI-only and never mutates a desktop app or Dock state.

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
- [ ] Homebrew tap publish for v1.0.0-beta.15 after sealed digest verification
- [ ] Cloud-relay primary transport (v1.1, gated on cloud chat endpoint)
- [ ] Cross-machine `--device-flow` (PKCE code-paste)
- [ ] Migrate useful `bench` verbs into `benchagi` native protocol

V2 spec docs in `docs/v2/`. Wiki entry at
`~/.openclaw/wiki/main/_boards/nodes/master/benchagi.md`.

## License

MIT © BenchAGI
