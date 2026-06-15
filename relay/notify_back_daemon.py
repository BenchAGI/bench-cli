#!/usr/bin/env python3
"""notify_back_daemon.py — in-app NOTIFY-BACK.

Posts an UNPROMPTED assistant follow-up into a console chat thread when work
spawned from that thread (a Forge session, a PR) reaches a terminal state, so
the operator sees "✅ done" without having to ask (closes the PR-#1996 silence).

Reads the link docs the cloud writes at spawn-time
(instances/{id}/sessionFollowups, status='pending'), watches each link's workRef
to a terminal state, then posts the follow-up using the SAME Firestore write
shape as the cloud `createOrUpdateChatSession` (role:assistant, kind:'followup',
messageId='followup_<workRef>' — idempotent), and flips the link to 'posted'.

Run ONCE per invocation (launchd StartInterval). Non-fatal per link. Reuses the
agent-chat-runtime .env (SA, INSTANCE_ID, project) and venv.
"""
import os
import sys
import json
import subprocess
from datetime import datetime, timezone

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.oauth2 import service_account

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("NOTIFY_BACK_PR_REPO", "BenchAGI/BenchAGI_Mono_Repo")
FORGE_TERMINAL = {"done", "failed", "cancelled"}


def _parse_iso8601(s):
    """Parse a gh ISO8601 timestamp (e.g. 2026-06-13T15:04:05Z) into a tz-aware
    datetime, or None. gh emits a trailing 'Z'; normalize it to +00:00."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _as_aware_dt(v):
    """Coerce a Firestore createdAt (DatetimeWithNanoseconds / datetime) to a
    tz-aware datetime, or None. Naive values are assumed UTC."""
    if isinstance(v, datetime):
        return v if v.tzinfo is not None else v.replace(tzinfo=timezone.utc)
    return None


def load_env() -> dict:
    env = {}
    with open(os.path.join(HERE, ".env")) as fh:
        for line in fh:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v
    return env


def gh_pr_state(workref: str):
    try:
        out = subprocess.run(
            ["gh", "pr", "view", str(workref), "-R", REPO,
             "--json", "state,title,url,mergedAt,closedAt"],
            capture_output=True, text=True, timeout=25,
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except Exception:
        return None


def followup_decision(link: dict, db):
    """Decide what to do with a pending link. Returns a (action, text) tuple:

        ("post", text)   → post `text` as the in-chat follow-up, flip 'posted'
        ("cancel", None) → don't post; flip the link to 'cancelled' (won't
                           re-check). Used when a referenced PR was ALREADY
                           terminal when the link was created (a mere mention,
                           not work that completed after being linked).
        (None, None)     → not terminal yet; keep 'pending', re-check next cycle.
    """
    wt = link.get("workType")
    ref = str(link.get("workRef") or "")
    if not ref:
        return (None, None)
    if wt == "forge":
        snap = db.collection("forgeAgentSessions").document(ref).get()
        if not snap.exists:
            return (None, None)
        d = snap.to_dict() or {}
        st = d.get("status")
        name = d.get("name") or ref
        if st not in FORGE_TERMINAL:
            return (None, None)
        if st == "done":
            return ("post", f"✅ Forge session “{name}” finished.")
        if st == "failed":
            return ("post", f"⚠️ Forge session “{name}” failed.")
        return ("post", f"🛑 Forge session “{name}” was cancelled.")
    if wt == "pr":
        pr = gh_pr_state(ref)
        if not pr:
            return (None, None)
        state = pr.get("state")
        title = (pr.get("title") or "").strip()
        url = pr.get("url") or ""
        if state == "MERGED":
            terminal_at = _parse_iso8601(pr.get("mergedAt"))
            text = f"✅ PR #{ref} merged — {title}\n{url}"
        elif state == "CLOSED":
            terminal_at = _parse_iso8601(pr.get("closedAt"))
            text = f"PR #{ref} closed (not merged) — {title}\n{url}"
        else:
            return (None, None)  # still OPEN — wait

        # Created-after gate: only post when the PR became terminal AFTER this
        # link was created (it was open when linked, then completed — the real
        # "✅ done" case). If it was already terminal when merely referenced,
        # cancel the link instead of firing a spurious follow-up.
        created_at = _as_aware_dt(link.get("createdAt"))
        if terminal_at is not None and created_at is not None:
            if terminal_at > created_at:
                return ("post", text)
            return ("cancel", None)
        # Missing/unparseable timestamp(s): can't prove a real completion, so be
        # conservative and don't fire a spurious follow-up — cancel the link.
        return ("cancel", None)
    return (None, None)  # 'workflow' not wired yet


def post_followup(db, link: dict, text: str) -> str:
    """Replicate the cloud createOrUpdateChatSession write (session upsert +
    message set with kind:'followup'), idempotent on followup_<workRef>."""
    instance_id = link["instanceId"]
    session_id = link["sessionId"]
    work_ref = str(link["workRef"])
    message_id = ("followup_" + work_ref)[:1500]
    session_ref = db.document(f"instances/{instance_id}/agentChatSessions/{session_id}")
    message_ref = db.document(
        f"instances/{instance_id}/agentChatSessions/{session_id}/messages/{message_id}"
    )
    transaction = db.transaction()

    @firestore.transactional
    def _txn(tx):
        snap = session_ref.get(transaction=tx)
        if not snap.exists:
            tx.set(session_ref, {
                "sessionId": session_id,
                "instanceId": instance_id,
                "agentId": link.get("agentId", "aurelius"),
                "userId": link.get("userId", ""),
                "title": None,
                "status": "active",
                "startedAt": firestore.SERVER_TIMESTAMP,
                "lastMessageAt": firestore.SERVER_TIMESTAMP,
                "messageCount": 1,
                "modality": "text",
                "preview": None,
                "label": None,
            })
        else:
            tx.update(session_ref, {
                "messageCount": firestore.Increment(1),
                "lastMessageAt": firestore.SERVER_TIMESTAMP,
            })
        tx.set(message_ref, {
            "messageId": message_id,
            "sessionId": session_id,
            "role": "assistant",
            "text": text,
            "ts": firestore.SERVER_TIMESTAMP,
            "kind": "followup",
        })

    _txn(transaction)
    return message_id


def main() -> int:
    env = load_env()
    db = firestore.Client(
        project=env["FIREBASE_PROJECT_ID"],
        credentials=service_account.Credentials.from_service_account_file(
            os.path.expanduser(env["FIREBASE_SERVICE_ACCOUNT_PATH"])
        ),
    )
    instance_id = env["INSTANCE_ID"]
    links = (
        db.collection(f"instances/{instance_id}/sessionFollowups")
        .where(filter=FieldFilter("status", "==", "pending"))
        .stream()
    )
    seen = posted = cancelled = 0
    for snap in links:
        seen += 1
        link = snap.to_dict() or {}
        try:
            action, text = followup_decision(link, db)
            if action == "cancel":
                # PR was already terminal when merely referenced (not work that
                # completed after being linked) — flip to 'cancelled' so it's
                # not re-checked, and post nothing.
                snap.reference.update({
                    "status": "cancelled",
                    "cancelledAt": firestore.SERVER_TIMESTAMP,
                    "cancelReason": "already-terminal-when-linked",
                })
                cancelled += 1
                print(f"[notify-back] cancelled {link.get('workType')}:{link.get('workRef')} "
                      f"(already terminal when linked) link {snap.id}")
                continue
            if action != "post" or not text:
                continue  # not terminal yet — re-check next cycle
            mid = post_followup(db, link, text)
            snap.reference.update({
                "status": "posted",
                "postedMessageId": mid,
                "postedAt": firestore.SERVER_TIMESTAMP,
            })
            posted += 1
            print(f"[notify-back] posted {link.get('workType')}:{link.get('workRef')} "
                  f"-> session {link.get('sessionId')} msg {mid}")
        except Exception as exc:  # noqa: BLE001 — one bad link must not block others
            print(f"[notify-back] ERROR link {snap.id}: {exc}", file=sys.stderr)
    print(f"[notify-back] done: seen={seen} posted={posted} cancelled={cancelled}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
