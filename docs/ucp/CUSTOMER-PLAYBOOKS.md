# Unified Control Plane customer playbooks

**Status:** operational contracts aligned to the implemented adapters and current proof<br>
**Machine-readable companions:** [`playbooks/`](./playbooks/) are declarative plans, not direct `excalibur effect` request files<br>
**Default:** stop at the first failed health, tenant, grant, or receipt gate

## 1. Shared doctrine

- Start with the customer's web experience. Mesh and CLI access are optional accelerators, not prerequisites for useful CS.
- A mesh node is not a Firebase user, portfolio member, CS grant, or Bench instance entitlement.
- Never pair an internal CS Mac as the customer's OpenClaw bridge. Classify every enrollment as `fleet`, `operator`, or `customer` before minting.
- Use live Bench/Chassis reads for tenant truth. Markdown, screenshots, fixture data, and cached Chassis files are context only.
- Keep tenant scope to one explicit instance. For Bench and customer-mesh effects, the request `instanceId` must equal the selected `EXCALIBUR_INSTANCE_ID` or `BENCHAGI_INSTANCE_ID` process scope. Never bulk-enumerate or export customer data in an onboarding playbook.
- Keep customer content, names, emails, deal notes, and record bodies out of documentation and receipts. Adapters may persist only bounded operational identifiers needed for audit, such as `instanceId`, principal, user/node/tag references, or a private draft path.
- Every secret materialization requires the GateKeeper ceremony. If a future key-delivery broker is added, the key must go directly to its consumer and never render in the terminal; the current mesh mint path creates no key.
- Grants for protected non-secret modes require a matching successful dry-run receipt from the prior 15 minutes and bind its receipt ID, exact effect ID, and request digest. Durable mission bundles are disabled; secret use remains per-access.
- A recap is a draft until a human approves a separate send.
- A pull request remains draft until a human-controlled land path takes over. Merge, deploy, and live proof are separate states.
- If the human markdown, JSON companion, registry definition, and adapter disagree, execution fails closed. The implemented definition/adapter is the authority for what can run; the docs must then be repaired.

## 2. Status and proof language

| Label | Meaning |
|---|---|
| `ready` | All playbook exit criteria were freshly observed |
| `prepared` | Local artifact exists; no remote effect is implied |
| `drafted` | Owner-private local `.eml` draft exists; nothing was sent |
| `draft_pr` | The correlated sidecar execution receipt and GitHub both report a draft PR for the exact approved head SHA |
| `designed_unproven` | Architecture supports the property, but required live denial/proof is missing |
| `blocked` | A named owner, mechanism, and exit condition are recorded |
| `live` | Production endpoint/version was independently smoked |

Do not substitute “configured,” “merged,” or “deployed” for `live`.

## 3. Playbook: `cs-web-ready`

### Outcome

An authorized customer or CS operator can sign in, select the intended instance, open the CS workbench, and read one real tenant-scoped record through the live Bench path. Mesh is not required.

### Inputs

- one opaque instance/tenant reference;
- one principal reference and intended least-privilege role;
- one opaque record reference for verification;
- explicit approval for any missing membership or CS flag change.

Do not place names, emails, contact data, deal notes, values, or credential material in the packet or receipt.

### Procedure

1. Run `excalibur health`.
2. Select one explicit process instance scope and require the request `instanceId` to match it. Require Bench configuration, then run `bench.health` with that `instanceId`; this is an authenticated `secret-use` read. The fresh card currently reports `missing_config`, so the playbook stops here today. Do not use markdown as a fallback.
3. When configured, run `bench.cs.instance_summary` with the same `instanceId`. Its implemented API read can provide deployment status; login, switcher, and customer-facing workbench still require separate web verification.
4. If the principal already has the exact required access, do not mutate.
5. If access is missing, prepare `bench.cs.grant` with `instanceId`, `principal`, and `customerSuccessEnabled:true`. Its dry-run validates the request under ambient `prepare`.
6. Stop after the dry-run. `bench.cs.grant` is a `ceremony_stub`; live `--execute` always denies with `BENCH_CS_GRANT_BROKER_REQUIRED`. Use the existing human web-first admin lifecycle until a reviewed broker is bound, then read the summary back.
7. Open the web path as the intended user or through an approved support verification path.
8. Read one real, scoped record through the live API. Record only success and an opaque reference.
9. Write the closeout receipt and stop. Do not add mesh merely because the web path is ready.

### Exit criteria

- Bench/Chassis source is `live`, not `stub`, cache, or markdown.
- Intended principal can authenticate.
- Intended instance appears in the switcher and no unrelated instance is exposed.
- CS workbench is available with the approved least-privilege role/flag.
- One real tenant-scoped record loads.
- Any mutation has before/after proof and a secret-free receipt.
- Mesh status is explicitly `not_required`, `deferred`, or separately proven.

