# Unified Control Plane — STATUS

**Updated:** 2026-07-14 America/Denver<br>
**Overall:** typed UCP foundation and Orchestra-only draft-publication boundary implemented; protected live effects remain deliberately unproven<br>
**Operator:** Light<br>
**Evidence rule:** `shipped` code, passing tests, public health, protected live execution, merge, deploy, and production-live are separate claims

## Verification checkpoint

Reported results:

- CLI build: **PASS**.
- UCP suite: **21/21 PASS**.
- Full v2 regression suite: **321/321 PASS**; package smoke: **42/42 PASS**; package canary: **PASS**.
- `scripts/ucp-smoke.sh`: **PASS** for local UCP boundaries; no draft-publication action is registered there.
- Aurelius operator guard and launcher suite: **35/35 PASS**.
- Guard/CLI non-hard-denied effect-set parity: **19/19 exact**; direct draft-publication effect IDs are denied.
- Fresh `excalibur health`: **PASS** at `2026-07-15T04:53:11Z`; it reported nine blockers, zero secret uses, and no open grants.

The snapshot records the final supplied verification results and the inspected interfaces under `src/v2/ucp/`.

## Implemented interface

Core command:

```text
excalibur effect <id> --request <file|-> [--dry-run|--execute] [--grant <id>]
```

The request file is the effect-specific JSON input object. It is not a full authorization envelope. `--grant` is repeatable; `--json` is supported. Registry discovery is `excalibur effects`; health is `excalibur health`. Protected grants are issued through:

```text
excalibur grant issue --mode <mode> --effect <id> --request-digest <64hex> --receipt <dry-run-receipt-id> --ttl <1..900> --purpose <text> [--json]
```

Issuance requires a matching `dry_run` receipt no more than 15 minutes old. The grant records its `sourceReceiptId`, binds the exact effect ID, request digest, and principal, and expires in at most 900 seconds. Durable mission bundles are disabled; `--mission-secret-bundle` is always denied.

Receipts use schema `excalibur.ucp.v1`, UUID `receiptId`, camelCase fields, and statuses:

```text
started | succeeded | dry_run | denied | missing_config | failed
```

Default receipt location is `~/.local/state/excalibur/ucp/state/effects/<receiptId>.json`, owner-private. A `started` receipt surviving without a terminal overwrite is indeterminate, not success.

## Deliverables and evidence

