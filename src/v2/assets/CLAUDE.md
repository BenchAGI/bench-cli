# Seat operating contract — OpenClaw-bound (READ FIRST)

You are a BenchAGI seat running **inside** the OpenClaw harness. OpenClaw — the
gateway, the fleet of machines, and the one-vault — is your substrate. The local
working directory is **one shard of a multi-machine system, not ground truth.**

A real incident (2026-06-12): a seat was told to run a handoff, searched only its
local filesystem, didn't find it, and declared it "doesn't exist." The handoff was
on **Mac mini one**, one `ssh`/vault lookup away. Do not repeat this.

## Fleet-first resolution (enforced)

Before concluding that any **handoff, runbook, or canon page** is missing, you MUST
resolve it across the fleet — never from a single machine:

```
aurelius-handoff-resolve <slug>            # locate: local -> vault -> fleet hosts
aurelius-handoff-resolve <slug> --cat      # locate + print the file
```

- It checks `local -> one-vault (~/.openclaw/wiki/main) -> fleet hosts (mini1, mini2,
  carbon-white) -> gateway`, stops at the first hit, and reports which shard.
- It exits non-zero (`NOT FOUND ACROSS FLEET`) **only after every shard misses.**
- **Do not** run a bare `find`/`grep` for a handoff/runbook and report absence. Use this.

The fleet (typical): this seat may be on the MacBook (`Corys-MacBook-Pro`, active machine)
or elsewhere. Runbooks/handoffs commonly live on **Mac mini one** (`mini1`,
tailnet `100.64.0.3`, host "Cory's Mac mini") and in the **one-vault**
(`~/.openclaw/wiki/main`). Reach them via OpenClaw (`openclaw wiki …`, the MCP
`openclaw_*` tools, `openclaw_gateway_health`) or the SSH aliases `mini1`/`mini2`/`carbon-white`.

## Delegation: dev work in-seat, orchestra (Codex) merges

Dev/code work is done **in-seat, in this Claude Code session** — do **not** fan work
out to OpenClaw agents, the Workflow tool, or Claude subagents. Reading the one-vault,
runbooks, and fleet state for context is fine (that's fleet-first *resolution*, not
delegation). The deliverable is an **Anvil-ready draft PR**; the **Codex orchestra**
(Hammer → Anvil → Polish) handles merge/deploy. Keep OpenClaw informed as intel, but
the work runs here. (Updated 2026-06-16 per Cory; supersedes the prior "fan out to
OpenClaw" directive — see the `dev-in-seat-inform-openclaw` memory.)

## One-vault discipline

Durable knowledge belongs in `~/.openclaw/wiki/main` (see `runbooks/one-vault.md`).
A file on one machine only is evidence, not source of truth. Runbooks → `runbooks/…`,
truth → `canon/topics/…`, live state → `_boards/live/…`.

## Fleet backup & memory (each host owns its lane)

Memories belong on the **NAS** (bench-forge-1, the Dell, SSH `lightdriver21@100.64.0.7`), never only
on one Mac. Each host backs up what it owns via `bench-harness/scripts/forge-brain/forge-brain-push.sh`
(it derives a per-host label): the **minis** back their SQLite brains (`sqlite`, 12 h); **this MacBook**
(now a dev client) backs the **markdown memory** repos (`repos`, 30 m) → `tank/brain`. Don't run a lane
you don't own (it fails `non-fast-forward`). Prove backups with `ssh bench-forge-1 '~/restore-drill.sh'`
(0 failed) — verify durability, never assume it. Installing a launchd lane on a prod host is
human-gated → hand Cory a `!` one-liner. Full doctrine + topology (mini1 brain/relay, mini2 hot twin,
NAS, failover): **`canon/topics/fleet-backup-and-memory-doctrine.md`**.

## Gateway

`openclaw gateway health` must be live; the SessionStart hook verifies and auto-starts
it. If a tool says the gateway is down, restart with `openclaw gateway start` before
proceeding — do not silently fall back to local-only behavior.

> Full rationale + enforcement: `~/.openclaw/wiki/main/runbooks/devices/claude-code-openclaw-binding.md`
