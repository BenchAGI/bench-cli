---
name: forge-contribute
description: >-
  Drive the BenchAGI Forge Contribution Rail as an EXTERNAL contributor connected over the Bench
  Flyway/Mesh: pull a dispatched contract-pack, build the solution against its interfaces (you never
  see Bench's source), verify against the shipped acceptance tests, then pack + ed25519-sign a
  .benchpack and deliver it to Bench's quarantine gate — all via `bench forge`, with NO GitHub access.
  Use whenever a contributor wants to start, continue, or deliver Forge work; sees a packet dispatched
  to them; asks "how do I pull my contract / build / sign / deliver / check status"; or is iterating on
  a needs-changes bounce. Requires a provisioned contributor identity (a Bench API key + instance id +
  an ed25519 private key, minted for you by a Bench operator). Do NOT use for opening a request to Bench
  (that's `bench forge submit`) or for any work that needs Bench's private source.
---

# Forge Contribute — build off-site, deliver signed work to Bench

You are an **external contributor** on the Bench Flyway/Mesh. Bench dispatches you a unit of work as a
**contract-pack** — the *minimal* surface you need: problem spec, body-stripped `.d.ts` interfaces,
synthetic fixtures, and black-box acceptance tests. **You build against those interfaces on your own
machine. You never see Bench's source.** When you're done you **pack + sign** a `.benchpack` and deliver
it; a Bench-owned **quarantine gate** verifies your signature, scans it, and — only after a human
sign-off — Bench (never you) opens the PR. You need no GitHub access at any point.

This skill is the whole loop. Everything runs through `bench forge`.

## The model (internalize this — it shapes everything)

- **The wall.** The contract-pack is *all* you get. You build to the interfaces + the acceptance tests.
  If the tests pass against the shipped fixtures, you're done. Don't ask for more of Bench's code — the
  pack is deliberately minimal.
- **The acceptance tests are the definition of done.** Make them pass locally before you deliver.
- **You sign.** Every delivery is ed25519-signed with *your* contributor private key. The gate verifies
  it against the public key Bench registered for you. Unsigned/mis-signed = rejected, never accepted.
- **Stay in your lane.** The pack declares the surfaces you may touch. Files outside them trip
  `SURFACE_ESCAPE` at the gate. Your `.benchpack` is also *bound to the packet* — you can't deliver work
  built for a different contract.
- **Failure is sanitized + recoverable.** If the gate rejects, you get findings citing *your own* file
  line numbers (never Bench internals). Fix, re-pack, re-deliver.

## Prerequisites (one-time, provisioned by a Bench operator)

A Bench operator mints your identity with `mint-contributor` and hands you three things — load them
before you start:

1. **Bench API key** → `$BENCH_API_KEY` or `~/.openclaw/bench-cloud.key` (format `bench_forge-contrib-<you>_…`).
2. **Instance id** → `$BENCH_INSTANCE_ID` or `~/.openclaw/bench-cloud.json` (`{"instanceId":"forge-contrib-<you>"}`).
3. **Your ed25519 private key** (PEM) — keep it secret, never commit it. Default lookup `~/.openclaw/forge-contributor.pem` (or pass `--key <path>`).

Quick check you're wired up: `bench forge list` should return your packets without an auth error. If you
get `not connected to Bench Cloud`, the key/instance id aren't set. If a pull/deliver 404s, either the
rail isn't enabled for you yet or that packet isn't dispatched to you — ping your operator.

## The flow

### 1. Orient — which packet is yours?
```
bench forge list
```
Find the packet dispatched to you (state will be moving through the contribution lifecycle:
`contract-issued → building → submitted → quarantine → …`). Note its `packetId`.

### 2. Pull your contract-pack
```
bench forge pull <packetId> --out ./forge-<packetId>
```
This writes the build surface into the directory:
- `interfaces/*.d.ts` — the types you build against (bodies stripped — that's intentional).
- `fixtures/*` — synthetic inputs (no real customer data).
- `tests/*` — the **black-box acceptance tests** = your definition of done.
- `README.md` — the problem spec, success criteria, and the surfaces you're allowed to touch.
- `.forge-contract.json` — the binding metadata (packetId, contract version + hash, ipClass, declared
  surfaces). **Don't edit this** — `pack` reads it to bind your delivery to the dispatched contract.

Read the README first. Then read the interfaces and the acceptance tests — together they fully specify
what "done" means.

### 3. Build — against the interfaces, inside the declared surfaces
Implement your solution in the pull directory, importing from the shipped `interfaces/`. Stay within the
surfaces the README/`.forge-contract.json` declare — anything outside them will be rejected at the gate.
Do not paste Bench's production source into fixtures/tests; synthetic + black-box only.

### 4. Verify locally — make the acceptance tests pass
Run the shipped `tests/` against your build with your own toolchain. **Do not deliver until they pass** —
the gate runs the same suite in an isolated sandbox, and a failing suite bounces you to `needs-changes`.

### 5. Pack + sign
```
bench forge pack ./forge-<packetId> --key ~/.openclaw/forge-contributor.pem --out ./<packetId>.benchpack.json
```
This builds the content-addressed manifest (per-file sha256 + a Merkle `payloadRoot`), JCS-canonicalizes
it, and ed25519-signs it with your key. It prints the `benchpackId` + the envelope sha256. The signing is
byte-compatible with Bench's verifier — if `pack` succeeds, the signature will verify server-side.

### 6. Deliver
```
bench forge deliver <packetId> ./<packetId>.benchpack.json
```
Under the hood: `init` (reserves an upload + a 25 MiB-capped signed URL) → uploads the envelope → `finalize`
(Bench recomputes the hash, verifies your signature against your *registered* key, binds the manifest to
the packet, then advances the lifecycle to `quarantine`). It prints the resulting status. A clean delivery
lands at `lifecycleState: quarantine` — your bundle is now in the gate.

### 7. Track it
```
bench forge contrib-status <packetId> <contributionId>
```
Poll until the gate finishes. Outcomes:
- **accepted / packaged / delivered** — cleared the gate; Bench opens the PR under its own identity. Done.
- **needs-changes** — read the sanitized findings (your own file line numbers), fix, then **re-pack and
  re-deliver** (a fresh delivery; you can't overwrite a finalized one).
- **rejected** — terminal; the thread will say why.

## Command reference
| Command | What it does |
|---|---|
| `bench forge list` | Your packets + states (which is dispatched to you). |
| `bench forge pull <packetId> [--out <dir>]` | Pull the contract-pack into a build dir. |
| `bench forge pack <dir> --key <pem> [--out <file>]` | Build + ed25519-sign the `.benchpack` envelope. |
| `bench forge deliver <packetId> <benchpack> [--idempotency-key <k>]` | init → upload → finalize. |
| `bench forge contrib-status <packetId> <contributionId>` | Poll your delivery's gate status. |
| `bench forge status <packetId>` | The operator↔contributor message thread for the packet. |
| (any) `--json` | Raw JSON for scripting. |

## Gotchas (these are the ones that bite)
- **Sign with YOUR key.** The gate pins to the *registered* public key for your instance — a self-signed
  or wrong key fails at the signature stage. If you rotated keys, make sure the new one is registered.
- **Don't touch undeclared surfaces.** Files outside the contract's declared surfaces → `SURFACE_ESCAPE`.
  If you genuinely need another surface, that's a re-dispatch conversation with your operator, not a
  silent add.
- **Don't deliver across contracts.** The manifest is bound to the packet + the contract hash. Pack from
  the directory you pulled for *that* packet; mixing them trips `MANIFEST_PACKET_MISMATCH` / `CONTRACT_DRIFT`.
- **Re-deliver, don't re-upload.** After a finalize, the upload slot is locked (anti-tamper). A fix is a
  fresh `pack` + `deliver`, not a re-PUT to the old URL.
- **Findings are yours only.** The gate never shows you Bench internals, other contributors, the customer,
  or PR refs — just line numbers in files you wrote. That's by design.

## When NOT to use this skill
- Opening a *request* to Bench (a bug/feature ask) → `bench forge submit`.
- Work that needs Bench's private source → it can't be done this way; that's the whole point of the rail.
- You're a Bench operator dispatching/reviewing → that's the in-app operator surfaces, not this skill.