### Stop conditions

- Tenant reference is missing or ambiguous.
- Live Bench config is missing or disagrees with the intended instance.
- Grant would affect more than one instance or principal.
- Operator cannot verify the customer-facing path.
- A request attempts to treat a mesh join as web membership.
- A live CS mutation is requested from the current ceremony stub.

## 4. Playbook: `mesh-then-seat`

### Outcome

After the web CS path is ready, a device with a documented need joins the correct Flyway using a single-use key, is verified against the expected tenant, and only then proceeds to the appropriate CLI/seat handoff.

### Current proof limitation

The audited material documents tenant-zero plus a structural isolation design, but not a live second-tenant denial. Until that denial is exercised at enrollment, routing, and memory authentication boundaries, new-customer mesh status is `designed_unproven`. Unsupervised general rollout is blocked; a separately approved supervised pilot may proceed only with explicit residual acceptance.

### Inputs

- completed `cs-web-ready` receipt;
- one tenant and numeric Headscale user resolved from tenant configuration;
- device class: `fleet`, `operator`, or `customer`;
- expected device/node reference;
- business reason mesh is necessary;
- explicit approval for the validation; a future live broker would also require exact-request secret and tenant-mutation authority.

### Procedure

1. Verify the `cs-web-ready` receipt and confirm mesh is actually needed.
2. Run `excalibur health`, `mesh.control_health`, and `mesh.node_status`.
3. Treat `mesh.control_health` as public control/DERP edge reachability only. It does not prove TLS policy, the reverse tunnel, Headscale admin, Aerie health, or customer readiness. Any historical conflict still requires an owner probe outside this effect before mutation.
4. Confirm device classification. Deny any attempt to pair an internal CS Mac as a customer bridge.
5. Resolve the tenant's numeric Headscale user from approved config; never hardcode tenant-zero's user ID for a customer.
6. Dry-run `mesh.preauth.mint` with `instanceId`, numeric-string `headscaleUserId`, `reusable:false`, `ttlSeconds` 1–900, and at least one `tag:tenant-...` ACL tag.
7. Stop. The mint effect is a `ceremony_stub`; live `--execute` always denies with `MESH_PREAUTH_BROKER_REQUIRED`, so no key is created or available for delivery.
8. `mesh.verify_customer_join` is shipped but live admin access is unproven. Its `instanceId` must match the selected process scope. When configured and biometric-gated, it can match `nodeName` plus `expectedTag`; it does not verify Headscale user, Firebase membership, Aerie reachability, or cross-tenant denial.
9. Verify web membership remains correct; mesh did not create or alter it.
10. Proceed to the documented CLI/customer-seat handoff only after the web and mesh checks are independently green. UCP `seat.dispatch` is only a legacy bounded-packet/repository-root validator whose execute path denies; it is neither the live `/orchestra` model transport nor customer account provisioning.
11. A future broker must expire/revoke its key through the approved owner path and write a value-free receipt. That live step is not present today.

### Exit criteria

- Web CS readiness was proven first.
- Device class and tenant are explicit.
- Mint request dry-run enforced single-use, non-reusable, and no longer than 15 minutes; no claim is made that a key exists.
- No key value entered output, logs, chat, clipboard history, or receipt because no key was minted.
- Future live proof must show the expected node and tenant tag; current admin verification remains unproven.
- Aerie reachability requires separate proof; `mesh.verify_customer_join` does not test it.
- Isolation proof level is explicitly recorded.
- No internal CS bridge was paired as the customer bridge.

### Stop conditions

- Web readiness is absent.
- Mesh control or tunnel state is unknown or drifting.
- Safe key delivery is unavailable.
- Tenant/user resolution is ambiguous.
- General customer rollout is requested while second-tenant denial remains unproven.
- Live mint is requested from the current ceremony stub.

## 5. Playbook: `discovery-recap-close`

### Outcome

A discovery or onboarding call becomes a factual internal packet and a human-reviewable recap draft. Nothing is externally sent.

### Inputs

- private call notes held in the approved working location;
- one tenant/customer reference;
- intended audience class, not recipient details in the receipt;
- known decisions, open questions, owner, and due dates.

### Procedure

