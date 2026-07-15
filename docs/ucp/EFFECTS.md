# Unified Control Plane effect interface

**Schema:** `excalibur.ucp.v1`<br>
**Implementation:** `src/v2/ucp/`<br>
**Default authority:** `observe` and `prepare`; protected non-secret modes require short-lived, exact-effect grants, while `secret-use` requires per-access presence<br>
**Important:** `shipped` means an adapter exists. It does not mean live credentials, configuration, or production proof exist.

## 1. CLI surface

Run one effect with the implemented command shape:

```text
excalibur effect <id> --request <file|-> [--dry-run|--execute] [--grant <id>]
```

`--grant` may be repeated. `--json` is also supported for structured result, receipt, and receipt-path output.

Supporting commands:

```text
excalibur effects [--json]
excalibur health [--json]
excalibur grant issue --mode <mode> --effect <id> [--effect <id> ...] \
  --request-digest <64-lowercase-hex> --receipt <dry-run-receipt-id> \
  --ttl <1..900> --purpose <text> [--json]
excalibur grant revoke <id>
excalibur grants [--json]
```

Grant issuance first requires a matching `dry_run` receipt completed within the last 15 minutes, with the cited receipt ID, effect ID, and request digest. It then performs Touch ID verification. The grant record format recognizes `secret-use`, `mutate-tenant`, `publish-draft`, and `outbound-draft`, but a durable `secret-use` grant never replaces the per-access biometric ceremony. Each record carries exact effect IDs, request digest, and `sourceReceiptId`, is owner-private, and expires in at most 900 seconds. The CLI recognizes `--mission-secret-bundle` only to deny it with `UCP_MISSION_BUNDLE_UNAVAILABLE`; durable mission bundles are not shipped.

## 2. Request files

The JSON request is the effect-specific `input` object. It is **not** a larger envelope containing effect ID, actor, modes, grants, or secret references. The effect ID and grant IDs come from CLI arguments; the registry derives the local principal and definition.

Example local worktree dry-run request:

```json
{
  "repoPath": "/absolute/path/to/repository",
  "worktreePath": "/absolute/path/to/new-worktree",
  "branch": "codex/example-branch",
  "baseRef": "main"
}
```

```bash
excalibur effect worktree.prepare \
  --request /absolute/path/to/request.json \
  --dry-run --json
```

Use `--request -` to read one JSON object from stdin. Files must be regular files no larger than 256 KiB. Both `--dry-run` and `--execute` together are denied. If neither is supplied, the effect definition's `defaultDryRun` decides.

Request bodies may contain operational content needed by the adapter, but the registry persists only a SHA-256 digest of `{effectId,input}`. It does not persist the request object in the receipt.

The registry also maintains an exact allowed-field list per effect. Extra fields fail with `UCP_INPUT_FIELD_DENIED`; nested credential-bearing key names, credential-shaped strings, and excessive nesting fail with `UCP_SECRET_IN_INPUT_DENIED` or `UCP_INPUT_INVALID` before authorization.

## 3. Implemented definitions

This table mirrors `src/v2/ucp/definitions.ts`.

