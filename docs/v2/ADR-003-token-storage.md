# ADR-003 — Token storage library

**Status**: Accepted
**Date**: 2026-05-05
**Decision-maker**: Hammer (Claude Code) — to be reviewed by Anvil (Codex)

## Context

The CLI stores Firebase ID + refresh tokens after `auth login`, reads them
on each connection, and writes refreshed tokens back. Storage must be:

- Cross-platform (macOS, Linux; Windows is v1.1).
- OS-native secure storage (no plaintext on disk).
- Tolerant of multi-instance / multi-account scenarios (we only do one
  account in v1, but the storage shouldn't preclude multi).

## Options

### A. `keytar` (npm package, native bindings)

- macOS Keychain, Linux Secret Service / libsecret, Windows Credential Vault.
- Native binding (~30 KB compiled).
- Wide deployment: VS Code uses it, Atom used it, Slack-relay's flow
  references it (`apps/relay/relay-v3.mjs:626`).

**Pros**:
- Industry standard.
- Existing relay daemon already uses macOS Keychain via native APIs;
  alignment.
- Idempotent API (`setPassword`, `getPassword`, `deletePassword`).

**Cons**:
- Native binding means platform-specific binaries in the package or
  build-on-install. Modern keytar uses prebuilt binaries; works fine.
- Linux requires `libsecret-1-0` installed; missing on minimal containers.
  Mitigation: detect missing → fall back to encrypted-file storage with
  a clear warning.

### B. `@napi-rs/keyring`

- A newer N-API binding to OS keychains. Better Node 22 compatibility,
  Rust-implemented.
- Pros: Rust, pre-built binaries for every platform, Node 22+ first
  class.
- Cons: Smaller ecosystem; less battle-tested. API surface differs from
  keytar (slightly).

### C. Encrypted file (e.g., `~/.config/benchagi/secrets.json` with chmod
`0600` + fernet/AES-GCM)

- Pros: No native bindings.
- Cons: Plaintext key has to live somewhere; hardcoding it in the binary
  is trivial to extract. On macOS it's strictly inferior to Keychain.
  On multi-user Linux, file perms protect against other unprivileged
  users but not root or process introspection. Worse than the OS
  primitive for the same problem.

### D. Plain env var (`BENCHAGI_TOKEN`)

- Pros: Trivial.
- Cons: Plaintext in shell history, in `ps`, in CI logs, in env-dumps from
  panicking processes. Refresh-rotation requires rewriting the env which
  the CLI process cannot do. Dead-end for our use case.

## Decision

**Pick A — `keytar`.**

Rationale:

1. **Established and matches existing relay daemon's storage.** Same
   library, same keychain entry pattern. Operational consistency.
2. **Cross-platform with one API.** Same code on macOS and Linux.
3. **Linux fallback is documented.** Detect `libsecret` absence at first
   `setPassword`; fall back to encrypted file with a warning. This keeps
   the CLI usable in minimal containers without a hard `libsecret`
   dependency.
4. **`@napi-rs/keyring` is plausible** but the community gravity is still
   on keytar. Revisit in v1.x if keytar's prebuilds become flaky on Node 22.

## Storage scheme

- **Service**: `benchagi-cli`
- **Account**: `firebase` (just one, v1)
- **Value**: JSON-serialized `{ idToken, refreshToken, uid, email,
  expiresAt }`. We don't split into multiple entries because the keychain
  per-entry overhead is real (especially on Linux Secret Service where
  each entry is a D-Bus call).
- **On wipe**: `keytar.deletePassword('benchagi-cli', 'firebase')`. Best
  effort — never hangs the CLI on keychain failure.

## Failure modes

| Failure | Handling |
|---|---|
| `keytar` native binding missing | Build error at install time; npm should retry the binding install once, otherwise fail with a clear "missing libsecret-1-0?" message |
| `libsecret` missing on Linux at runtime | Detect; fall back to `~/.config/benchagi/secrets.json` (chmod 0600, AES-GCM with key derived from machine id + a random per-install salt). Log a warning at every login that secure storage is degraded. |
| Keychain locked (macOS, Linux GNOME Keyring locked at boot) | Prompt user via system dialog (keytar handles this); on user cancel, exit 4 |
| Multi-instance race (two CLI invocations writing tokens) | Both writes are idempotent; the later one wins. The losing CLI's already-fetched token stays valid until expiry. |

## Consequences

- Keytar adds ~30 KB to the package and a small native build step on
  install.
- Linux containers without `libsecret` get a warning + degraded path.
- Documented in §"Configuration" of the V2 README.

## Revisit triggers

- keytar prebuild flake rate exceeds 1% of installs.
- Node 22 ships native KeyChain bindings (it doesn't; this is a future
  hypothetical).
- Multi-account becomes a v1.1 requirement → revisit storage scheme.
