# Contract: `GET /api/v1/cli/user-profile`

The durable-identity endpoint the CLI calls at `benchagi auth login` to fetch the
**server-verified** user profile (display name + access tier). It is the single
authoritative source — the CLI never hand-sets identity. **Source of truth: Firestore**
(the `users/{uid}` doc + the existing `rankFromFirebaseUserData()` rank logic).

## Request
```
GET /api/v1/cli/user-profile
Authorization: Bearer <Firebase ID token>      # same token model as /cli/entitlements
```
- Validate the bearer (Firebase ID token; also accept an instance API key if you want
  parity with `/cli/entitlements`). 401 if invalid/missing.
- Resolve the caller's `uid` from the verified token (do **not** trust a client-supplied uid).

## Response `200` (`Cache-Control: private, no-store`)
```jsonc
{
  "uid": "abc123",
  "email": "jory@benchagi.com",
  "displayName": "Jory Allen",
  "accessLevel": "Epic",        // CLI tier name (see mapping)
  "accessColor": "Purple"       // tier color
}
```
All fields are strings; any may be omitted if unknown (the CLI degrades — it shows what
it has and treats a missing tier as "no tier"). The CLI stamps its own `verifiedAt`.

## Rank → CLI tier/color mapping (Firestore rank → response)
Derive `accessLevel`/`accessColor` from the Firestore user rank via `rankFromFirebaseUserData()`:

| Firestore rank | accessLevel | accessColor |
|----------------|-------------|-------------|
| `orange`       | Legendary   | Orange      |
| `purple`       | Epic        | Purple      |
| `blue`         | Rare        | Blue        |
| `green`        | Uncommon    | Green       |
| `white`        | Viewer      | White       |
| `red`          | Mythic      | Red         |

(Confirm `white`/`red` labels with product; the four middle tiers match
`config/permissions.json` in kestrel-aurelius. Crew members must exist in Firestore with
the correct rank — Firestore is the sole source per the 2026-06-07 decision.)

## CLI consumption (already built, this PR)
- `src/v2/auth/profile-sync.ts` → `syncUserProfile()` fetches this (Bearer = fresh Firebase
  token), persists `~/.config/benchagi/user-profile.json` with `verifiedAt`.
- `commandAuthLogin()` calls it after sign-in; `loadUserProfile()`/`profileIsFresh()` feed
  the seat identity. `verified` is true **only** when a fresh (<30d) server profile exists.
- **Graceful:** until this endpoint is deployed, login still succeeds; the seat falls back
  to the local `account.json` assertion (shown honestly as "identity set locally").

## Implementer notes
- Mirror `/api/v1/cli/entitlements` (route + `_schema.ts` + auth via `with-cli-auth.ts`).
- Read-only (Admin SDK + token verify); no rules/index/config change → same Firebase
  posture as the entitlements endpoint. Needs Cory's read-access sign-off before deploy.
