# Unified Control Plane operator runbook

**Audience:** Light and an Excalibur CLI session acting under Light's grants<br>
**Default posture:** observe, prepare, and stop<br>
**Terminal human decisions:** external send, ready-for-review, merge, release, deploy, and production declaration

The typed registry, CLI, receipts, grants, health card, and bounded adapters are implemented. Main Excalibur conversation boot/resume prints the UCP card; `excalibur effects` reports definition availability and `excalibur health` reruns runtime posture. None of those observations proves a protected live effect has been exercised.

## 1. Five-second boot decision

Run both commands before promising an outcome:

```bash
excalibur effects
excalibur health
```

Read these rows first:

1. **Identity and role:** local host, tailnet IP, and derived role.
2. **Gateway:** expected target plus public HTTP status only. `locked` means reachability was seen without consuming identity/auth. On the MacBook, loopback may be a forward to mini1.
3. **Slack owner:** current card reports this `locked`; it does not yet probe the actual socket owner.
4. **Bench:** state is `missing` with a `missing_config` summary until API base and `op://` reference are configured.
5. **Mesh:** public control/DERP edge reachability only; admin and multitenant claims remain separate.
6. **GateKeeper:** CLI and Touch ID availability as `locked` or `missing`. Runtime secret-store divergence is a documented residual, not a dedicated card row.
7. **GitHub:** unverified or explicitly declared display metadata only. Health never invokes ambient `gh auth`; the row remains locked.
8. **MCP matrix:** metadata/public OpenClaw and remote-memory probes plus locked GitHub posture; Slack/Playwright remain unverified.
9. **Modes and grants:** ambient modes plus open grant IDs.

The fresh 2026-07-15T04:53:11Z run used zero `secretUses`, found no open grants, derived `node:macbook` at `100.64.0.1`, observed the exact mini1 OpenClaw target at HTTP 200 but kept it locked/unauthed, kept Slack ownership locked, found memory unreachable, reported Bench `missing_config`, observed mesh control and DERP HTTP 200 but kept Flyway locked, found 1Password present and Touch ID available without prompting while keeping GateKeeper locked, kept GitHub/MCP locked, and reported operator policy missing. It returned nine blockers and `fullyReady:false`.

### Promise rules

| Health result | What the session may say |
|---|---|
| Web/Bench live; mesh absent | “I can verify the web CS path; mesh is optional and not currently proven.” |
| Bench `missing_config` | “I can prepare the onboarding packet, but live tenant truth is blocked on the named config reference.” |
| Mesh public probes 200; row locked | “Public mesh edges respond; admin readiness, customer join, and general isolation are not established.” |
| GitHub locked/unverified | “I can prepare the local branch and publication metadata, not claim live publishing or an authenticated GitHub identity.” |
| Mail doctor unavailable/fenced | “I can prepare a private recap draft, not send it.” |
| Any aggregate/unknown status | State the unknown row; do not claim full onboarding or publishing capability |

## 2. Interpreting topology

Expected at-rest topology:

- mini1/aerie `100.64.0.3` is the brain and default Slack bridge owner;
- the MacBook `100.64.0.1` is a node, even if its tailnet name says `aurelius-brain`;
- Mini2 `100.64.0.10` is an armed hot twin, not a second active Slack owner;
- CarbonWhite `100.64.0.2` is compute for memory embedding/reranking, not the brain;
- the observed live mesh design uses public DERP region 901 and a control proxy on `control-bench` with port `8443`.

If a probe conflicts with this expected state, record `TOPOLOGY_DRIFT`. Do not restart services, repoint the gateway, enable native Slack, change DERP config, or “repair” ownership from a Codex seat. Live gateway mutation requires an explicit Cory/Aurelius handoff.

## 3. Fail-closed secret ceremony

Use this sequence whenever an effect declares a secret reference.

### Preflight

Write down, without values:

- target system and owner;
- intended outcome;
- exact vault/item/field or attachment references;
- test, live, or both;
- effect, target, and tenant that may consume each reference;
- local reversible work that can continue without access;
- external effects and rollback;
- requested TTL.