| Surface | State | Evidence boundary |
|---|---|---|
| Architecture/effect/playbook/operator docs | `ALIGNED` | Markdown now matches implemented CLI, definitions, receipts, stubs, and proof |
| Effect registry and CLI | `IMPLEMENTED · TESTED` | Registry definitions, typed request parsing, named availability/modes; UCP suite and build passed |
| Receipt writer | `IMPLEMENTED · TESTED · LOCAL TRUST` | Pre-effect `started`, atomic owner-private final write, request digest, secret-key/detail rejection, and value-free dry-run receipt are covered; files are unsigned and owner-writable |
| Grants | `IMPLEMENTED · PARTIAL UNIT COVERAGE · LOCAL TRUST` | Exact effect/digest, owner-private storage, expiry ≤900 seconds, edited-window bounds, and disabled mission bundles are tested; CLI matching-receipt issuance is implemented but lacks a direct end-to-end unit test; records are unsigned and owner-writable |
| Session health card | `IMPLEMENTED · RAN` | Conversation boot/resume and explicit `excalibur health` derive the MacBook node and expose blockers instead of claiming readiness |
| GateKeeper | `IMPLEMENTED · TESTED · LIVE UNPROVEN` | Health uses no-prompt LocalAuthentication availability; protected execute requires fresh Touch ID and isolates `op run --env-file=/dev/fd/3 -- child`; no real Touch ID/1Password effect was run |
| Frozen seat packet | `IMPLEMENTED · CORE TESTED` | Schema, `effects:"none"`, `credentials:"forbidden"`, digest, private write, bounded fields, expiry, and protected-intent denial are tested; adapter state-bucket and replacement denial are source-inspected rather than directly exercised |
| `seat.dispatch` | `CEREMONY STUB` | Legacy UCP dry-run validates a frozen packet; execute denies `CANONICAL_ORCHESTRA_BROKER_REQUIRED` and invokes no model |
| Pattern A `/orchestra` broker | `IMPLEMENTED · LIVE UNPROVEN` | `init`, `status`, and exact-mission-digest `advance` route to one pinned packaged broker without a shell; `/orchestra propose` invokes that broker's internal `publish-intent` verb; no live mission or publication was run |
| Draft PR One Surface | `SIDECAR-ONLY` | `/orchestra propose <mission-id> <absolute-owner-private-details-json>` validates the broker's digest-bound intent and submits it to the shared sidecar; only the sidecar can execute canonical `github.draft_pr.publish.v1`; UCP registers neither that ID nor `git.publish_draft_pr`, and the guard denies direct invocation |
| GitHub check read | `IMPLEMENTED · SOURCE-INSPECTED · LIVE UNPROVEN` | Request binds repository, PR number, and exact expected 40-hex head SHA; the child denies `GITHUB_CHECKS_HEAD_MISMATCH`; no direct adapter test or live read was run |
| Pattern A roster | `SHIPPED LOCAL-ONLY` | Owner-private local JSON stamp; no remote PR attachment effect |
| Bench reads | `SHIPPED · BLOCKED` | Fresh health says `missing_config`; registry test proves named missing config and no Markdown fallback; no live read |
| Customer tenant binding | `IMPLEMENTED · TESTED` | Bench reads, CS grant, mesh mint, and mesh verify require a bounded request `instanceId` matching `EXCALIBUR_INSTANCE_ID`/`BENCHAGI_INSTANCE_ID`; missing, placeholder/bulk, and mismatched scopes have named denials and direct coverage |
| CS grant | `CEREMONY STUB` | Dry-run validates exact fields; live execute denies `BENCH_CS_GRANT_BROKER_REQUIRED` |
| Mesh public health | `SHIPPED · OBSERVED LIVE · LOCKED` | Fresh public control and DERP probes returned HTTP 200, but the row remains locked; this does not prove admin/customer readiness or isolation |
| Local mesh node status | `SHIPPED · EFFECT RUN UNPROVEN` | Adapter reads local Tailscale self posture; fresh role derivation is separate evidence |
| Mesh customer verify | `SHIPPED · LIVE ADMIN UNPROVEN` | Adapter can match node name plus tenant tag with 1Password admin access; no live protected run |
| Mesh preauth mint | `CEREMONY STUB` | Dry-run enforces numeric user, tenant tag, `reusable:false`, TTL ≤900; live execute denies `MESH_PREAUTH_BROKER_REQUIRED`; no key created |
| Mail doctor/draft | `SHIPPED LOCAL-ONLY · LIVE EFFECT UNPROVEN` | Local directory probe and owner-private `.eml` adapter exist; no provider draft path |
| `mail.send` | `HARD DENIED · TESTED` | Durable denial `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED`; no send broker or external-send grant path |
| Merge / ready / release / deploy / live | `NOT PERFORMED` | No UCP effect exposes these transitions |

## Fresh health-card truth

The run at `2026-07-15T04:53:11Z` completed with `fullyReady:false`, nine blockers, zero `secretUses`, and no open grants:

| Row | Fresh result | What it proves |
|---|---|---|
| Identity | MacBook `node:macbook`, tailnet IP `100.64.0.1` | The misleading tailnet brain name did not override observed IP role |
| OpenClaw gateway | HTTP 200 at exact target `100.64.0.3:18789`, but `locked` / unauthenticated | Public reachability is not authenticated OpenClaw capability |
| Slack owner | `locked` | Expected mini1-at-rest doctrine shown; actual socket owner still needs a typed probe |
| Remote memory MCP | unreachable / `blocked` | Older TD2 memory-green evidence is not current for this session |
| Bench/Chassis | `missing_config` | Named 1Password/config reference required; no Markdown fallback |
| Flyway | control and DERP HTTP 200, but overall `locked` | Admin access is missing; tunnel, customer join, and isolation are not inferred |
| GateKeeper | 1Password present and Touch ID available, but `locked` | Availability was checked without prompting; no secret was accessed |
| GitHub | unverified / `locked` | No ambient `gh auth` was consumed and no identity or publisher readiness is claimed |
| MCP matrix | `locked` | MCP capability was not authenticated for this session |
| Operator policy | unverified / `missing` | Effective policy could not be established from the native profile in this process |

The card's final claim correctly refused full customer-onboarding capability.

## Current topology and source conflicts

Expected at-rest topology remains:

- mini1/aerie `100.64.0.3:18789` is primary brain and default Slack owner;
- MacBook `100.64.0.1` is a node and loopback may be a forward;
- Mini2 `100.64.0.10` is the fenced hot twin, never a concurrent second Slack socket;
- CarbonWhite `100.64.0.2` is embedding/reranking compute, not gateway;
- later live mesh records use DERP region 901 and `control-bench` on port `8443`.

Still unresolved by documentation or public reachability:

1. Pre-deploy handoffs say LAN-only/templates while later records say off-LAN live.
2. Older material omits `:8443`; later live material includes it.
3. Older material retains DERP 999; later material says it is disabled.
4. The health card does not yet probe actual Slack socket ownership, reverse-tunnel state, Headscale config, or CarbonWhite independently.
5. The registry does not automatically run health or universally deny an effect because the card has blockers; operators must run and honor `excalibur health`.

Do not guess-resolve production state from these sources.

## Runtime secret-store divergence

UCP config accepts only `op://vault/item/field` references, and GateKeeper's intended operator path is 1Password plus Touch ID.

Existing runtime truth remains divergent:

- a live Headscale broker credential has existed in GCP Secret Manager;
- memory API runtime secrets have existed in GCP Secret Manager;
- remote MCP/device keys have existed in mini service configuration as well as 1Password;
- a DNS admin credential is documented in 1Password.

The current health card does not inspect or reconcile those platform stores. No copying, retrieval, rotation, or deletion is authorized. Light still needs to decide whether 1Password is the sole canonical store with explicit runtime brokers/mirrors or whether a migration is required.

Durable mission bundles are disabled. Grants bind the exact effect ID and SHA-256 digest of `{effectId,input}` for at most 15 minutes; every current secret access remains per-access with fresh Touch ID. The digest fixes any target/tenant carried in the input even though the grant has no separate semantic target or secret-reference field.

## Customer readiness truth

- **Web CS:** preferred first path, currently blocked on Bench `missing_config` for live UCP reads.
- **Customer effect scope:** one syntactically bounded selected instance is mandatory. Missing scope, reserved `all` / `any` / `bulk` / `default` / `global` / `operator-local` / `unbound` values, and mismatches are denied.
- **CS mutation:** `bench.cs.grant` is a ceremony stub. Use the existing human web-first admin lifecycle; do not claim UCP grant capability.
- **Mesh public edges:** control and DERP returned HTTP 200, while the health row remained locked.
- **Mesh mint:** ceremony stub; no preauth key was created.
- **Mesh admin verify:** shipped but no real 1Password/Headscale execution performed.
- **Customer multitenancy:** `DESIGNED_UNPROVEN`. A second-tenant denial at enrollment, routing, and memory authentication is still absent.
- **Headscale join as web membership:** false.
- **Internal CS Mac as customer bridge:** prohibited.

## TD2 boundary closure

| TD2 boundary | Typed route | Current proof |
|---|---|---|
| `GIT_PUSH_DENIED` | `/orchestra propose` → pinned broker `publish-intent` → shared sidecar `github.draft_pr.publish.v1` | UCP has no draft-publication ID or executor; live push/PR belongs only to the exact sidecar proposal/approval broker and remains unperformed |
| `UNBOUNDED_ORCHESTRA_PACKET_DENIED` | `packet.freeze` + `/orchestra init|advance` | Frozen packet behavior is covered by the current suite; UCP dispatch stub denies; packaged broker live mission unproven |
| `OUTBOUND_MESSAGE_DENIED` | `mail.doctor` + local `mail.draft` | Local adapters shipped; `mail.send` hard denied |
| `REMOTE_HOST_EFFECT_DENIED` | `mesh.*` | Public probes returned HTTP 200 while the row stayed locked; admin verify is unproven and mint is a stub |
| `SECRET_MANAGER_ACCESS_DENIED` | GateKeeper + 1Password refs | Code present; real biometric/1Password access unperformed |
| Approved path absent/opaque | `excalibur effects`, receipts, named denial codes | Registry/CLI implemented and tested |
| Chassis snapshot mistaken for truth | Authenticated Bench adapters | Honest `missing_config`; no live read |
| MCP partial | Independent health rows | Fresh card reports OpenClaw locked, memory blocked, and MCP locked |

## Proof checklist

