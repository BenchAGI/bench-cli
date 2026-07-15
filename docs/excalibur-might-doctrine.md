# Excalibur MIGHT doctrine

Status: normative design record for the BenchAGI operator surface.

## Motive

Excalibur exists to let one accountable human operate BenchAGI with several
reasoning partners at the speed of software, without turning any language model
into an ambient administrator.

The product is successful when Cory can express one bounded mission, let
Aurelius conduct Fable, Sol, Opus, Terra, and Anvil, inspect one exact proposal,
approve once, and receive a durable result. It is not successful merely because
models can chat, write local files, or print shell commands that a human could
run later.

The governing separation is:

1. Models reason and recommend.
2. Bounded seats may read or edit only their declared local worktrees.
3. Deterministic gates establish exact facts.
4. One registered executor performs one approved external effect.
5. Receipts, not model prose, establish what happened.

Increasing Excalibur's power therefore means adding narrow, typed, receipted
channels through the wall. It never means removing the wall.

## MIGHT

MIGHT is the startup and decision contract shown to the operator.

| Letter | Question Excalibur must answer | Authoritative evidence |
| --- | --- | --- |
| **M — Mission** | What exact outcome, repository, paths, limits, and session are in scope? | Frozen mission digest and active conversation binding |
| **I — Intelligence** | Which conductor and support models were requested and actually served? | Provider/model attestation and per-seat receipts |
| **G — Grants** | What may happen now, to which target, for how long, and with what approval? | Capability manifest, policy gates, and single-use approval |
| **H — Hands** | Which bounded seats and deterministic executors can do the work? | Seat roster, isolated worktree attestations, and executor identity |
| **T — Truth** | What was proposed, approved, executed, denied, or left indeterminate? | Hash-linked proposal, approval, execution, and reconciliation receipts |

A green component is not permission. A healthy lock is not a blocker. A model
response is not an effect. A queued effect is not a completed effect. A merged
change is not deployed, live, or observed.

## Operator postures

Excalibur exposes four postures. They are computed from evidence; a model may
not choose or narrate them into existence.

| Posture | Meaning | External authority |
| --- | --- | --- |
| **SHADOW** | Inspect local and connected read projections. | None |
| **PREPARE** | Conduct a bounded mission, edit isolated worktrees, run local proof, and freeze a proposal. | None |
| **WIELD** | Execute at least one exact, registered, human-approved effect through its deterministic kernel. | Only the named effect |
| **LAND** | Perform a separately granted release, merge, or deployment ceremony. | Only the separately granted land effect |

WIELD does not imply LAND. The first WIELD effect is draft-only GitHub
publication. It may push one exact approved head and create or reconcile one
draft pull request. It may not mark ready, merge, deploy, force-push, mutate
customers, send messages, reveal secrets, or spend money.

## Pattern A reasoning loop

The canonical organization loop is:

1. **Aurelius / Grok** frames the bounded mission and conducts the sequence.
2. **Fable / Claude** researches and freezes the story, criteria, and non-goals.
3. **Sol / Codex** implements in isolated task worktrees, with at most two
   dependency-ready Sol tasks running concurrently.
4. **Fable** accepts the exact integrated head. A RETURN starts a bounded Sol
   repair round against that exact head; it does not silently broaden scope.
5. **Opus / Claude** and **Terra / Codex** challenge the exact post-acceptance
   head when required by mission policy.
6. **Anvil** deterministically checks ancestry, cleanliness, path and size
   bounds, proof receipts, review freshness, and exact-head identity.
7. **Excalibur** derives publication hashes from Git, renders one complete
   approval card, and sends the unchanged intent to the sidecar broker.
8. The **deterministic draft-PR executor** re-attests Git state, Anvil state,
   publisher identity, remote state, and approval binding immediately before
   every write, then emits a durable receipt.

No support model receives direct GitHub, mail, Slack, deployment, credential,
or customer-mutation authority. There is no “Hammer model” back door: Hammer is
the deterministic draft-publication effect after Anvil and human approval.