### Materialization

1. Confirm the pinned `$HOME/.config/excalibur/ucp.json` contains the intended `op://vault/item/field` reference and passes owner/non-symlink/parent safety checks. The card does not detect all external runtime stores; compare against the documented divergence and never copy a value between stores as an improvisation.
2. Show Light the metadata-only request and exact effect scope.
3. Require fresh Touch ID/OS user presence. An unlocked `op` session or a grant file alone is insufficient evidence.
4. GateKeeper invokes `op run --env-file=/dev/fd/3 -- <child>` so the parent never receives the value. Never run raw `op item get --format json` into output.
5. The child receives one named environment value; the secret is never in argv, a temp file, clipboard, or shell history.
6. Run one effect and inspect the value-free `secretUses` audit in its receipt.

### Grants and mission bundles

For `mutate-tenant` or `outbound-draft`, first review a successful dry-run receipt. Within 15 minutes, issue a grant with `--receipt <receiptId>`, the exact effect ID and 64-hex `requestDigest`, a bounded purpose, and TTL at most 900 seconds. Issuance rejects a receipt whose status, age, effect, or digest does not match and stores `sourceReceiptId`. Execute the unchanged request with `--grant <id>`; changing the effect ID or any input changes the digest and invalidates the grant. Touch ID is required both when issuing the grant and when starting the protected execution.

```text
excalibur grant issue --mode <mode> --effect <id> \
  --request-digest <64-lowercase-hex> --receipt <dry-run-receipt-id> \
  --ttl <1..900> --purpose <text> [--json]
```

Durable mission bundles are not available. Supplying `--mission-secret-bundle` is denied with `UCP_MISSION_BUNDLE_UNAVAILABLE`; every current secret access remains per-access. A protected execution that also consumes a secret may reuse only its same-process, same-effect, single-use presence token within 60 seconds.

### Owner-only wall

If a passkey, 2FA device, trusted browser, or owner console blocks progress, stop automation. Ask the owner to save the least-privilege artifact into the named 1Password item and reply “done.” Continue local reversible work meanwhile. Never request the value in chat, mail, Slack, or a screenshot.

## 4. First customer call: web CS path