| Effect | Class | Required modes for execution | Dry-run support / default | Secret use | Availability |
|---|---|---|---|---|---|
| `worktree.prepare` | `local-prepare` | `prepare` | yes / dry-run | none | `shipped` |
| `packet.freeze` | `local-prepare` | `prepare` | yes / execute | none | `shipped` |
| `seat.dispatch` | `orchestra` | `prepare` | yes / dry-run | none | `ceremony_stub` |
| `github.watch_checks` | `publish-draft` | `secret-use` | no | required | `shipped` |
| `stamp.roster` | `local-prepare` | `prepare` | yes / execute | none | `shipped` |
| `bench.health` | `bench-read` | `secret-use` | no | required | `shipped` |
| `bench.deals.search` | `bench-read` | `secret-use` | no | required | `shipped` |
| `bench.deals.get` | `bench-read` | `secret-use` | no | required | `shipped` |
| `bench.deals.list` | `bench-read` | `secret-use` | no | required | `shipped` |
| `bench.cs.instance_summary` | `bench-read` | `secret-use` | no | required | `shipped` |
| `bench.cs.grant` | `tenant-mutation` | `secret-use`, `mutate-tenant` | yes / dry-run | required for intended live path | `ceremony_stub` |
| `mesh.control_health` | `mesh-read` | `observe` | no | none | `shipped` |
| `mesh.node_status` | `mesh-read` | `observe` | no | none | `shipped` |
| `mesh.preauth.mint` | `mesh-mutation` | `secret-use`, `mutate-tenant` | yes / dry-run | required for intended live path | `ceremony_stub` |
| `mesh.verify_customer_join` | `mesh-read` | `secret-use` | no | required | `shipped` |
| `mail.doctor` | `session` | `observe` | no | none | `shipped` |
| `mail.draft` | `outbound-draft` | `outbound-draft` | yes / dry-run | none | `shipped` |
| `mail.send` | `outbound-send` | `outbound-draft` in definition | no | required | `hard_denied` |
| `session.health_card` | `session` | `observe` | no | none | `shipped` |
| `receipt.write` | `local-prepare` | `prepare` | no | none | `shipped` |

For a dry-run of a mutation-capable effect, authorization collapses to ambient `prepare`. A dry-run does not materialize a secret and does not require the live protected-mode grant. `secret-use` is enforced at materialization by GateKeeper; other protected modes require an explicit grant matching both effect ID and request digest.

## 4. Grant and GateKeeper behavior

The registry starts with ambient `observe` and `prepare` modes.

- `mutate-tenant` and `outbound-draft` require an unexpired explicit grant naming the exact effect and SHA-256 digest of `{effectId,input}`, sourced from a recent matching dry-run receipt at issuance.
- Issuing that grant requires Touch ID. Executing a protected non-secret mode requires fresh Touch ID again through `authorizeProtectedEffect`; a grant file alone cannot suppress user presence.
- `secret-use` is per access and does not use a durable grant as a biometric substitute. GateKeeper performs Touch ID immediately before `op run` materializes the named `op://vault/item/field` reference into one child environment.
- When a single protected execution also needs a secret, the protected-effect ceremony creates an in-memory, same-effect, single-use presence token valid for at most 60 seconds. It is consumed by that secret access; it is not persisted and cannot be supplied by editing a grant file.
- Mission bundles are disabled. Current `secretUses` audit entries always report `presence:"per_access"` and `ttlSeconds:0`.
- The parent process receives the secret reference and audit metadata, not the value. `op run --env-file=/dev/fd/3 -- <child>` performs child-only injection after ambient credential-shaped environment variables and agent sockets are removed.
- Ordinary subprocesses receive a fixed path and small non-secret environment allowlist. The Touch ID helper uses the same scrubbed base; the credentialed `op` subtree gets a separate minimal allowlist plus only the named 1Password reference.
- The GateKeeper child-injection/presence path is covered by the current passing UCP suite. Real biometric and real 1Password materialization have not been exercised.

The UCP configuration accepts only `op://vault/item/field` secret references. It rejects embedded `apiKey`, password, token, credential, secret, authorization, or private-key fields. Its path is pinned to `$HOME/.config/excalibur/ucp.json`; `EXCALIBUR_UCP_CONFIG` may only resolve to that same path. Credential-bearing control-plane URLs must be HTTPS. If the file exists, it must be a bounded, non-symlinked, current-owner private file beneath an owner-controlled directory: health reports drift and effect execution denies `UCP_CONFIG_FILE_UNSAFE` otherwise.

## 5. Execution and receipt lifecycle

Actual registry order:

1. Resolve the registered effect and require an object input.
2. Compute the request digest.
3. Enforce the effect's exact field set and value-free input policy.
4. Resolve dry-run versus execute semantics.
5. Hard-deny deliberately unavailable effects such as `mail.send`.
6. Validate explicit grant IDs and required modes.
7. Write a `started` receipt before the adapter can create an external effect.
8. Load the pinned UCP config and deny an unsafe existing file.
9. Require fresh Touch ID for any protected non-secret execution mode.
10. Run the adapter; if it needs a secret, run GateKeeper and append its audit metadata.
11. Replace the receipt with the terminal status.