- [x] Build passes.
- [x] Current UCP suite passes 21/21.
- [x] `ucp-smoke.sh` passes the local UCP boundary checks, confirms draft publication is absent from UCP, and performs no mutation.
- [x] Full v2 regression suite passes 321/321, package smoke passes 42/42, and the package canary passes.
- [x] Aurelius operator guard and launcher suite passes 35/35.
- [x] Guard and CLI non-hard-denied effect sets match exactly at 19/19; direct `github.draft_pr.publish.v1` and `git.publish_draft_pr` invocation is denied.
- [x] Fresh health card runs, identifies the MacBook as a node, reports nine blockers, and records zero secret uses.
- [x] Bench missing config is explicit and does not fall back to Markdown.
- [x] `mail.send` is hard denied with a named durable receipt.
- [x] Frozen packets keep effects/credentials absent and deny protected active intent.
- [ ] Replace or retire the legacy packet text regex if quoted discussion of protected commands must be accepted; it is conservative rather than a semantic tool/target parser.
- [ ] Exercise real Touch ID plus real 1Password child-only access.
- [ ] Exercise one bounded live mission through `/orchestra init` and exact-digest `/orchestra advance`; UCP `seat.dispatch` must remain a denial stub.
- [ ] Perform and verify one live draft PR publish, with no ready/merge/deploy.
- [x] Bind protected UCP grants to the exact request digest and a recent matching `dry_run` receipt; operator review remains a required procedure.
- [x] Bind `github.watch_checks` to repository, PR number, and an expected 40-hex head SHA.
- [ ] Add direct tests for CLI matching-receipt grant issuance, check-head mismatch, and packet/stamp adapter output-bucket replacement rules.
- [ ] Configure and exercise one live Bench read.
- [ ] Bind and exercise the CS grant broker.
- [ ] Exercise live Headscale admin verification.
- [ ] Bind and exercise a non-rendering mesh mint broker.
- [ ] Prove second-tenant denial.
- [ ] Exercise local mail draft if desired; external send remains out of scope.

## Live-effect prohibitions for this checkpoint

Keep these statements explicit:

- Live GitHub publish was **not performed**; UCP has no draft-publication effect or executor, and only `/orchestra propose` through the pinned broker's `publish-intent` verb and the sidecar proposal/approval path may publish.
- Real biometric/1Password materialization was **not performed**.
- Bounded live Pattern A dispatch was **not performed**; UCP `seat.dispatch` cannot invoke a model.
- Live Bench read was **not performed**.
- Live CS grant was **not performed** and the effect is a stub.
- Live mesh admin verify was **not performed**.
- Live mesh mint was **not performed** and the effect is a stub.
- External mail send was **not performed** and is hard denied.
- Merge, ready-for-review, release, deploy, and live were **not performed**.

## Light decisions / residual owners

| Decision or residual | Owner | Exit condition |
|---|---|---|
| Runtime secret custody and approved runtime broker/mirror doctrine | Light + service owners | Written provider mapping and migration/broker decision |
| Local grant/receipt integrity | UCP implementation owner + Light | Adopt cryptographic/broker attestation or explicitly accept the local-owner trust model; timestamp/schema/file-safety validation alone is not non-repudiation |
| Direct UCP coverage gaps | UCP implementation owner | Exercise grant-receipt issuance, check-head mismatch, and adapter state-bucket/non-overwrite paths directly |
| Real GateKeeper proof | Light | Fresh test run plus one approved real Touch ID/1Password canary with zero-value receipt |
| Legacy packet intent parser | UCP implementation owner | Quoted prose is not false-denied and executable tool/target classes are covered, or the validator is formally retired behind `/orchestra` |
| CS grant broker | Bench owner + Light | Reviewed tenant-bound broker replaces ceremony stub and has before/after proof |
| Mesh mint broker | Mesh owner + Light | Reviewed non-rendering broker replaces ceremony stub and has expiry/revocation proof |
| Second-tenant isolation | Mesh/Bench owners | Denial proven at enrollment, routing, and memory auth |
| Live gateway mutation | Cory/Aurelius | Explicit handoff and decision record; ownership restored after work |
| Previously recorded credential-exposure rotation recommendation | Credential owner | Rotation independently confirmed without disclosing the value |
| mini1 power-loss/FileVault recovery gap | Infrastructure owner | Approved mitigation and reboot proof |

## State reminder

Effect `succeeded` ≠ delivery `live`.

`prepared` ≠ `pushed` ≠ `draft_pr` ≠ `ready_pr` ≠ `merged` ≠ `deployed` ≠ `live`.