1. Run `session.health_card` and confirm the session can prepare local artifacts.
2. Create a bounded packet with goals, facts, decisions, risks, owners, and follow-ups. Separate observed facts from assumptions.
3. Use `packet.freeze` to validate that the packet contains no credentials or effects. Put “send” in `nonGoals`, not active `goal`/`proof`, because those fields conservatively reject protected-effect intent.
4. Run `mail.doctor`. It checks only the configured local draft directory; it does not inspect a mailbox or provider identity.
5. Dry-run `mail.draft`, then issue an `outbound-draft` grant with that receipt ID and its exact `requestDigest`. Use the same request with `--grant <id> --execute`. Grant issuance and protected execution each require Touch ID. The result is an owner-private local `.eml`; there is no provider-hosted draft path.
6. Have a human review customer facts, commitments, recipients, tone, and attachments.
7. Stop with status `drafted`. `mail.send` is hard denied with `MAIL_SEND_SECOND_GRANT_PATH_NOT_SHIPPED`; no send broker exists.

### Exit criteria

- Facts and assumptions are visibly separated.
- Draft reflects only approved commitments.
- Mail readiness is honestly reported.
- Draft identifier or private path is recorded without recipients/body content.
- No external message, invite, or Slack post occurred.
- A human owns the next send decision.

### Stop conditions

- Customer facts cannot be verified.
- Draft would include a secret or unnecessary private data.
- Recipient set is ambiguous.
- Any tool attempts to send under an `outbound-draft` grant.

## 6. Playbook: `between-call-value`

### Outcome

A customer pain point becomes a bounded Pattern A implementation packet and a verified **draft** PR before the next call. A human retains land, release, deploy, and customer-communication authority.

### Pattern A roster

1. Fable frames the story and acceptance evidence.
2. Sol implements in an isolated worktree.
3. Opus reviews when the tier requires it.
4. Terra/Anvil performs the land-adversary review.
5. Light decides whether and when to land.

### Procedure

1. Convert the pain point into a privacy-minimized intake: problem, expected outcome, repository, allowed paths, non-goals, maximum files, tests, and proof.
2. Run `worktree.prepare` with absolute repository/worktree paths, an operator-approved base ref, and a new `codex/` branch. This adapter does not carry a business repository allowlist or base-SHA field; the later draft proposal separately enforces an allowlisted GitHub organization and exact SHAs.
3. Run `packet.freeze`; place merge/deploy/send/secret prohibitions in `nonGoals`. Frozen packets force `effects:"none"` and `credentials:"forbidden"`.
4. Initialize the mission with `/orchestra init <absolute-mission-json>`, then use `/orchestra advance <mission-id> <exact-mission-digest>` for each legal transition. UCP `seat.dispatch` is a fail-closed compatibility validator and cannot invoke a model.
5. Implement and test locally. Record exact gates and residuals.
6. After `ANVIL_GATED`, run `/orchestra propose <mission-id> <absolute-owner-private-details-json>`. UCP registers neither `github.draft_pr.publish.v1` nor `git.publish_draft_pr` and has no draft-publication receipt. The CLI invokes the pinned broker's internal `publish-intent` verb and validates its digest-bound result before asking the shared sidecar for a proposal.
7. Review the exact identity-bound sidecar approval card; only its `[A]` path can consume the hidden single-use nonce. Direct invocation of either removed draft-publication ID is denied by the operator guard.
8. Require the deterministic draft-PR receipt from the shared sidecar.
9. `github.watch_checks` is a GateKeeper-protected read by repository, PR number, and exact `expectedHeadSha`. It denies if GitHub's current PR head differs before returning that commit's checks.
10. `stamp.roster` writes an owner-private local JSON file only. There is no remote stamp attachment effect.
11. Close with only independently observed facts. Live publish/check access remains unproven; do not merge, release, deploy, or claim live value.

### Exit criteria

- Packet is bounded and contains no customer private data or credentials.
- Local tests/smoke and residuals are recorded.
- The identity-bound `/orchestra propose` approval card was reviewed; no UCP receipt is publication authority.
- Remote branch/SHA and draft PR URL are accepted only from the correlated sidecar execution receipt after exact human approval.
- GitHub confirms `draft=true`.
- Check results are described as SHA-bound only when `github.watch_checks` succeeded for the exact expected head.
- Pattern A roles and sit-outs are honest.
- Human land owner is explicit.
- Merge, deploy, and live remain `not_performed` unless independently observed later by another authorized system.

### Stop conditions

- Repository or branch is outside the allowlist.
- Diff exceeds packet paths or maximum files.
- PR body contains a secret or unnecessary customer data.
- Existing PR is ready or merged, or the sidecar proposal/receipt does not correlate to the approved head SHA.
- Any wrapper tries to hide push/merge/deploy inside a broader command.

## 7. Closeout format

Every playbook ends with:

```text
Result:
- status:
- tenant_ref: <opaque reference or none>
- receipt_refs:

Done locally:
- ...

External effects:
- none / exact bounded effect and observed result

Blocked or residual:
- owner:
- mechanism:
- exit condition:

Human next step:
- ...
```

Never include credential values, message bodies, customer notes, contact data, or full deal records in closeout text.