`session.health_card` is a separate operator command. The current registry does **not** automatically run it before every effect or convert all card blockers into authorization denials. Individual adapters enforce their own configuration and target checks. Run `excalibur health` before protected work.

For a protected non-secret mode, grant issuance requires `--receipt` to name a successful matching dry-run completed within 15 minutes, then stores that `sourceReceiptId`. Execution requires the supplied grant's `requestDigest` to equal the execute request digest. Use the same exact effect ID and unchanged input.

## 6. Receipt schema

Receipts use camelCase fields and the exact schema below:

```json
{
  "schemaVersion": "excalibur.ucp.v1",
  "receiptId": "uuid",
  "effectId": "worktree.prepare",
  "effectClass": "local-prepare",
  "requestDigest": "sha256-hex",
  "status": "dry_run",
  "dryRun": true,
  "startedAt": "RFC3339 timestamp",
  "completedAt": "RFC3339 timestamp",
  "principal": "local-user",
  "capabilityModes": ["observe", "prepare"],
  "grantIds": [],
  "secretUses": [],
  "summary": "Worktree plan validated; no worktree was created",
  "details": {
    "branch": "codex/example-branch",
    "baseRef": "main"
  },
  "denialCode": null
}
```

The only receipt statuses are:

| Status | Meaning |
|---|---|
| `started` | Adapter was authorized and may be in flight or indeterminate |
| `succeeded` | Adapter reported its implemented postcondition |
| `dry_run` | Validation completed without the effect's mutation |
| `denied` | A named policy/config/input boundary denied the request |
| `missing_config` | A required safe configuration or secret reference is absent |
| `failed` | An unexpected failure was reduced to a safe generic result |

The default state root is:

```text
~/.local/state/excalibur/ucp/state/effects/<receiptId>.json
```

`EXCALIBUR_UCP_STATE_DIR` may replace the root. Receipt/grant stores must be current-owner, non-symlinked private directories; receipt files are owner-private, non-symlinked on read, and limited to 64 KiB. Receipt detail keys that look secret-bearing are rejected, as are credential-shaped text and credential-bearing URLs.

These validation and filesystem controls are not a cryptographic signature. Grants and receipts are unsigned, owner-writable local JSON, so they assume trust in the local OS account and do not provide non-repudiation. External outcomes require correlated broker/destination proof in addition to the local receipt.

`secretUses` records only:

```json
{
  "reference": "op://vault/item/field",
  "purpose": "bounded effect purpose",
  "presence": "per_access",
  "ttlSeconds": 0
}
```

The type schema retains a `mission_bundle` enum value for compatibility, but the implemented CLI refuses mission-bundle issuance. Current runtime audits therefore use `per_access` with TTL zero. `result.output` is ephemeral CLI output and is never persisted in the receipt.

If the process crashes after the pre-effect write, the durable `started` receipt remains an indeterminate marker. If the initial receipt cannot be written, the adapter does not run.

## 7. Adapter inputs and current postconditions

### Local/orchestra

| Effect | Request fields | Implemented postcondition |
|---|---|---|
| `worktree.prepare` | `repoPath`, `worktreePath`, `branch`, optional `baseRef` | Dry-run validates. Execute runs `git worktree add -b`; branch must start `codex/`. |
| `packet.freeze` | `packet`, `outputPath` | Writes a new owner-private frozen packet beneath the UCP `state/packets` directory; it will not replace an existing file. Packet has `goal`, absolute `repoPaths`, `nonGoals`, `proof`, `maxFiles` 1–50, optional expiry; generated fields force `effects:"none"` and `credentials:"forbidden"`. |
| `seat.dispatch` | `packetPath`, `seat` | Legacy dry-run validation only. Execute returns `CANONICAL_ORCHESTRA_BROKER_REQUIRED`; no model or transport is invoked. |
| `stamp.roster` | `outputPath`, `packetDigest` | Writes one new owner-private JSON stamp beneath UCP `state/stamps`; it will not replace a file and has no remote PR-comment/body attachment path. |

