# ADR-002 — Browser-handoff flavor for Firebase Direct

**Status**: Accepted (will be revisited at ANVIL 2)
**Date**: 2026-05-05
**Decision-maker**: Hammer (Claude Code) — to be reviewed by Anvil (Codex)

## Context

`CLIBENCH.md:38` calls out the choice: **localhost-listener** (gcloud /
firebase-cli pattern) vs. **code-paste** (GitHub CLI pattern). Firebase
Auth has no true CLI-only flow; some browser handoff is required.

This auth flow runs **once** at install time and again only on token
revocation or Firebase project key rotation. Daily use does not re-run it.

## Options

### A. Localhost-listener (`gcloud auth login`, `firebase login`)

```
$ benchagi auth login
Opening https://benchagi.com/auth/cli?port=5872&state=… in your browser…

┌────────────────────────────────────────────────────────┐
│  Sign in to BenchAGI                                   │
│  [ Continue with Google ]                              │
│  [ Continue with email ]                               │
└────────────────────────────────────────────────────────┘
                            ↓
[ benchagi CLI receives token on http://127.0.0.1:5872 ]
"Signed in as cory@benchagi.com."
$
```

- CLI starts a local HTTP listener on a random unprivileged port.
- CLI prints + opens the URL with the listener's port and a CSRF state.
- User signs in on the web page (existing Firebase Auth UI).
- Web page reads `idToken` + `refreshToken` from the Firebase web SDK
  client and POSTs them back to the listener.
- Listener verifies CSRF, persists the tokens via keytar, exits.

**Pros**:
- One-click for the user — no copy-paste.
- ~90s end-to-end including unfamiliar-user dawdle time.
- Same pattern users already trust from `gcloud` and `firebase`.
- Handles SSO providers (Google, Apple) cleanly because the SDK already
  knows them.
- Works for users without a working `pbcopy` / `xclip`.

**Cons**:
- Requires a free local port; rare collision possible (we randomize 8000–9999
  to make this near-zero).
- Requires the browser to be able to reach `127.0.0.1` — fails if the
  user is signed in on a different machine than the CLI is running on
  (e.g., remote-SSH-into-server scenarios). Mitigation: print a fallback
  manual-paste URL.

### B. Code-paste (`gh auth login`, GitHub CLI)

```
$ benchagi auth login
Open this URL in your browser: https://benchagi.com/auth/cli/code
Enter the code shown there:
[paste]
"Signed in as cory@benchagi.com."
$
```

- CLI shows a URL and prompts for a code.
- User signs in on the web page; the page displays a one-time code.
- User pastes the code back to the CLI.
- CLI exchanges the code for tokens via a server endpoint.

**Pros**:
- Works across machines (CLI on server, browser on laptop).
- No local-port assumption.

**Cons**:
- More user steps (read code, paste back).
- Requires an authorization-code endpoint pair on the server (ephemeral
  store mapping code → tokens, with TTL). More server code than option A.
- Codes are typically short (8 chars) and need a bigger entropy budget +
  rate limiting to be safe — operational complexity.
- Slower — adds 30–60 seconds per login.

### C. Both (with `--device-flow` opt-in)

- Default to localhost-listener; flag `--device-flow` engages code-paste
  for cross-machine cases.

## Decision

**Pick A — localhost-listener.** Default flow. Document the cross-machine
case as a follow-up that adds `--device-flow` (option C, deferred).

Rationale:

1. **Lowest friction.** Login happens once at install. The 30–60 seconds
   saved per login is small in absolute terms but the *first-login
   experience* sets the tone for the CLI. Making it as smooth as `gcloud`
   matters.
2. **No new server endpoints needed for happy path.** The web-side
   completion endpoint (`apps/web/src/app/auth/cli/page.tsx`) just POSTs
   to the listener; no token exchange, no ephemeral code store.
3. **Existing infrastructure parallels.** `gcloud` and `firebase login`
   are the closest analogs and both use this pattern. Users already have
   muscle memory for it.
4. **Cross-machine case is real but rare.** Most CLI users sign in on
   their laptop, where the browser and CLI share `127.0.0.1`. SSH-only
   users are an edge case worth a follow-up flag, not a default.

## Implementation specifics

- **Port selection**: `crypto.randomInt(8000, 9999)`; retry once on
  `EADDRINUSE`.
- **CSRF state**: `randomBytes(16).toString('base64url')`. Constant-time
  compare on receipt.
- **Listener lifetime**: 90 seconds. After that, exit with an error.
- **Bind address**: `127.0.0.1` only. Never `0.0.0.0`.
- **CORS**: respond to `OPTIONS` from `https://benchagi.com` with
  `Access-Control-Allow-Origin: https://benchagi.com`. Reject all other
  origins with 403.
- **Firewall prompt on macOS**: bind to loopback so no incoming-firewall
  prompt fires.
- **Browser launch**: `open <url>` (macOS), `xdg-open` (Linux). Fall
  through to printing "Open this URL: <url>" if exec fails.
- **Ctrl-C during wait**: clean shutdown of listener, exit 130.

## Consequences

- The web-side endpoint is small and stateless.
- One follow-up: `--device-flow` for SSH/remote use cases. Logged in
  `ACTION-PLAN.md` as v1.1 work.
- Tested with macOS + Linux + Firefox + Chrome + Safari in Phase 2 step 8.