## Required bindings

Every draft-publication proposal must bind all of the following:

- operator principal and active conversation;
- repository allowlist entry and exact HTTPS origin;
- canonical integration worktree;
- base ref and base SHA;
- `codex/` head ref and exact head SHA;
- patch digest and sorted changed-path digest;
- mission ID, mission digest, and packet digest;
- exact-head Anvil receipt and publication-gate digest;
- title, body, labels, and `draftOnly: true`;
- deterministic executor ID and policy version;
- dedicated GitHub publisher login, numeric user ID, config digest, credential
  helper digest, and identity-attestation digest;
- single-use approval ID, proposal digest, expiry, and hidden confirmation
  nonce.

Any drift after proposal creation invalidates the approval. An uncertain
provider response becomes `indeterminate` and enters reconciliation; it is
never replayed as a fresh write.

## Permanent hard locks

The following remain unavailable without a distinct capability and explicit
ceremony:

- merge or ready-for-review;
- deployment, infrastructure, or production configuration mutation;
- force-push or protected-branch write;
- external mail, Slack, invite, or customer-facing send;
- customer, CRM, billing, Firebase, or identity mutation;
- secret retrieval or credential disclosure;
- purchasing, spend, or irreversible deletion.

Keyword scanning of model prose is not the safety mechanism. The system
classifies registered tools, targets, payloads, and executor identities. Models
may discuss a forbidden operation; they still cannot invoke it.

## Canonical surface

There is one operator door: **Excalibur One Surface**. The legacy Native,
Control, and CLI Preview apps are diagnostics or historical artifacts, not
alternate authority paths.

The canonical launcher must be self-contained and byte-pinned. It carries one
versioned Node runtime, one CLI closure, one Pattern A broker closure, one
owner-private configuration, and exact hashes. Every click performs a
content-free health/preflight check before opening a conversation. Mutable PATH
discovery, `node-current` aliases, raw provider fallback, and unverified source
paths are prohibited.

The primary orchestra commands are deliberately few:

- `/orchestra prepare` — derive and freeze a mission plus isolated worktrees;
- `/orchestra status` — project durable state and progress;
- `/orchestra advance` — run the next bounded reasoning wave;
- `/orchestra propose` — derive exact publication facts and create the one
  approval-bound draft-PR proposal.

`publish` is reserved for the deterministic executor and is not an operator or
model command alias.

## Operator experience acceptance

A release is not a credible WIELD surface until all of these are true:

1. Startup shows MIGHT with separate core blockers, capability degradations,
   and healthy locks.
2. A minimal mission brief can create all isolated worktrees without manual
   Git hashes or hand-built mission JSON.
3. Long model runs emit durable phase/task/round progress and can be inspected
   without resubmission.
4. Fable RETURN causes a bounded repair round; concurrency and maximum-round
   limits are enforced rather than decorative.
5. The approval card shows the exact title/body, repository, base/head,
   changed-path and packet digests, Pattern A gate, and publisher identity.
6. One approval can produce a draft-PR URL and a hash-linked execution receipt.
7. Repeating the same intent reconciles or replays the same command; it does not
   create a duplicate effect.
8. Git, Anvil, identity, config, resource, remote, approval, or session drift
   fails closed before a write.
9. Merge, deploy, send, secret, spend, customer mutation, and force-push remain
   unavailable.
10. The staged launcher passes a sanitized-PATH smoke test and full
    cross-repository contract tests before installation.

## Product measure

The north-star measure is not number of model calls. It is the time from a
clear human mission to a truthful, reviewable organizational outcome:

- under one minute from an already Anvil-gated local head and approval to a
  returned draft-PR URL under normal provider conditions;
- zero unapproved external writes;
- zero duplicate effects after timeout or retry;
- every external attempt represented by a durable terminal or indeterminate
  receipt;
- every claim of WIELD or LAND backed by current runtime evidence.

That is Excalibur with MIGHT: several excellent minds, bounded hands, one
accountable human, and no ambiguity about what actually happened.