Protected-effect language belongs in packet `nonGoals`. The current packet validator uses a conservative text pattern in `goal` and `proof`; it can reject quoted discussion and is not a semantic tool/target parser. This is a validation residual, but `seat.dispatch` still cannot invoke a model. Live Pattern A dispatch belongs only to the packaged `/orchestra` broker: `/orchestra init <absolute-mission-json>`, `/orchestra status <mission-id>`, and `/orchestra advance <mission-id> <exact-mission-digest>`.

### GitHub

UCP registers neither `github.draft_pr.publish.v1` nor
`git.publish_draft_pr`; it exposes no draft-publication adapter or publication
receipt. The sole operator-facing entry is
`/orchestra propose <mission-id> <absolute-owner-private-details-json>`. That
command invokes the pinned Pattern A broker with its internal `publish-intent`
verb, validates the exact intent, intent digest, publication-gate digest, and
action-binding digest, then submits the intent to the shared sidecar. Direct
invocation of either removed UCP effect ID is denied by the operator guard.
Live publication exists only behind the sidecar's validated proposal, exact
human approval nonce, and `excalibur.sidecar.github-draft-pr.v1`
deterministic executor. Merge, ready-for-review, release, and deploy are
separate and absent authorities.
The sidecar receipt, never the action payload, carries the kernel-read GitHub
`publisherPrincipal`, numeric `publisherPrincipalId`, `publisherConfigDigest`,
and `publisherIdentityAttestationDigest`. Mission and publication-gate fields
remain payload-only.

`github.watch_checks` fields are `repository`, `pullRequest`, and exact 40-hex `expectedHeadSha`. Its GateKeeper child reads the pull request's current head SHA and that commit's check runs from the GitHub API. A mismatch denies with `GITHUB_CHECKS_HEAD_MISMATCH`; the durable receipt records the expected SHA, counts, repository, and PR number. Live protected execution is unproven.

### Bench

All Bench reads require `instanceId`, configured `bench.apiBase`, and a configured 1Password secret reference. The request `instanceId` must use the bounded ID form and exactly match the selected process scope from `EXCALIBUR_INSTANCE_ID` or `BENCHAGI_INSTANCE_ID`. Missing or invalid process scope—including `all`, `any`, `bulk`, `default`, `global`, `operator-local`, and `unbound`—produces `UCP_TENANT_SCOPE_MISSING`; an invalid request scope produces `UCP_TENANT_SCOPE_INVALID`; mismatch produces `UCP_TENANT_SCOPE_DENIED`. The child sends `X-API-Key` plus `x-expected-instance-id`. There is no local-file or Markdown fallback.

- `bench.health`: authenticated `/api/v1/agent/health`.
- `bench.deals.search`: adds `query` and optional `limit` 1–200.
- `bench.deals.get`: adds `dealId`.
- `bench.deals.list`: optional `limit` 1–200 and `status`.
- `bench.cs.instance_summary`: authenticated deployment-status read.

Receipts keep HTTP status, count, and source; redacted response data is ephemeral output. The fresh health card reported Bench `missing_config`, so no live Bench read is proven.

`bench.cs.grant` accepts the active-scope-matching `instanceId`, `principal`, and explicit `customerSuccessEnabled:true`. Dry-run validates and records `broker:"required"`. Execute always denies with `BENCH_CS_GRANT_BROKER_REQUIRED`. It is a ceremony stub, not a live grant path.

### Mesh