Use [`cs-web-ready`](./CUSTOMER-PLAYBOOKS.md#3-playbook-cs-web-ready).

1. Capture only the minimum tenant/principal/record references. Select exactly one `EXCALIBUR_INSTANCE_ID` or `BENCHAGI_INSTANCE_ID`; every customer effect's `instanceId` must match it.
2. Current health says Bench `missing_config`; stop and configure only approved API/reference metadata.
3. Once configured, run authenticated `bench.health` and `bench.cs.instance_summary` with one `instanceId` and per-access GateKeeper.
4. If a grant is needed, use `bench.cs.grant` dry-run only. Live execution is a ceremony stub and always returns `BENCH_CS_GRANT_BROKER_REQUIRED`; perform the existing human web-first admin lifecycle instead.
5. Verify login, instance switcher, CS workbench, and one real record.
6. Stop with a receipt. Do not add mesh by default.

If live Bench is unavailable, prepare a checklist and owner handoff. Do not present a cached Chassis snapshot or markdown file as current deal truth.

## 5. Optional customer mesh

Use [`mesh-then-seat`](./CUSTOMER-PLAYBOOKS.md#4-playbook-mesh-then-seat) only after web readiness.

1. State why mesh is necessary.
2. Classify the device as fleet, operator, or customer.
3. Probe public control/DERP with `mesh.control_health` and local self posture with `mesh.node_status`. These effects do not prove reverse tunnel, Aerie, admin, or tenant isolation.
4. Confirm the selected process instance matches the request `instanceId`, then resolve the correct tenant user; do not reuse tenant-zero constants.
5. Dry-run `mesh.preauth.mint` using a numeric user ID, `reusable:false`, TTL at most 900 seconds, and `tag:tenant-...` ACL tag.
6. Stop: mint is a ceremony stub and live execution returns `MESH_PREAUTH_BROKER_REQUIRED`; no key is created or delivered.
7. `mesh.verify_customer_join` is shipped but unproven live. With configured admin access it matches node name plus expected tenant tag only; user, Firebase membership, and Aerie reachability need separate proof.
8. Record `designed_unproven` until second-tenant denial is actually exercised.
9. Never pair the internal CS Mac as the customer OpenClaw bridge.

No current UCP path mints a key. A future broker must preserve direct non-rendering delivery before the stub can be promoted.

## 6. First Pattern A draft PR

Use [`between-call-value`](./CUSTOMER-PLAYBOOKS.md#6-playbook-between-call-value).

### Prepare

1. Frame the pain point as outcome, repository, allowed paths, non-goals, maximum files, tests, proof, and expiry.
2. Create an isolated worktree with `worktree.prepare`.
3. Freeze the packet. Put merge, deploy, send, and secret access in `nonGoals`; the validator rejects protected active intent in `goal` and `proof`.
4. Initialize the owner-private mission through `/orchestra init <absolute-mission-json>`, inspect `/orchestra status <mission-id>`, then advance only with `/orchestra advance <mission-id> <exact-mission-digest>`. The configured packaged broker is the only model-dispatch path. UCP `seat.dispatch` is a compatibility validator whose execute path denies without invoking a model.
5. Implement and test locally.

### Draft proposal

UCP has no draft-publication effect. In particular, neither
`github.draft_pr.publish.v1` nor `git.publish_draft_pr` is a UCP effect. After
`ANVIL_GATED`, write the bounded title/body/empty-label metadata to an
owner-private JSON file and run:

```text
/orchestra propose <mission-id> <absolute-owner-private-details-json>
```

This is the operator-facing command. It invokes the pinned Pattern A broker's
internal `publish-intent` subprocess verb, validates the returned intent,
intent digest, publication-gate digest, and action-binding digest, then asks the
shared sidecar to create the exact approval card. It does not invoke the
publisher itself. The operator guard denies direct attempts to invoke either
removed draft-publication effect ID.

Review:

- allowlisted owner/repository;
- exact worktree, base/head refs and SHAs;
- patch, changed-path, and packet digests;
- exact `missionId`, `missionDigest`, and `publicationGateDigest` from the Pattern A broker;
- title/body/labels and `draftOnly:true`.

Do not proceed if the plan would force-push, create a ready PR, modify a tag, include customer private data, or touch an undeclared path.

No UCP preparation receipt substitutes for the sidecar proposal, approval, or
execution receipt. UCP deliberately has no GitHub draft action or executor.

### Publish

1. Keep the shared sidecar online with `effectsPosture:approval_bound` and the canonical draft publisher capability present.
2. Run `/orchestra propose`; allow the CLI to invoke only the pinned broker's `publish-intent` verb. Never run `git push`, `gh pr create`, or either removed draft-publication ID through UCP.
3. Review the exact server approval card and approve only with the single-use confirmation nonce path.
4. Require the correlated **sidecar execution receipt** for action `github.draft_pr.publish.v1` to report `draft:true`, the exact head SHA, GitHub URL/number, kernel-read publisher login/numeric ID, publisher-config digest, and publisher-identity attestation digest.
5. `github.watch_checks` is another GateKeeper-protected effect. Supply repository, PR number, and exact `expectedHeadSha`; it denies if the live PR head no longer matches before returning checks.
6. Write the roster locally with `stamp.roster`; there is no remote attach effect.
7. Report only independently observed output and stop.

The sidecar broker is the sole live publisher. UCP does not register the draft
action and performs no Git or GitHub mutation.

The end state is `draft_pr`. Green checks do not authorize merge. Merge does not prove deploy. Deploy does not prove live.

## 7. Discovery recap

Use [`discovery-recap-close`](./CUSTOMER-PLAYBOOKS.md#5-playbook-discovery-recap-close).

1. Freeze a factual, privacy-minimized call packet.
2. Run `mail.doctor` before promising a local draft; it checks only the configured draft directory.
3. Dry-run `mail.draft`, issue an `outbound-draft` grant with its receipt ID, exact effect ID, and `requestDigest`, then execute the unchanged request with `--grant <id>` to write one owner-private local `.eml`. Grant issuance and execution each require Touch ID.
4. Obtain human review of facts, promises, recipients, and attachments.
5. Stop at `drafted`.

`mail.send` is hard denied with `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED`. There is no executable external-send grant or broker.

## 8. Denial handling

| Denial | Do next |
|---|---|
| Health `drift` | Preserve both observations, identify the owning operator, and avoid dependent mutation |
| Documented secret-store divergence | Record intended vs runtime provider; request a migration/broker decision, not a value |
| `GATEKEEPER_USER_PRESENCE_UNAVAILABLE` / `...DENIED` | Do not access a secret; repeat only with operator intent |
| `UCP_GRANT_MISSING_OR_EXPIRED` | Issue/pass a fresh exact-effect grant if the effect is approved |
| `UCP_GRANT_RECEIPT_INVALID` | Rerun/review dry-run and cite its matching receipt/digest within 15 minutes |
| `UCP_TENANT_SCOPE_MISSING` / `...INVALID` / `...DENIED` | Stop; select one bounded non-placeholder instance and make the request match it—never retarget implicitly |
| `UCP_MISSION_BUNDLE_UNAVAILABLE` | Use per-access Touch ID; do not create or edit a bundle file |
| `BENCH_CS_GRANT_BROKER_REQUIRED` | Use the existing human admin lifecycle; do not bypass the stub |
| `MESH_PREAUTH_BROKER_REQUIRED` | No key was minted; wait for a reviewed broker |
| `CANONICAL_ORCHESTRA_BROKER_REQUIRED` | Use `/orchestra init|status|advance`; the UCP adapter invoked no model |
| `GITHUB_CHECKS_HEAD_MISMATCH` | Stop; the PR moved from the reviewed SHA and checks are not accepted |
| `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED` | Leave the `.eml` as a private draft; no send path exists |
| Surviving `started` receipt | Treat the effect as indeterminate and inspect the destination before retrying |

Never bypass a typed denial with a wrapper, alternate shell, agent handoff, browser automation, or direct vendor console.

## 9. Current operational residuals

Carry these until fresh evidence closes them:

- Current runtime secrets are split across 1Password, GCP Secret Manager, and mini service configuration. The UCP target does not make that divergence disappear.
- Second-tenant mesh denial is not yet exercised; structural design is not production proof.
- Historical mesh docs conflict on deployment state, control port, and DERP 999. Fresh observation is required.
- The fresh card keeps OpenClaw locked despite HTTP 200, reports remote memory unreachable, and supersedes the older TD2 memory-green snapshot for this session. Slack/Playwright remain unverified.
- Grant issuance now verifies a recent matching dry-run receipt and stores its ID; execution enforces the request digest. `github.watch_checks` now enforces the exact expected head SHA.
- UCP `seat.dispatch` is a fail-closed validator, not the live model transport. The packaged `/orchestra` broker has not been exercised in this proof pass.
- CS grant and mesh mint are ceremony stubs; live execution is denied.
- GateKeeper unit coverage passes in the 21/21 UCP suite, including child-only injection, scrubbed child environments, and presence behavior. Real Touch ID plus real 1Password materialization remains unperformed.
- A prior credential-handling incident recorded a password printed into a transcript and recommended rotation. Do not repeat the value; keep rotation as a residual until independently confirmed.
- mini1 services self-heal after authenticated restart, but a power-loss boot can remain FileVault-locked pending human unlock unless infrastructure closes the gap.

## 10. Closeout

At the end of every mission, report:

```text
Health at execution:
- identity/role:
- gateway/slack owner:
- bench:
- mesh/proof level:
- GateKeeper/provider divergence:
- GitHub/MCP:

Done locally:
- ...

External effects:
- exact typed effects and receipt refs, or none

State reached:
- prepared / drafted / draft_pr / independently observed later state

Blocked or residual:
- owner:
- mechanism:
- exit condition:

Human next step:
- ...
```

Do not include secrets, customer content, recipients, message bodies, raw deal data, or preauth keys.