- `mesh.control_health` takes no fields and performs public HEAD probes against configured control and DERP URLs. Any reached HTTP status is recorded. It proves public-edge reachability only—not reverse-tunnel health, Headscale admin readiness, customer join, or isolation.
- `mesh.node_status` takes no fields and reads local `tailscale status --json`; it returns only redacted self posture and records backend/self-observed status. It does not inspect a customer tenant.
- `mesh.preauth.mint` accepts active-scope-matching `instanceId`, numeric-string `headscaleUserId`, `reusable:false`, `ttlSeconds` 1–900, and at least one `aclTags` value matching `tag:tenant-...`. Dry-run validates only. Execute always denies with `MESH_PREAUTH_BROKER_REQUIRED`; no key is minted or logged. It is a ceremony stub.
- `mesh.verify_customer_join` accepts active-scope-matching `instanceId`, `nodeName`, and tenant-scoped `expectedTag`. With configured 1Password admin access, it reads `/api/v1/node` and matches the live node name plus forced/valid tag. It does not verify Firebase membership, the Headscale user, Aerie reachability, or cross-tenant denial. Live admin execution is unproven.

The fresh health card observed HTTP 200 from both public control and DERP edges but kept the Flyway row `locked` because admin configuration/customer isolation remain unproven. General customer multitenancy remains `designed_unproven`.

### Mail and session

- `mail.doctor` takes no fields. It checks only whether a configured local draft directory exists and always reports `sendReady:false` / `externalSend:false` on success.
- `mail.draft` accepts `to` (1–10 email addresses), `subject`, and `body`. Dry-run validates. Execute requires an `outbound-draft` grant and writes one owner-private local `.eml` file. It has no provider-hosted draft path and performs no send.
- `mail.send` is hard denied before adapter execution with `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED`. No second-grant send broker is implemented.
- `session.health_card` takes an empty object and returns the card as ephemeral output while storing a bounded summary receipt.
- `receipt.write` accepts `purpose` and writes a value-free marker digest through the normal receipt lifecycle.

## 8. Named denial examples

| Code | Current meaning |
|---|---|
| `UCP_EFFECT_UNKNOWN` | Effect ID is not in the registry |
| `UCP_EXECUTION_MODE_INVALID` | Both `--dry-run` and `--execute` were supplied |
| `UCP_DRY_RUN_UNSUPPORTED` | Dry-run was requested for an effect without that mode |
| `UCP_INPUT_FIELD_DENIED` / `UCP_SECRET_IN_INPUT_DENIED` | Input has an unregistered field or credential-bearing material |
| `UCP_CONFIG_FILE_UNSAFE` | Existing UCP config is not a safe pinned owner file |
| `UCP_GRANT_MISSING_OR_EXPIRED` | An explicit grant ID is absent, expired, malformed, wrong-principal, or unsafe |
| `UCP_GRANT_RECEIPT_INVALID` | Grant issuance lacks a matching recent successful dry-run receipt |
| `UCP_CAPABILITY_MODE_DENIED` | Required protected mode is not granted for the effect |
| `UCP_MISSION_BUNDLE_UNAVAILABLE` | Durable mission bundles are disabled; fresh Touch ID is required |
| `GATEKEEPER_USER_PRESENCE_UNAVAILABLE` | Touch ID cannot run; no secret was accessed |
| `GATEKEEPER_USER_PRESENCE_DENIED` | Touch ID was cancelled/rejected; no secret was accessed |
| `GATEKEEPER_1PASSWORD_MISSING` | 1Password CLI is unavailable; status is `missing_config` |
| `BENCH_MISSING_CONFIG` | Bench API base/reference is absent; no file fallback |
| `UCP_TENANT_SCOPE_MISSING` / `UCP_TENANT_SCOPE_INVALID` / `UCP_TENANT_SCOPE_DENIED` | Customer effect lacks a valid explicit selected instance, uses a placeholder/bulk request scope, or mismatches the process scope |
| `BENCH_CS_GRANT_BROKER_REQUIRED` | Live CS mutation is not shipped |
| `MESH_PREAUTH_BROKER_REQUIRED` | Live preauth mint is not shipped and no key was created |
| `CANONICAL_ORCHESTRA_BROKER_REQUIRED` | UCP validated the legacy packet but only `/orchestra advance` may dispatch a model |
| `GITHUB_CHECKS_HEAD_MISMATCH` | Live PR head differs from the exact reviewed SHA |
| `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED` | External mail send is deliberately hard denied |
| `UCP_OUTPUT_PATH_DENIED` / `SEAT_PACKET_OUTPUT_EXISTS` / `UCP_OUTPUT_EXISTS` | A local packet/stamp path escaped its state bucket or would replace a file |
| `UNBOUNDED_ORCHESTRA_PACKET_DENIED` | Packet goal/proof requested a protected external effect |

Broad operator denials remain correct outside these typed routes. Wrapping a protected action in a shell, seat packet, or other effect does not inherit authority.

## 9. Verified evidence and remaining proof

Verified on the current stabilized tree:

- build passed;
- the current UCP suite passed 21/21, covering GateKeeper, grant-store digest/expiry/bundle bounds, full receipt validation, tenant binding and bulk/placeholder denial, typed input, scrubbed child environments, health's non-ambient probes, packet schema/digest/intent, the absence of UCP draft-publication IDs, and the seat/mail fail-closed boundaries;
- `ucp-smoke.sh` passed the local UCP suite; draft publication is absent from UCP and enters only through `/orchestra propose`, whose pinned broker subprocess verb is `publish-intent`;
- the full v2 suite passed 321/321, package smoke passed 42/42, and the package canary passed;
- the Aurelius guard and launcher suite passed 35/35, with exact 19/19 non-hard-denied effect-set parity against the CLI and direct draft-publication IDs denied;
- a fresh 2026-07-15T04:53:11Z health card ran with zero `secretUses`, no open grants, nine blockers, and `fullyReady:false`;
- the card observed `node:macbook` at `100.64.0.1`, OpenClaw HTTP 200 but locked/unauthed, memory unreachable, Bench `missing_config`, mesh control+DERP HTTP 200 but locked, GateKeeper/GitHub/MCP locked, and operator policy missing.

Not proven or not performed:

- real Touch ID plus real 1Password materialization;
- any live Pattern A broker dispatch (`seat.dispatch` is a fail-closed validation stub);
- live GitHub push/draft PR or check read;
- live Bench reads or CS grant;
- live Headscale admin verify or preauth mint;
- provider mail draft or any external mail send;
- merge, ready-for-review, release, deploy, or production-live proof.

## 10. TD2 closure map

| TD2 boundary | Implemented route | Current evidence boundary |
|---|---|---|
| `GIT_PUSH_DENIED` | `/orchestra propose` → pinned broker `publish-intent` → shared sidecar `github.draft_pr.publish.v1` | UCP has no draft-publication ID or executor; live authority belongs exclusively to the sidecar's exact proposal/approval broker |
| `UNBOUNDED_ORCHESTRA_PACKET_DENIED` | `packet.freeze` + `/orchestra init|advance` | UCP may freeze locally; only the digest-bound Pattern A broker may dispatch seats |
| `OUTBOUND_MESSAGE_DENIED` | `mail.doctor` + local `mail.draft` | Local adapters shipped; `mail.send` hard denied |
| `REMOTE_HOST_EFFECT_DENIED` | `mesh.*` | Public probes returned HTTP 200 while health stayed locked; admin verify unproven; mint stub only |
| `SECRET_MANAGER_ACCESS_DENIED` | GateKeeper + `op://` refs | Implementation present; real ceremony unproven |
| Approved path absent/opaque | `excalibur effects` + named receipts/denials | Registry and CLI implemented |
| Chassis snapshot mistaken for live truth | Authenticated Bench reads | Honest `missing_config`; no live read yet |
| MCP partially dark | `excalibur health` independent rows | Fresh card kept OpenClaw/GitHub/MCP locked and reported memory unreachable |

## 11. State separation

Effect receipt status is not delivery state. Keep these facts separate:

`prepared` → `pushed` → `draft_pr` → `ready_pr` → `merged` → `deployed` → `live`

The current UCP has no ready, merge, release, deploy, or live-declaration effect. A `succeeded` receipt means only that one adapter's stated postcondition succeeded.
