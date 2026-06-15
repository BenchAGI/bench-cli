"""agent-chat-runtime — local Firestore → OpenClaw → Firestore bridge.

See SKILL.md for doctrine, README.md for setup. Single-file by design for
Phase 1; will split into modules in Phase 2 once dispatch generalizes to
multiple agents and tool-call decomposition lands.

Lifecycle of a single inbound chat event:

    1. Snapshot listener fires on a new `agentChatInbound/{eventId}` doc
       matching INSTANCE_ID and status='pending'.
    2. Submit handler to a bounded thread pool (MAX_CONCURRENT_INBOUND).
    3. Transactionally claim: status pending → processing, stamp claimedAt,
       attach outboundId + agentRunId. Re-read after to avoid clobbering
       a parallel claim (defensive even though there's only one listener
       in Phase 1).
    4. Create the AgentRun doc + first "thinking" step (renders the UI's
       AgentRunBubble immediately).
    5. Create the agentChatOutbound doc (status='streaming').
    6. POST to the OpenClaw gateway with `Accept: text/event-stream`.
       Parse each SSE frame; write chunks/{seq:07d} for every token + event.
    7. On clean stream end: mark outbound completed, inbound completed,
       AgentRun completed with a final 'message' step capturing the
       response length + model used.
    8. On any failure path: mark all three failed, write an error chunk
       so the SSE relay surfaces something to the user, and log loudly.

Doctrine: agent execution stays here, on this machine. The cloud is the
broker; this file is the runtime.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import socket
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import firebase_admin
import httpx
from dotenv import load_dotenv
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

# ── Constants (mirror packages/types/src/agent-chat.ts) ──────────────────

CHUNK_SEQ_PAD = 7  # AGENT_CHAT_CHUNK_SEQ_PAD
MAX_CHUNKS_PER_RESPONSE = 5000  # MAX_AGENT_CHAT_CHUNKS_PER_RESPONSE

# Workflow-session lane (P3) — durable mirror of a multi-agent turn's spawned
# sub-agent SESSIONS. Mirrors packages/types/src/workflow-session.ts.
MAX_WORKFLOW_SESSION_ACTIVITY_ROWS = 40  # MAX_WORKFLOW_SESSION_ACTIVITY_ROWS
# Throttle per-session Firestore writes (full snapshots are last-write-wins, so
# we never lose state by skipping intermediate progress writes). ~1/sec.
WORKFLOW_SESSION_WRITE_INTERVAL_SECONDS = 1.0

# A machine's per-machine presence doc (gatewayStatus/chatRuntime-{id}) is
# considered stale past this — the ONLY window in which a fallback runtime takes
# over a primary-targeted turn. Matches the web's GATEWAY_STATUS_STALE_AFTER_MS.
MACHINE_PRESENCE_STALE_SECONDS = 90.0

# ── Orphan reaper (recover docs a dead runtime left mid-flight) ───────────
# Both listeners watch status=='pending' ONLY, so a doc the runtime flips to
# 'processing' just before a hard death (kill -9, panic, power loss) hangs
# FOREVER — no code path ever revisits a 'processing' doc. The reaper is the
# only thing that revisits them. It runs on a background thread and, for each
# stale 'processing' doc whose claimer's presence is dead, either resets it to
# 'pending' (so the configured fallback's pending-takeover migrates the in-flight
# turn across machines) or marks it 'failed' with a recoverable error chunk (so
# the user sees an error instead of a silent hang).
REAPER_INTERVAL_SECONDS = 30.0
# A 'processing' doc is only a reap candidate once its claim is older than
# this. Derived per-host as REAPER_TTL_MULTIPLIER × gateway_timeout_seconds so
# the TTL always exceeds the longest legitimate turn (Pro=180s→~360s,
# Mini=600s→~1200s), with a hard floor for safety on tiny timeouts.
REAPER_TTL_MULTIPLIER = 2.0
REAPER_TTL_FLOOR_SECONDS = 240.0
# Cap how many stuck docs one sweep touches — keep the reaper cheap and avoid a
# write storm if a backlog of orphans somehow accumulates.
REAPER_MAX_PER_SWEEP = 25

# ── Agent display label map (extend in Phase 2) ──────────────────────────

AGENT_LABEL = {
    "aurelius": "Aurelius",
    "cole": "Cole",
    "sage": "Sage",
    "piper": "Piper",
    "ember": "Ember",
    "bailey": "Bailey",
}

# ── PR-spawn notify-back link wiring ──────────────────────────────────────
# When a completed turn's reply surfaces a BenchAGI PR URL, the runtime writes
# a 'pr' follow-up link doc (instances/{id}/sessionFollowups). The already-live
# notify_back_daemon then watches that PR to a terminal state and posts an
# in-chat "✅ done" follow-up. The runtime NEVER calls `gh` itself — it only
# creates the link (create-if-not-exists, so re-mentions across turns never
# duplicate or reset a posted link). The owner is configurable so a fork/test
# repo can be matched; default mirrors notify_back_daemon's NOTIFY_BACK_PR_REPO.
PR_LINK_REPO_OWNER = os.environ.get("NOTIFY_BACK_PR_REPO_OWNER", "BenchAGI")
PR_URL_RE = re.compile(
    r"https?://github\.com/" + re.escape(PR_LINK_REPO_OWNER) + r"/[\w.-]+/pull/(\d+)",
    re.IGNORECASE,
)

# ─────────────────────────────────────────────────────────────────────────


class GatewayStreamFailure(RuntimeError):
    """A gateway turn failed mid-stream. Carries whatever already streamed so
    the failure path can persist the partial reply instead of losing it
    (2026-06-12: a failed turn made the rendered reply vanish on rehydrate)."""

    def __init__(
        self,
        message: str,
        *,
        partial_text: str = "",
        model_used: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.partial_text = partial_text
        self.model_used = model_used


# ── Workflow-tree reducer (P3) ───────────────────────────────────────────────
# A multi-agent turn's Workflow tool fans out into sub-agent SESSIONS. The
# gateway forwards the stream-json `system` envelopes verbatim on the side
# channel `choices[0].delta.openclaw_workflow`. We reduce them in-turn into a
# tree keyed by task_id, then upsert one durable workflowSessions doc per
# `workflow_agent` row. task_progress carries FULL snapshots — last-write-wins
# per (type, index), NOT accumulate. Only task_notification marks terminal.


def _wf_status_from_agent_state(state: Any) -> str:
    """Map a workflow_agent.state → WorkflowSessionStatus.
    start/progress → running, done → done, error → failed."""
    s = state if isinstance(state, str) else ""
    if s == "done":
        return "done"
    if s == "error":
        return "failed"
    # start | progress | anything-else → running
    return "running"


def _wf_progress_for_agent(node: dict[str, Any], status: str) -> float:
    """Best-effort 0..1 progress: 1.0 when done, else derive from phase
    position when available, else a small running floor."""
    if status == "done":
        return 1.0
    phase_index = node.get("phaseIndex")
    if isinstance(phase_index, (int, float)) and phase_index >= 0:
        # No total-phase count in the snapshot; approximate a climbing bar that
        # never claims completion. Caps below 1.0 for running rows.
        return min(0.9, 0.1 + 0.1 * float(phase_index))
    return 0.1 if status == "running" else 0.0


def _map_workflow_agent_to_doc(
    *,
    agent_node: dict[str, Any],
    task: dict[str, Any],
    seq: int,
) -> Optional[dict[str, Any]]:
    """Map one reduced workflow_agent snapshot → a WorkflowSessionDoc body
    (lane keys + timestamps are stamped later by _upsert_workflow_session).
    Returns None if the row has no usable agentId."""
    agent_id = agent_node.get("agentId")
    if not isinstance(agent_id, str) or not agent_id.strip():
        return None
    agent_id = agent_id.strip()
    state = agent_node.get("state")
    status = _wf_status_from_agent_state(state)
    # Optional: a label/summary that contains a block marker → blocked.
    label = agent_node.get("label")
    label_str = label if isinstance(label, str) else ""
    last_summary = agent_node.get("lastToolSummary")
    last_summary_str = last_summary if isinstance(last_summary, str) else ""
    if status == "running" and (
        "block" in label_str.lower() or "block" in last_summary_str.lower()
    ):
        status = "blocked"

    progress = _wf_progress_for_agent(agent_node, status)

    # "now" headline: lastToolSummary preferred, else promptPreview.
    prompt_preview = agent_node.get("promptPreview")
    now_text = ""
    if last_summary_str:
        now_text = last_summary_str
    elif isinstance(prompt_preview, str):
        now_text = prompt_preview

    def _int_or_zero(value: Any) -> int:
        return int(value) if isinstance(value, (int, float)) else 0

    result_preview = agent_node.get("resultPreview")
    result_val: Optional[str] = None
    if status == "done" and isinstance(result_preview, str) and result_preview:
        result_val = result_preview

    phase_index = agent_node.get("phaseIndex")
    phase_title = agent_node.get("phaseTitle")
    duration_ms = _int_or_zero(agent_node.get("durationMs"))

    doc: dict[str, Any] = {
        "id": agent_id,
        # workflow identity (the tree)
        "taskId": task.get("task_id") if isinstance(task.get("task_id"), str) else "",
        "workflowToolUseId": task.get("tool_use_id")
        if isinstance(task.get("tool_use_id"), str)
        else "",
        "parentToolUseId": task.get("parent_tool_use_id")
        if isinstance(task.get("parent_tool_use_id"), str)
        else None,
        "agentId": agent_id,
        "agentLabel": label_str,
        "phaseIndex": int(phase_index)
        if isinstance(phase_index, (int, float))
        else None,
        "phaseTitle": phase_title if isinstance(phase_title, str) else None,
        # live state
        "status": status,
        "now": now_text,
        "progress": progress,
        # metrics + result + timing
        "tokens": _int_or_zero(agent_node.get("tokens")),
        "toolCalls": _int_or_zero(agent_node.get("toolCalls")),
        "durationMs": duration_ms,
        "result": result_val,
        "error": None,
        "elapsedSec": duration_ms // 1000,
        "seq": seq,
    }
    return doc


def _reduce_workflow_event(
    reducer: dict[str, dict[str, Any]],
    event: dict[str, Any],
) -> list[dict[str, Any]]:
    """Fold one stream-json `system` workflow event into the per-turn reducer.

    reducer shape:  task_id → {
        "tool_use_id", "parent_tool_use_id", "status",
        "nodes": (type, index) → node   # full snapshots, last-write-wins
    }

    Returns the list of workflow_agent node snapshots that should be upserted as
    a result of THIS event (the agent rows carried in task_progress)."""
    subtype = event.get("subtype")
    task_id = event.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        return []

    task = reducer.get(task_id)
    if task is None:
        task = {
            "task_id": task_id,
            "tool_use_id": None,
            "parent_tool_use_id": None,
            "status": "running",
            "nodes": {},
        }
        reducer[task_id] = task

    if subtype == "task_started":
        # binds task → workflow tool_use_id → parent
        tool_use_id = event.get("tool_use_id")
        if isinstance(tool_use_id, str):
            task["tool_use_id"] = tool_use_id
        parent = event.get("parent_tool_use_id")
        task["parent_tool_use_id"] = parent if isinstance(parent, str) else None
        return []

    if subtype == "task_notification":
        # workflow terminal (only this marks done)
        status = event.get("status")
        if isinstance(status, str) and status:
            task["status"] = status
        return []

    if subtype == "task_progress":
        rows = event.get("workflow_progress")
        if not isinstance(rows, list):
            return []
        agents: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            rtype = row.get("type")
            index = row.get("index")
            if not isinstance(rtype, str) or not isinstance(index, (int, float)):
                continue
            # REPLACE the node by (type, index) — full snapshot, last-write-wins.
            task["nodes"][(rtype, int(index))] = row
            if rtype == "workflow_agent":
                agents.append(row)
        return agents

    return []


@dataclass(frozen=True)
class RuntimeConfig:
    instance_id: str
    gateway_url: str
    gateway_token: str
    gateway_timeout_seconds: float
    firebase_service_account_path: str
    firebase_project_id: str
    max_concurrent_inbound: int
    log_level: str
    heartbeat_interval_seconds: float
    session_digest_enabled: bool
    # This machine's routing id (a CONSOLE_MACHINES id, e.g. "mbp" / "mini") and
    # display label. When set, the runtime claims only docs targeted at it (plus,
    # if this box is the fallback, primary-targeted docs whose primary is offline)
    # and stamps the machine onto every run/outbound for the UI device proof.
    # EMPTY (default) = today's behavior: claim everything, ignore runOn.
    machine_id: str
    machine_name: str
    # When this box is a fallback, the primary machine id whose staleness lets it
    # take over (e.g. mini's primary is "mbp"). Empty = not a fallback.
    fallback_for: str

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        load_dotenv()

        def required(name: str) -> str:
            value = os.getenv(name)
            if not value:
                raise SystemExit(
                    f"[agent-chat-runtime] missing required env: {name} "
                    "(see .env.example)"
                )
            return value

        gateway_url = os.getenv("GATEWAY_URL", "http://127.0.0.1:18789").rstrip("/")
        sa_path = required("FIREBASE_SERVICE_ACCOUNT_PATH")
        if not Path(sa_path).is_file():
            raise SystemExit(
                f"[agent-chat-runtime] FIREBASE_SERVICE_ACCOUNT_PATH not found: {sa_path}"
            )

        return cls(
            instance_id=required("INSTANCE_ID"),
            gateway_url=gateway_url,
            # Empty token is supported — the local bridge.js on 7331 does not
            # require auth for localhost calls (CORS=* + no bearer check).
            # The OpenClaw gateway on 18789 *does* require a token, so set
            # one here if your GATEWAY_URL points at 18789.
            gateway_token=_resolve_gateway_token(os.getenv("GATEWAY_TOKEN", "").strip()),
            gateway_timeout_seconds=float(os.getenv("GATEWAY_TIMEOUT_SECONDS", "180")),
            firebase_service_account_path=sa_path,
            firebase_project_id=os.getenv("FIREBASE_PROJECT_ID", "benchagi-8ea90"),
            max_concurrent_inbound=int(os.getenv("MAX_CONCURRENT_INBOUND", "3")),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            # Default lowered 45→25 so a live machine emits ≥3 heartbeats
            # inside the 90s MACHINE_PRESENCE_STALE_SECONDS window — a single
            # dropped beat (GC pause, transient Firestore hiccup) can no longer
            # make a healthy runtime look stale and trigger a spurious fallback
            # takeover or reap. An explicit HEARTBEAT_INTERVAL_SECONDS in .env
            # still wins.
            heartbeat_interval_seconds=float(
                os.getenv("HEARTBEAT_INTERVAL_SECONDS", "25")
            ),
            # Customer-parity session capture (unified memory Plane A).
            # DEFAULT OFF — flipping it on writes per-instance digest docs to
            # Firestore and is gated on Cory's explicit approval.
            session_digest_enabled=(
                os.getenv("SESSION_DIGEST_ENABLED", "").strip().lower()
                in {"1", "true", "yes", "on"}
            ),
            machine_id=os.getenv("MACHINE_ID", "").strip(),
            machine_name=os.getenv("MACHINE_NAME", "").strip(),
            fallback_for=os.getenv("FALLBACK_FOR", "").strip(),
        )


def _sanitize_firestore_id(raw: str) -> str:
    """Make a deterministic, Firestore-safe document id. A Firestore id may not
    contain '/', must not be '.'/'..', and is capped at 1500 bytes. We map any
    char outside [A-Za-z0-9._-] to '_' so a session id with odd characters can't
    produce an illegal path, then trim to a safe length. Deterministic so the
    PR-link create-if-not-exists stays idempotent across turns."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", raw)
    if safe in ("", ".", ".."):
        safe = "_" + safe
    return safe[:1500]


def _resolve_gateway_token(env_token: str) -> str:
    """Single source of truth for the gateway bearer token. Prefer the gateway's
    OWN config (~/.openclaw/openclaw.json → gateway.auth.token) so the runtime
    can never drift from what the gateway validates against — the 'four legs'
    token-rotation blind spot that 401s the chat. Fall back to GATEWAY_TOKEN env
    if the config is unreadable."""
    try:
        cfg_path = os.path.expanduser("~/.openclaw/openclaw.json")
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        token = ((cfg.get("gateway") or {}).get("auth") or {}).get("token")
        if isinstance(token, str) and token.strip():
            return token.strip()
    except Exception:  # noqa: BLE001
        pass
    return env_token


def configure_logging(level: str) -> logging.Logger:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
        stream=sys.stdout,
    )
    return logging.getLogger("agent-chat-runtime")


def init_firestore(config: RuntimeConfig):
    cred = credentials.Certificate(config.firebase_service_account_path)
    firebase_admin.initialize_app(
        cred, {"projectId": config.firebase_project_id}
    )
    return firestore.client()


# ── Per-event handler ────────────────────────────────────────────────────


class InboundProcessor:
    """Process a single claimed inbound event end-to-end."""

    def __init__(
        self,
        config: RuntimeConfig,
        db,
        http: httpx.Client,
        log: logging.Logger,
    ):
        self.config = config
        self.db = db
        self.http = http
        self.log = log
        # Mutable live copy of the gateway bearer — re-resolved from the
        # canonical config on each heartbeat so a token rotation self-heals
        # within one cycle, no restart (see _resolve_gateway_token /
        # _write_heartbeat). Never read self.config.gateway_token for the POST.
        self._gateway_token = config.gateway_token
        # Real OS hostname — recorded as `host` on the heartbeat for forensics
        # only. NOT used for device proof or reaper presence: macOS auto-renumbers
        # it (Corys-MacBook-Pro-9 → -10) with no reboot, which would orphan the
        # reaper's presence lookup and scramble claimedByMachine across restarts.
        self._hostname = socket.gethostname()
        # STABLE device-proof label stamped as claimedByMachine on every
        # inbound/outbound/AgentRun. Prefer the configured MACHINE_NAME, then the
        # routing MACHINE_ID, and only fall back to the volatile hostname when the
        # box is fully unscoped (legacy single-runtime). All ROUTING stays keyed on
        # MACHINE_ID; this is a human-readable + reaper-stable proof field.
        self._claimed_by = (
            config.machine_name or config.machine_id or self._hostname
        )
        # ── Live presence telemetry (powers the Watchers UI) ──────────────
        # In-process counter of turns currently executing, plus the run_id of
        # the most recent in-flight turn and the latest observed model. Guarded
        # by a dedicated lock; read non-fatally by RuntimeService._write_heartbeat.
        self._turn_lock = threading.Lock()
        self._active_turns = 0
        self._current_run_id: Optional[str] = None
        self._current_model: Optional[str] = None

    # ── public entry ────────────────────────────────────────────────────

    def process(self, event_id: str) -> None:
        """Handle one inbound event by id. Safe to call multiple times;
        the transactional claim ensures only one run actually executes."""

        outbound_id = f"out_{uuid.uuid4().hex[:24]}"
        run_id = f"run_{uuid.uuid4().hex[:24]}"

        claimed = self._claim(event_id, outbound_id=outbound_id, run_id=run_id)
        if claimed is None:
            return  # someone else got it, or it was already terminal

        # Live-turn telemetry: this turn is now ours and in-flight. Bump the
        # in-process counter and record the run_id for the Watchers UI. Cleared
        # in the finally below; the counter only ever decrements after a claim.
        with self._turn_lock:
            self._active_turns += 1
            self._current_run_id = run_id

        try:
            # Persist the user message to the chat session (Phase 2A-3 substrate).
            # Non-fatal — never blocks the chat flow.
            self._persist_chat_session_message(
                instance_id=claimed["instanceId"],
                user_id=claimed["userId"],
                agent_id=claimed["agentId"],
                session_id=claimed["sessionId"],
                role="user",
                text=claimed["message"],
                inbound_event_id=event_id,
            )

            try:
                self._create_agent_run(claimed, run_id=run_id, outbound_id=outbound_id)
                self._create_outbound(claimed, outbound_id=outbound_id, run_id=run_id)
                self._stream_response(claimed, outbound_id=outbound_id, run_id=run_id)
            except Exception as exc:  # noqa: BLE001 — defensive top-level
                self.log.exception(
                    "process failed for event_id=%s outbound_id=%s: %s",
                    event_id,
                    outbound_id,
                    exc,
                )
                partial_text = (
                    exc.partial_text if isinstance(exc, GatewayStreamFailure) else ""
                )
                model_used = (
                    exc.model_used if isinstance(exc, GatewayStreamFailure) else None
                )
                self._mark_failure(
                    event_id=event_id,
                    outbound_id=outbound_id,
                    run_id=run_id,
                    error_message=str(exc),
                    error_code="RUNTIME_EXCEPTION",
                    partial_text=partial_text,
                    model_used=model_used,
                )
        finally:
            # Always release the turn slot. Clear currentRunId only when this
            # was the last in-flight turn so a concurrent turn keeps its own id.
            with self._turn_lock:
                self._active_turns = max(0, self._active_turns - 1)
                if self._active_turns == 0:
                    self._current_run_id = None

    # ── routing ─────────────────────────────────────────────────────────

    def _presence_is_stale(self, snap) -> bool:
        """True when a machine's presence doc says it's offline or hasn't beat
        within the stale window — the only condition that lets a fallback take
        over. Never-seen (no doc) counts as stale (let the fallback run)."""
        if snap is None or not getattr(snap, "exists", False):
            return True
        d = snap.to_dict() or {}
        if d.get("online") is False:
            return True
        last = d.get("lastSeenAt")
        try:
            age = time.time() - last.timestamp()
        except Exception:  # noqa: BLE001 — missing/non-timestamp → treat as stale
            return True
        return age > MACHINE_PRESENCE_STALE_SECONDS

    def _route_allows_claim(self, data: dict[str, Any], tx) -> bool:
        """Decide whether THIS machine may claim an inbound doc.

        - Unscoped (empty MACHINE_ID): claim everything (single-runtime / legacy).
        - Targeted at me (runOn == my id), or unrouted and I'm not purely a
          fallback: mine.
        - Otherwise: only as the configured liveness fallback for my primary,
          and only when the primary's presence is stale.
        """
        my_id = self.config.machine_id
        if not my_id:
            return True
        run_on = (data.get("runOn") or "").strip()
        if run_on == my_id or (not run_on and not self.config.fallback_for):
            return True
        primary = self.config.fallback_for
        if not primary or (run_on and run_on != primary):
            return False
        presence_ref = (
            self.db.collection("instances")
            .document(self.config.instance_id)
            .collection("gatewayStatus")
            .document(f"chatRuntime-{primary}")
        )
        try:
            psnap = presence_ref.get(transaction=tx)
        except Exception:  # noqa: BLE001 — can't read presence → don't double-run
            return False
        return self._presence_is_stale(psnap)

    # ── orphan reaper ────────────────────────────────────────────────────
    # Recovers docs a runtime flipped to 'processing' and then died on (kill -9,
    # panic, power loss) before reaching a terminal status. Both snapshot
    # listeners watch status=='pending' ONLY, so nothing else ever revisits a
    # 'processing' doc — it would hang forever. Reuses _presence_is_stale and the
    # same transactional discipline as _claim. Idempotent + safe to run on BOTH
    # Mini and Pro concurrently (every write is gated on a fresh in-txn re-read of
    # status=='processing' + the same staleness condition).

    @staticmethod
    def _reaper_ttl_seconds(gateway_timeout_seconds: float) -> float:
        """Min age a 'processing' claim must reach before it's reapable.
        REAPER_TTL_MULTIPLIER × the gateway timeout (so it always exceeds the
        longest legitimate turn on THIS host), floored for safety."""
        return max(
            REAPER_TTL_FLOOR_SECONDS,
            REAPER_TTL_MULTIPLIER * float(gateway_timeout_seconds),
        )

    def _claim_age_seconds(self, data: dict[str, Any]) -> Optional[float]:
        """Age of a claim from claimedAt (preferred) or updatedAt, in seconds.
        None when neither is a usable server timestamp (→ caller skips it: we
        never reap a doc whose age we can't establish)."""
        for key in ("claimedAt", "updatedAt"):
            ts = data.get(key)
            try:
                return time.time() - ts.timestamp()
            except Exception:  # noqa: BLE001 — missing/non-timestamp → try next
                continue
        return None

    def _claimer_machine_id(self, data: dict[str, Any]) -> Optional[str]:
        """The routing machine id that owns a stuck doc. Prefer the explicit
        routing field machineId; fall back to claimedByMachine (now the stable
        configured label, so chatRuntime-{label} resolves). Empty → unknown."""
        mid = (data.get("machineId") or "").strip()
        if mid:
            return mid
        cb = (data.get("claimedByMachine") or "").strip()
        return cb or None

    def _machine_presence_is_stale(self, machine_id: str, tx=None) -> bool:
        """True when machine_id's per-machine presence doc
        (gatewayStatus/chatRuntime-{machine_id}) is offline/stale (>90s) or
        absent. Unknown machine_id → treat as stale (the claimer can't be
        proven alive). Reuses _presence_is_stale for the timestamp math."""
        if not machine_id:
            return True
        presence_ref = (
            self.db.collection("instances")
            .document(self.config.instance_id)
            .collection("gatewayStatus")
            .document(f"chatRuntime-{machine_id}")
        )
        try:
            psnap = presence_ref.get(transaction=tx) if tx is not None else presence_ref.get()
        except Exception:  # noqa: BLE001 — can't read presence → don't reap
            return False
        return self._presence_is_stale(psnap)

    def _should_reap(self, data: dict[str, Any]) -> Optional[str]:
        """Decide this machine's disposition for ONE stale 'processing' doc.

        Returns:
          'pending' → reset to pending so the cross-machine fallback migrates the
                      in-flight turn (ONLY when I'm the configured fallback, the
                      claimer is my primary, and the primary's presence is stale).
          'failed'  → mark failed with a recoverable timeout error (when the doc
                      was claimed by ME but is older than the TTL — i.e. left over
                      from a previous, dead incarnation of this process; resetting
                      to pending would just re-loop to me).
          None      → not mine to reap (leave it for the machine that owns it).
        """
        claimer = self._claimer_machine_id(data)
        my_id = self.config.machine_id

        # Cross-machine migration (the ONLY path that moves an in-flight turn
        # between machines): I am a fallback, the doc was claimed by my primary,
        # and the primary is provably dead. Reset → pending; my own pending
        # listener (or the primary's, if it revives) re-claims it.
        if (
            self.config.fallback_for
            and claimer == self.config.fallback_for
            and self._machine_presence_is_stale(claimer)
        ):
            return "pending"

        # Self-orphan: the doc was claimed by THIS routing id but is older than
        # the TTL. A live turn never exceeds the TTL (2× gateway timeout), so this
        # is a leftover from a hard-killed prior incarnation. Fail it with a
        # recoverable error so the user sees a retryable error, not a silent hang.
        if my_id and claimer == my_id:
            return "failed"

        # Unscoped legacy single-runtime (no machine_id): everything stuck is
        # mine; fail it (there's no second machine to migrate to).
        if not my_id:
            return "failed"

        return None

    def _reap_one(self, event_id: str, disposition: str) -> bool:
        """Transactionally apply a reap disposition to ONE doc, re-checking in
        the txn that it's still 'processing' AND still old enough AND still has
        the same disposition (presence can flip between sweep-scan and txn).
        Returns True if a write happened. Safe under concurrent reapers."""
        ref = self.db.collection("agentChatInbound").document(event_id)
        ttl = self._reaper_ttl_seconds(self.config.gateway_timeout_seconds)

        @firestore.transactional
        def txn(tx) -> Optional[dict[str, Any]]:
            snap = ref.get(transaction=tx)
            if not snap.exists:
                return None
            data = snap.to_dict() or {}
            if data.get("status") != "processing":
                return None  # already finished / re-claimed — leave it
            if data.get("instanceId") != self.config.instance_id:
                return None
            age = self._claim_age_seconds(data)
            if age is None or age < ttl:
                return None  # not (or no longer) old enough
            # Re-confirm the disposition under the txn (presence may have
            # recovered since the scan; for 'pending' the primary must still be
            # stale — read presence inside the txn for consistency).
            fresh = self._should_reap(data)
            if fresh != disposition:
                return None
            if disposition == "pending":
                tx.update(
                    ref,
                    {
                        # Hand back to the pending listeners for takeover. Clear
                        # the prior claim so the next claimer starts clean and the
                        # stale-claim view doesn't show a ghost owner.
                        "status": "pending",
                        "claimedAt": firestore.DELETE_FIELD,
                        "claimedByMachine": firestore.DELETE_FIELD,
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        "reapedAt": firestore.SERVER_TIMESTAMP,
                        "reapedBy": self._claimed_by,
                        "reapReason": "orphan-migrate",
                        "reapCount": firestore.Increment(1),
                    },
                )
            else:  # 'failed'
                tx.update(
                    ref,
                    {
                        "status": "failed",
                        "completedAt": firestore.SERVER_TIMESTAMP,
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        "dispatchError": (
                            "orphaned mid-turn (runtime died before completing); "
                            "reaped after timeout"
                        ),
                        "reapedAt": firestore.SERVER_TIMESTAMP,
                        "reapedBy": self._claimed_by,
                        "reapReason": "orphan-timeout",
                        "reapCount": firestore.Increment(1),
                    },
                )
            return data

        result = txn(self.db.transaction())
        if result is None:
            return False

        # For a failed reap, surface a recoverable error to the user via the
        # existing outbound + error-chunk + AgentRun machinery (best-effort, fully
        # non-fatal — the inbound is already terminal). A reset-to-pending writes
        # nothing extra: the takeover run creates its own fresh outbound/run.
        if disposition == "failed":
            outbound_id = result.get("outboundId")
            run_id = result.get("agentRunId")
            if isinstance(outbound_id, str) and outbound_id:
                try:
                    self.db.collection("agentChatOutbound").document(
                        outbound_id
                    ).update(
                        {
                            "status": "failed",
                            "completedAt": firestore.SERVER_TIMESTAMP,
                            "error": "orphaned mid-turn; reaped after timeout",
                        }
                    )
                    self._write_chunk(
                        outbound_id=outbound_id,
                        seq=999_999,  # land last regardless of ordering
                        payload={
                            "kind": "error",
                            "errorCode": "ORPHAN_TIMEOUT",
                            "errorMessage": (
                                "This turn was interrupted (the runtime restarted "
                                "before it finished). Please send your message "
                                "again."
                            ),
                        },
                    )
                except Exception:  # noqa: BLE001 — non-fatal
                    self.log.warning(
                        "reaper: outbound error-chunk failed (non-fatal) "
                        "outbound_id=%s",
                        outbound_id,
                        exc_info=True,
                    )
            if (
                isinstance(run_id, str)
                and run_id
                and isinstance(result.get("instanceId"), str)
            ):
                try:
                    self._mark_run_failed(
                        instance_id=result["instanceId"],
                        run_id=run_id,
                        error="orphaned mid-turn; reaped after timeout",
                    )
                except Exception:  # noqa: BLE001 — non-fatal
                    self.log.warning(
                        "reaper: mark_run_failed failed (non-fatal) run_id=%s",
                        run_id,
                        exc_info=True,
                    )
        return True

    def reap_orphans(self) -> int:
        """One reaper sweep: find this instance's stale 'processing' docs whose
        claimer is provably dead and apply the right disposition. Returns the
        number of docs reaped. Fully non-fatal — any error is logged and the loop
        keeps running. Safe on BOTH machines at once."""
        ttl = self._reaper_ttl_seconds(self.config.gateway_timeout_seconds)
        try:
            query = (
                self.db.collection("agentChatInbound")
                .where(
                    filter=FieldFilter(
                        "instanceId", "==", self.config.instance_id
                    )
                )
                .where(filter=FieldFilter("status", "==", "processing"))
                .limit(REAPER_MAX_PER_SWEEP)
            )
            docs = list(query.stream())
        except Exception:  # noqa: BLE001 — index/transient → skip this sweep
            self.log.warning("reaper: scan failed (non-fatal)", exc_info=True)
            return 0

        reaped = 0
        for snap in docs:
            try:
                data = snap.to_dict() or {}
                age = self._claim_age_seconds(data)
                if age is None or age < ttl:
                    continue  # still within a legitimate turn's lifetime
                disposition = self._should_reap(data)
                if disposition is None:
                    continue  # owned by a machine that's still alive / not mine
                if self._reap_one(snap.id, disposition):
                    reaped += 1
                    self.log.info(
                        "reaped orphan event_id=%s age=%.0fs disposition=%s "
                        "claimer=%s",
                        snap.id,
                        age,
                        disposition,
                        self._claimer_machine_id(data),
                    )
            except Exception:  # noqa: BLE001 — one bad doc never kills the sweep
                self.log.warning(
                    "reaper: failed on event_id=%s (non-fatal)",
                    getattr(snap, "id", "?"),
                    exc_info=True,
                )
        return reaped

    # ── claim ───────────────────────────────────────────────────────────

    def _claim(
        self, event_id: str, *, outbound_id: str, run_id: str
    ) -> Optional[dict[str, Any]]:
        """Transactionally transition pending → processing. Returns the
        doc dict on success, None if another runner beat us to it or the
        doc disappeared / terminal-statused."""

        ref = self.db.collection("agentChatInbound").document(event_id)

        @firestore.transactional
        def txn(tx) -> Optional[dict[str, Any]]:
            snap = ref.get(transaction=tx)
            if not snap.exists:
                self.log.warning("claim: doc gone, event_id=%s", event_id)
                return None
            data = snap.to_dict() or {}
            if data.get("status") != "pending":
                self.log.info(
                    "claim: skipping non-pending event_id=%s status=%s",
                    event_id,
                    data.get("status"),
                )
                return None
            if data.get("instanceId") != self.config.instance_id:
                self.log.warning(
                    "claim: instanceId mismatch event_id=%s (got %s, expected %s)",
                    event_id,
                    data.get("instanceId"),
                    self.config.instance_id,
                )
                return None
            # Machine routing: claim only docs targeted at this machine — or, as a
            # configured liveness fallback, a primary-targeted doc whose primary
            # runtime's presence is stale. Empty machine_id = unscoped (claim
            # everything; backward-compatible with the single-runtime setup). The
            # presence read is a txn read (before any write) for consistency.
            if not self._route_allows_claim(data, tx):
                return None
            tx.update(
                ref,
                {
                    "status": "processing",
                    "claimedAt": firestore.SERVER_TIMESTAMP,
                    # Heartbeat for the stale-claim view; bumped again per turn.
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                    "outboundId": outbound_id,
                    "agentRunId": run_id,
                    "claimedByMachine": self._claimed_by,
                    **(
                        {
                            "machineId": self.config.machine_id,
                            "machineName": self.config.machine_name,
                        }
                        if self.config.machine_id
                        else {}
                    ),
                },
            )
            return data

        result = txn(self.db.transaction())
        if result is None:
            return None
        # Re-fetch so the caller has the post-claim view (fields like
        # claimedAt are server-side; we don't strictly need them).
        return {**result, "eventId": event_id}

    # ── AgentRun (visibility surface) ───────────────────────────────────

    def _create_agent_run(
        self, claimed: dict[str, Any], *, run_id: str, outbound_id: str
    ) -> None:
        instance_id = claimed["instanceId"]
        agent_id = claimed["agentId"]
        agent_label = AGENT_LABEL.get(agent_id, agent_id.capitalize())
        session_id = claimed["sessionId"]

        run_ref = (
            self.db.collection("instances")
            .document(instance_id)
            .collection("agentRuns")
            .document(run_id)
        )
        run_ref.set(
            {
                "id": run_id,
                "instanceId": instance_id,
                "channelId": f"chat:{agent_id}",  # per-agent per-instance
                "threadId": session_id,
                "triggerMessageId": claimed["eventId"],
                "agentId": agent_id,
                "agentLabel": agent_label,
                "status": "running",
                "visibility": "collapsed",
                "stepCount": 0,
                "elapsedMs": None,
                "summary": None,
                "live": {
                    "phase": "starting",
                    "headline": f"{agent_label} is receiving your message…",
                    "latestSeq": -1,
                    "activeToolCount": 0,
                    "previewText": None,
                    "reasoningText": None,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                "resultMessageId": None,
                "error": None,
                "startedAt": firestore.SERVER_TIMESTAMP,
                "completedAt": None,
                "requestedModel": claimed.get("requestedModel"),
                "modelUsed": None,
                # Device proof: where this turn actually ran. claimedByMachine is
                # the STABLE configured label (not the volatile OS hostname);
                # machineId/Name are the routing identity.
                "claimedByMachine": self._claimed_by,
                "machineId": self.config.machine_id or None,
                "machineName": self.config.machine_name or None,
                "turnState": "waiting",
                "contextStrategy": claimed.get("contextStrategy"),
                "metadata": {
                    "outboundId": outbound_id,
                    "source": "agent-chat-runtime",
                    "sessionId": session_id,
                },
            }
        )
        self._append_run_step(
            instance_id=instance_id,
            run_id=run_id,
            seq=0,
            step_type="thinking",
            label="Receiving message",
            content=f"Message length: {len(claimed['message'])} chars",
        )

    def _append_run_step(
        self,
        *,
        instance_id: str,
        run_id: str,
        seq: int,
        step_type: str,
        label: str,
        content: str,
        tool_name: Optional[str] = None,
        tool_input: Optional[dict[str, Any]] = None,
        tool_success: Optional[bool] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        run_ref = (
            self.db.collection("instances")
            .document(instance_id)
            .collection("agentRuns")
            .document(run_id)
        )
        step_id = f"step_{seq:04d}_{uuid.uuid4().hex[:8]}"
        step_data: dict[str, Any] = {
            "id": step_id,
            "type": step_type,
            "label": label,
            "content": content,
            "seq": seq,
            "durationMs": duration_ms,
            "timestamp": firestore.SERVER_TIMESTAMP,
        }
        if tool_name is not None:
            step_data["toolName"] = tool_name
        if tool_input is not None:
            step_data["toolInput"] = tool_input
        if tool_success is not None:
            step_data["toolSuccess"] = tool_success

        batch = self.db.batch()
        batch.set(run_ref.collection("steps").document(step_id), step_data)
        batch.update(
            run_ref,
            {
                "stepCount": firestore.Increment(1),
                "live.latestSeq": seq,
                "live.updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )
        batch.commit()

    # ── workflowSessions lane (P3) ──────────────────────────────────────────

    def _upsert_workflow_session(
        self,
        *,
        instance_id: str,
        run_id: str,
        session_id: str,
        channel_id: Optional[str],
        thread_id: str,
        agent_id: str,
        doc: dict[str, Any],
        is_create: bool,
    ) -> None:
        """Upsert one durable workflow-session doc at
        instances/{instance_id}/agentRuns/{run_id}/workflowSessions/{agentId}.

        Mirrors _append_run_step's Admin-SDK (self.db) pattern. The lane is the
        PATH — a different run is a different subcollection — so a write can
        never land in another turn's lane. The caller passes a fully-mapped doc;
        this method only stamps the lane keys + server timestamps and writes."""
        sess_ref = (
            self.db.collection("instances")
            .document(instance_id)
            .collection("agentRuns")
            .document(run_id)
            .collection("workflowSessions")
            .document(doc["id"])
        )
        payload: dict[str, Any] = dict(doc)
        # Lane keys — denormalized copies of the parent run's keys (immutable
        # after create); redundant with the path on purpose (rules re-derive the
        # channel wall + self-describing audit trail).
        payload["instanceId"] = instance_id
        payload["parentRunId"] = run_id
        payload["parentSessionId"] = session_id
        payload["channelId"] = channel_id
        payload["threadId"] = thread_id
        # serverTimestamp: createdAt once (on create), updatedAt every write.
        payload["updatedAt"] = firestore.SERVER_TIMESTAMP
        if is_create:
            payload["createdAt"] = firestore.SERVER_TIMESTAMP
        if payload.get("status") == "done":
            payload["completedAt"] = firestore.SERVER_TIMESTAMP
        # merge=True so progress writes never clobber createdAt/startedAt set on
        # a prior write for this agentId.
        sess_ref.set(payload, merge=True)

    def _handle_workflow_frame(
        self,
        *,
        wf_event: dict[str, Any],
        reducer: dict[str, dict[str, Any]],
        instance_id: str,
        run_id: str,
        session_id: str,
        channel_id: Optional[str],
        thread_id: str,
        agent_id: str,
        seq: int,
        last_write: dict[str, float],
        created: set[str],
    ) -> int:
        """Reduce one side-channel workflow frame and upsert any affected
        sub-agent sessions. Returns the next workflow seq counter.

        The frame carries the verbatim stream-json `system` record under
        `event` (plus a top-level `subtype` mirror). task_progress rows are FULL
        snapshots (last-write-wins per (type,index)); writes are throttled to
        ~1/sec per session, but a terminal `done` always writes immediately so
        completion is never dropped."""
        event = wf_event.get("event")
        if not isinstance(event, dict):
            # Tolerate a flattened payload that puts the system fields top-level.
            event = wf_event
        agents = _reduce_workflow_event(reducer, event)
        if not agents:
            return seq

        task_id = event.get("task_id")
        task = reducer.get(task_id) if isinstance(task_id, str) else None
        if task is None:
            return seq

        now = time.monotonic()
        for agent_node in agents:
            doc = _map_workflow_agent_to_doc(
                agent_node=agent_node,
                task=task,
                seq=seq,
            )
            if doc is None:
                continue
            sess_key = doc["id"]
            is_done = doc.get("status") == "done"
            # Throttle: skip an intermediate write if we wrote this session
            # recently — full snapshots mean nothing is lost. Always write a
            # create and a terminal done.
            is_create = sess_key not in created
            last = last_write.get(sess_key)
            if (
                not is_create
                and not is_done
                and last is not None
                and (now - last) < WORKFLOW_SESSION_WRITE_INTERVAL_SECONDS
            ):
                continue
            self._upsert_workflow_session(
                instance_id=instance_id,
                run_id=run_id,
                session_id=session_id,
                channel_id=channel_id,
                thread_id=thread_id,
                agent_id=agent_id,
                doc=doc,
                is_create=is_create,
            )
            created.add(sess_key)
            last_write[sess_key] = now
            seq += 1
        return seq

    def _set_run_turn_state(
        self,
        *,
        instance_id: str,
        run_id: str,
        turn_state: Optional[str],
    ) -> None:
        """Advisory turn-level state on the run doc (waiting | streaming |
        tool_phase | None). Non-fatal — the feed badge is nice-to-have."""
        try:
            (
                self.db.collection("instances")
                .document(instance_id)
                .collection("agentRuns")
                .document(run_id)
            ).update({"turnState": turn_state})
        except Exception as exc:  # noqa: BLE001 — non-fatal by design
            self.log.warning(
                "set_run_turn_state failed (non-fatal) run_id=%s: %s", run_id, exc
            )

    def _mark_run_completed(
        self,
        *,
        instance_id: str,
        run_id: str,
        elapsed_ms: int,
        summary: str,
        model_used: Optional[str] = None,
    ) -> None:
        ref = (
            self.db.collection("instances")
            .document(instance_id)
            .collection("agentRuns")
            .document(run_id)
        )
        ref.update(
            {
                "status": "completed",
                "summary": summary,
                "elapsedMs": elapsed_ms,
                "completedAt": firestore.SERVER_TIMESTAMP,
                "modelUsed": model_used,
                "turnState": None,
                "live.headline": "Done",
                "live.phase": "completed",
                "live.updatedAt": firestore.SERVER_TIMESTAMP,
            }
        )

    def _mark_run_failed(
        self,
        *,
        instance_id: str,
        run_id: str,
        error: str,
    ) -> None:
        ref = (
            self.db.collection("instances")
            .document(instance_id)
            .collection("agentRuns")
            .document(run_id)
        )
        ref.update(
            {
                "status": "failed",
                "error": error[:1000],
                "completedAt": firestore.SERVER_TIMESTAMP,
                "turnState": None,
                "live.headline": "Failed",
                "live.phase": "failed",
                "live.updatedAt": firestore.SERVER_TIMESTAMP,
            }
        )

    # ── Chat session persistence (Phase 2A-3) ───────────────────────────

    def _persist_chat_session_message(
        self,
        *,
        instance_id: str,
        user_id: str,
        agent_id: str,
        session_id: str,
        role: str,  # 'user' | 'assistant'
        text: str,
        inbound_event_id: Optional[str] = None,
        outbound_id: Optional[str] = None,
        agent_run_id: Optional[str] = None,
        model_used: Optional[str] = None,
        elapsed_ms: Optional[int] = None,
        error_code: Optional[str] = None,
    ) -> None:
        """Write/upsert the chat session doc + append a message to its
        subcollection. Powers the conversation-history sidebar.

        Path: instances/{instance_id}/agentChatSessions/{session_id}
              instances/{instance_id}/agentChatSessions/{session_id}/messages/{message_id}

        Idempotent: message_id derived from upstream event/outbound id, so
        retries of the same logical message collapse to one doc.

        Non-fatal: any exception is logged but never propagates. Chat flow
        must continue to work even if session persistence breaks.
        """
        try:
            session_ref = (
                self.db.collection("instances")
                .document(instance_id)
                .collection("agentChatSessions")
                .document(session_id)
            )
            message_id = (
                inbound_event_id
                or outbound_id
                or f"msg_{uuid.uuid4().hex[:24]}"
            )
            message_ref = session_ref.collection("messages").document(message_id)

            @firestore.transactional
            def txn(tx) -> None:
                snap = session_ref.get(transaction=tx)
                preview_text = text[:80] if role == "user" else None
                if not snap.exists:
                    tx.set(
                        session_ref,
                        {
                            "sessionId": session_id,
                            "instanceId": instance_id,
                            "agentId": agent_id,
                            "userId": user_id,
                            "title": None,
                            "status": "active",
                            "startedAt": firestore.SERVER_TIMESTAMP,
                            "lastMessageAt": firestore.SERVER_TIMESTAMP,
                            "messageCount": 1,
                            "modality": "text",
                            "preview": preview_text,
                            "label": None,
                        },
                    )
                else:
                    updates: dict[str, Any] = {
                        "messageCount": firestore.Increment(1),
                        "lastMessageAt": firestore.SERVER_TIMESTAMP,
                    }
                    if role == "user":
                        updates["preview"] = preview_text
                    tx.update(session_ref, updates)

                message_data: dict[str, Any] = {
                    "messageId": message_id,
                    "sessionId": session_id,
                    "role": role,
                    "text": text,
                    "ts": firestore.SERVER_TIMESTAMP,
                }
                if inbound_event_id:
                    message_data["inboundEventId"] = inbound_event_id
                if outbound_id:
                    message_data["outboundId"] = outbound_id
                if agent_run_id:
                    message_data["agentRunId"] = agent_run_id
                if model_used:
                    message_data["modelUsed"] = model_used
                if elapsed_ms is not None:
                    message_data["elapsedMs"] = elapsed_ms
                if error_code:
                    # Marks a partial reply persisted from a failed turn.
                    message_data["errorCode"] = error_code
                    message_data["partial"] = True
                tx.set(message_ref, message_data)

            txn(self.db.transaction())
        except Exception as exc:  # noqa: BLE001 — non-fatal by design
            self.log.warning(
                "persist_chat_session_message failed (non-fatal) "
                "session_id=%s role=%s: %s",
                session_id,
                role,
                exc,
            )

    # ── Session digest capture (unified memory Plane A, flag-gated) ──────

    def _upsert_session_digest(
        self,
        *,
        instance_id: str,
        user_id: str,
        agent_id: str,
        session_id: str,
        user_text: str,
        assistant_text: str,
        model_used: Optional[str],
        elapsed_ms: int,
    ) -> None:
        """Rolling per-session digest at
        instances/{instance_id}/agentSessionDigests/{session_id}.

        Customer chat has no session-close event (sessions go idle), so the
        digest is refreshed at every turn completion: firstIntent is set once,
        the rolling fields track the latest turn. Heuristic only — no extra
        model calls on the chat path.

        Server-side Admin SDK write (bypasses rules). Clients must NEVER read
        this collection — the firestore.rules deny-block + member-fallback
        exclusions ship in the companion mono-repo PR and must land before
        SESSION_DIGEST_ENABLED is flipped on.

        Non-fatal: any exception is logged but never propagates.
        """
        try:
            digest_ref = (
                self.db.collection("instances")
                .document(instance_id)
                .collection("agentSessionDigests")
                .document(session_id)
            )
            first_intent = (user_text or "")[:240]
            last_user = (user_text or "")[:240]
            last_assistant = (assistant_text or "")[:240]

            @firestore.transactional
            def txn(tx) -> None:
                snap = digest_ref.get(transaction=tx)
                if not snap.exists:
                    tx.set(
                        digest_ref,
                        {
                            "version": 1,
                            "sessionId": session_id,
                            "instanceId": instance_id,
                            "agentId": agent_id,
                            "userId": user_id,
                            "surface": "customer-chat",
                            "firstIntent": first_intent,
                            "lastUserMessage": last_user,
                            "lastAssistantPreview": last_assistant,
                            "turnCount": 1,
                            "lastModelUsed": model_used,
                            "lastElapsedMs": elapsed_ms,
                            "startedAt": firestore.SERVER_TIMESTAMP,
                            "updatedAt": firestore.SERVER_TIMESTAMP,
                            "capturedBy": "agent-chat-runtime",
                            "privacy": "instance-private",
                        },
                    )
                else:
                    tx.update(
                        digest_ref,
                        {
                            "lastUserMessage": last_user,
                            "lastAssistantPreview": last_assistant,
                            "turnCount": firestore.Increment(1),
                            "lastModelUsed": model_used,
                            "lastElapsedMs": elapsed_ms,
                            "updatedAt": firestore.SERVER_TIMESTAMP,
                        },
                    )

            txn(self.db.transaction())
        except Exception as exc:  # noqa: BLE001 — non-fatal by design
            self.log.warning(
                "upsert_session_digest failed (non-fatal) session_id=%s: %s",
                session_id,
                exc,
            )

    # ── Outbound doc + chunks ───────────────────────────────────────────

    def _create_outbound(
        self,
        claimed: dict[str, Any],
        *,
        outbound_id: str,
        run_id: str,
    ) -> None:
        ref = self.db.collection("agentChatOutbound").document(outbound_id)
        ref.set(
            {
                "outboundId": outbound_id,
                "eventId": claimed["eventId"],
                "instanceId": claimed["instanceId"],
                "agentId": claimed["agentId"],
                "userId": claimed["userId"],
                "sessionId": claimed["sessionId"],
                "status": "streaming",
                "startedAt": firestore.SERVER_TIMESTAMP,
                "chunkCount": 0,
                "charCount": 0,
                "modelUsed": None,
                "error": None,
                "agentRunId": run_id,
                # Device proof (mirrors the AgentRun stamp). Stable label, not
                # the volatile OS hostname.
                "claimedByMachine": self._claimed_by,
                "machineId": self.config.machine_id or None,
                "machineName": self.config.machine_name or None,
            }
        )

    def _write_chunk(
        self,
        *,
        outbound_id: str,
        seq: int,
        payload: dict[str, Any],
    ) -> None:
        chunk_doc_id = str(seq).zfill(CHUNK_SEQ_PAD)
        chunk_ref = (
            self.db.collection("agentChatOutbound")
            .document(outbound_id)
            .collection("chunks")
            .document(chunk_doc_id)
        )
        out_ref = self.db.collection("agentChatOutbound").document(outbound_id)

        chunk_data = {**payload, "seq": seq, "ts": firestore.SERVER_TIMESTAMP}
        update = {
            "chunkCount": firestore.Increment(1),
        }
        if payload.get("kind") == "token" and payload.get("text"):
            update["charCount"] = firestore.Increment(len(payload["text"]))

        batch = self.db.batch()
        batch.set(chunk_ref, chunk_data)
        batch.update(out_ref, update)
        batch.commit()

    # ── The actual gateway call ─────────────────────────────────────────

    def _stream_response(
        self,
        claimed: dict[str, Any],
        *,
        outbound_id: str,
        run_id: str,
    ) -> None:
        instance_id = claimed["instanceId"]
        agent_id = claimed["agentId"]
        session_id = claimed["sessionId"]
        message = claimed["message"]
        first_token_seen = False

        # Workflow-tree lane (P3): per-turn reducer + write throttle. The lane
        # keys mirror the parent run doc (see _create_agent_run): channelId =
        # f"chat:{agent_id}", threadId = session_id. NOTE: console chat always
        # has a channel here; null is reserved for a future console surface.
        wf_reducer: dict[str, dict[str, Any]] = {}
        wf_seq = 0
        wf_last_write: dict[str, float] = {}
        wf_created: set[str] = set()
        wf_channel_id: Optional[str] = f"chat:{agent_id}"
        wf_thread_id = session_id

        gateway_call_start = time.monotonic()
        self._append_run_step(
            instance_id=instance_id,
            run_id=run_id,
            seq=1,
            step_type="tool_call",
            label="Calling local agent runtime",
            content=f"Routing to {agent_id} via local OpenClaw gateway",
            tool_name="openclaw_gateway",
            tool_input={"agent": agent_id, "messageLength": len(message)},
        )

        # First chunk: 'started' event so the SSE relay can emit
        # `{event: 'started', sessionId, outboundId}` to the browser.
        self._write_chunk(
            outbound_id=outbound_id,
            seq=0,
            payload={
                "kind": "event",
                "event": "started",
                "eventData": {
                    "sessionId": session_id,
                    "outboundId": outbound_id,
                    "agentRunId": run_id,
                    # Device proof, forwarded by the SSE relay's eventData spread
                    # so the console shows the running device immediately.
                    "machineId": self.config.machine_id or None,
                    "machineName": self.config.machine_name or None,
                },
            },
        )

        # ── OpenAI-compatible full-agent request ─────────────────────────
        # The OpenClaw gateway serves the full agent — personality, workspace
        # memory, skills, and the tool-use loop — at POST /v1/chat/completions,
        # the SAME internal entrypoint other surfaces use.
        #
        #   • Agent selection: model="openclaw/<agentId>" → that agent; its
        #     configured default model is used. The x-openclaw-agent-id header
        #     is sent too as defense-in-depth.
        #   • Continuity: x-openclaw-session-key pins the gateway session to
        #     the chat sessionId so successive turns share memory.
        agent_model = f"openclaw/{agent_id}"
        body = {
            "model": agent_model,
            "stream": True,
            "messages": [{"role": "user", "content": message}],
            "stream_options": {"include_usage": True},
        }

        seq = 1  # 0 was the 'started' event
        accumulated_text: list[str] = []
        model_used: Optional[str] = None
        upstream_url = f"{self.config.gateway_url}/v1/chat/completions"

        # Self-heal the bearer per turn: re-resolve from the canonical gateway
        # config so a token rotation never 401s the chat (no restart needed).
        # Cheap local file read; falls back to the existing token on any error.
        self._gateway_token = _resolve_gateway_token(self.config.gateway_token)

        request_headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            # /v1/chat/completions on 18789 is token-gated. Use the live token
            # (heartbeat-refreshed) so a rotation doesn't 401 the chat.
            "Authorization": f"Bearer {self._gateway_token}",
            "x-openclaw-session-key": session_id,
            "x-openclaw-agent-id": agent_id,
        }

        done_emitted = False

        def emit_done(event_data: dict[str, Any]) -> None:
            nonlocal seq
            self._write_chunk(
                outbound_id=outbound_id,
                seq=seq,
                payload={"kind": "event", "event": "done", "eventData": event_data},
            )
            seq += 1

        try:
            with self.http.stream(
                "POST",
                upstream_url,
                json=body,
                headers=request_headers,
                timeout=self.config.gateway_timeout_seconds,
            ) as resp:
                if resp.status_code != 200:
                    err_body = ""
                    try:
                        err_body = resp.read().decode("utf-8", errors="replace")[:500]
                    except Exception:  # noqa: BLE001
                        pass
                    raise RuntimeError(
                        f"gateway HTTP {resp.status_code} at {upstream_url}: "
                        f"{err_body or '(no body)'}"
                    )

                # OpenAI SSE: each event is a `data: {json}` line, terminated
                # by a literal `data: [DONE]`. Frames carry
                # choices[0].delta.content token deltas; the optional final
                # usage frame (include_usage) carries choices:[] + usage.
                for line in resp.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw:
                        continue
                    if raw == "[DONE]":
                        emit_done({"model": model_used})
                        done_emitted = True
                        break
                    try:
                        frame = json.loads(raw)
                    except json.JSONDecodeError:
                        # Tolerate keepalives / partial frames.
                        continue
                    if not isinstance(frame, dict):
                        continue

                    fm = frame.get("model")
                    if isinstance(fm, str) and fm:
                        model_used = fm

                    choices = frame.get("choices")
                    if isinstance(choices, list) and choices:
                        choice0 = choices[0] or {}
                        delta = choice0.get("delta") or {}
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            if not first_token_seen:
                                first_token_seen = True
                                self._set_run_turn_state(
                                    instance_id=instance_id,
                                    run_id=run_id,
                                    turn_state="streaming",
                                )
                            accumulated_text.append(content)
                            self._write_chunk(
                                outbound_id=outbound_id,
                                seq=seq,
                                payload={"kind": "token", "text": content},
                            )
                            seq += 1
                            if seq >= MAX_CHUNKS_PER_RESPONSE:
                                raise RuntimeError(
                                    f"chunk limit reached ({MAX_CHUNKS_PER_RESPONSE})"
                                )

                        # ── Workflow side channel (P3) ──────────────────────
                        # Sub-agent tree events ride delta.openclaw_workflow
                        # (NEVER delta.content). Reduce → upsert durable
                        # workflowSessions docs. Wrapped so a malformed frame
                        # can never break the chat turn; token deltas above are
                        # deliberately handled first and untouched.
                        wf_event = delta.get("openclaw_workflow")
                        if isinstance(wf_event, dict):
                            try:
                                wf_seq = self._handle_workflow_frame(
                                    wf_event=wf_event,
                                    reducer=wf_reducer,
                                    instance_id=instance_id,
                                    run_id=run_id,
                                    session_id=session_id,
                                    channel_id=wf_channel_id,
                                    thread_id=wf_thread_id,
                                    agent_id=agent_id,
                                    seq=wf_seq,
                                    last_write=wf_last_write,
                                    created=wf_created,
                                )
                            except Exception as exc:  # noqa: BLE001 — never fatal
                                self.log.warning(
                                    "workflow frame reduce/write failed "
                                    "(non-fatal) run_id=%s: %s",
                                    run_id,
                                    exc,
                                )

                if not done_emitted:
                    # Clean EOF without an explicit [DONE] frame.
                    emit_done({"model": model_used, "eof": True})
        except httpx.ReadTimeout as exc:
            # The gateway's full-agent door goes silent during long tool
            # phases (no token deltas), so a stream read timeout usually
            # means "turn still working, just quiet" — not a dead gateway.
            raise GatewayStreamFailure(
                f"gateway stream idle for {self.config.gateway_timeout_seconds:.0f}s "
                f"at {upstream_url} (likely a long tool phase; raise "
                f"GATEWAY_TIMEOUT_SECONDS if turns legitimately run longer)",
                partial_text="".join(accumulated_text),
                model_used=model_used,
            ) from exc
        except httpx.RequestError as exc:
            raise GatewayStreamFailure(
                f"could not reach gateway at {self.config.gateway_url}: {exc}",
                partial_text="".join(accumulated_text),
                model_used=model_used,
            ) from exc
        except RuntimeError as exc:
            # Non-200, chunk-limit, etc. — re-raise carrying whatever already
            # streamed so the failure path can persist the partial reply.
            if isinstance(exc, GatewayStreamFailure):
                raise
            raise GatewayStreamFailure(
                str(exc),
                partial_text="".join(accumulated_text),
                model_used=model_used,
            ) from exc

        elapsed_ms = int((time.monotonic() - gateway_call_start) * 1000)
        full_text = "".join(accumulated_text)

        # Record the model this completed turn actually used for the Watchers
        # UI's currentModel field. Non-fatal, lock-guarded; preserved until the
        # next completed turn overwrites it.
        if model_used:
            with self._turn_lock:
                self._current_model = model_used

        # Finalize outbound + inbound + AgentRun.
        self.db.collection("agentChatOutbound").document(outbound_id).update(
            {
                "status": "completed",
                "completedAt": firestore.SERVER_TIMESTAMP,
                "modelUsed": model_used,
            }
        )
        self.db.collection("agentChatInbound").document(claimed["eventId"]).update(
            {
                "status": "completed",
                "completedAt": firestore.SERVER_TIMESTAMP,
            }
        )
        self._append_run_step(
            instance_id=instance_id,
            run_id=run_id,
            seq=2,
            step_type="tool_result",
            label="Response received",
            content=(
                f"Model: {model_used or 'unknown'}, "
                f"{len(full_text)} chars, {elapsed_ms} ms"
            ),
            tool_name="openclaw_gateway",
            tool_success=True,
            duration_ms=elapsed_ms,
        )
        self._mark_run_completed(
            instance_id=instance_id,
            run_id=run_id,
            elapsed_ms=elapsed_ms,
            summary=(
                f"Replied via {model_used or 'unknown'} in {elapsed_ms} ms "
                f"({len(full_text)} chars)"
            ),
            model_used=model_used,
        )

        # Persist the assistant message to the chat session (Phase 2A-3).
        # Non-fatal — never blocks the chat flow.
        self._persist_chat_session_message(
            instance_id=instance_id,
            user_id=claimed["userId"],
            agent_id=agent_id,
            session_id=session_id,
            role="assistant",
            text=full_text,
            outbound_id=outbound_id,
            agent_run_id=run_id,
            model_used=model_used,
            elapsed_ms=elapsed_ms,
        )

        # Customer-parity session digest (unified memory Plane A).
        # Flag-gated OFF by default; non-fatal, after the stream completes.
        if self.config.session_digest_enabled:
            self._upsert_session_digest(
                instance_id=instance_id,
                user_id=claimed["userId"],
                agent_id=agent_id,
                session_id=session_id,
                user_text=message,
                assistant_text=full_text,
                model_used=model_used,
                elapsed_ms=elapsed_ms,
            )

        # PR-spawn notify-back link wiring. If this completed reply surfaced a
        # BenchAGI PR URL, drop a 'pr' follow-up link so the live
        # notify_back_daemon can watch it to terminal and post an in-chat
        # "✅ done". Fully non-fatal — must never affect the turn.
        self._create_pr_followup_links(
            instance_id=instance_id,
            user_id=claimed["userId"],
            agent_id=agent_id,
            session_id=session_id,
            text=full_text,
        )

    # ── PR-spawn notify-back link creation ──────────────────────────────
    def _create_pr_followup_links(
        self,
        *,
        instance_id: str,
        user_id: str,
        agent_id: str,
        session_id: str,
        text: str,
    ) -> None:
        """Scan a completed reply for BenchAGI PR URLs and, for each unique PR
        number, create a 'pr' follow-up link doc that notify_back_daemon picks
        up. The runtime ONLY writes the link — it never calls `gh` (the daemon
        does the terminal-state check and posts the in-chat follow-up).

        Path: instances/{instance_id}/sessionFollowups/{followupId}

        followupId is DETERMINISTIC — pr_{sessionId}_{pr}, sanitized for a
        Firestore id — and the write is create-if-not-exists, so:
          • the same PR re-mentioned across later turns never duplicates, and
          • a link the daemon already flipped to 'posted'/'cancelled' is never
            reset back to 'pending'.

        Non-fatal: every failure is swallowed (logged) so a bad scan/write can
        never affect the chat turn. Reuses self.db + firestore.SERVER_TIMESTAMP.
        """
        try:
            if not text:
                return
            prs = sorted({m.group(1) for m in PR_URL_RE.finditer(text)}, key=int)
            if not prs:
                return
            followups = (
                self.db.collection("instances")
                .document(instance_id)
                .collection("sessionFollowups")
            )
            for pr in prs:
                try:
                    followup_id = _sanitize_firestore_id(f"pr_{session_id}_{pr}")
                    link_ref = followups.document(followup_id)

                    @firestore.transactional
                    def _create_if_absent(tx, ref=link_ref, fid=followup_id, num=pr):
                        snap = ref.get(transaction=tx)
                        if snap.exists:
                            return False  # already linked — never reset
                        tx.set(
                            ref,
                            {
                                "followupId": fid,
                                "instanceId": instance_id,
                                "sessionId": session_id,
                                "agentId": agent_id,
                                "userId": user_id,
                                "workType": "pr",
                                "workRef": str(num),
                                "status": "pending",
                                "createdAt": firestore.SERVER_TIMESTAMP,
                            },
                        )
                        return True

                    created = _create_if_absent(self.db.transaction())
                    if created:
                        self.log.info(
                            "pr notify-back link created session_id=%s pr=%s id=%s",
                            session_id,
                            pr,
                            followup_id,
                        )
                except Exception as exc:  # noqa: BLE001 — one bad PR must not block others
                    self.log.warning(
                        "create_pr_followup_link failed (non-fatal) "
                        "session_id=%s pr=%s: %s",
                        session_id,
                        pr,
                        exc,
                    )
        except Exception as exc:  # noqa: BLE001 — non-fatal by design
            self.log.warning(
                "create_pr_followup_links failed (non-fatal) session_id=%s: %s",
                session_id,
                exc,
            )

    # ── Failure path ────────────────────────────────────────────────────

    def _mark_failure(
        self,
        *,
        event_id: str,
        outbound_id: str,
        run_id: str,
        error_message: str,
        error_code: str,
        partial_text: str = "",
        model_used: Optional[str] = None,
    ) -> None:
        # Inbound
        try:
            self.db.collection("agentChatInbound").document(event_id).update(
                {
                    "status": "failed",
                    "completedAt": firestore.SERVER_TIMESTAMP,
                    "dispatchError": error_message[:1000],
                }
            )
        except Exception:  # noqa: BLE001
            self.log.exception("failed to mark inbound failed event_id=%s", event_id)

        # Outbound + a final error chunk (so the SSE relay can tell the user).
        try:
            self.db.collection("agentChatOutbound").document(outbound_id).update(
                {
                    "status": "failed",
                    "completedAt": firestore.SERVER_TIMESTAMP,
                    "error": error_message[:1000],
                }
            )
            self._write_chunk(
                outbound_id=outbound_id,
                seq=999_999,  # high seq so it lands last regardless of ordering
                payload={
                    "kind": "error",
                    "errorCode": error_code,
                    "errorMessage": error_message[:500],
                },
            )
        except Exception:  # noqa: BLE001
            self.log.exception(
                "failed to mark outbound failed outbound_id=%s", outbound_id
            )

        # AgentRun
        try:
            # We need the instanceId to locate the run. Re-read inbound.
            inbound_snap = (
                self.db.collection("agentChatInbound").document(event_id).get()
            )
            if inbound_snap.exists:
                inbound = inbound_snap.to_dict() or {}
                # Persist whatever streamed before the failure so the reply
                # survives rehydration instead of vanishing from the session
                # (2026-06-12 incident). Non-fatal by design.
                if (
                    partial_text
                    and inbound.get("instanceId")
                    and inbound.get("userId")
                    and inbound.get("agentId")
                    and inbound.get("sessionId")
                ):
                    self._persist_chat_session_message(
                        instance_id=inbound["instanceId"],
                        user_id=inbound["userId"],
                        agent_id=inbound["agentId"],
                        session_id=inbound["sessionId"],
                        role="assistant",
                        text=partial_text,
                        outbound_id=outbound_id,
                        agent_run_id=run_id,
                        model_used=model_used,
                        error_code=error_code,
                    )
                if inbound.get("instanceId"):
                    self._mark_run_failed(
                        instance_id=inbound["instanceId"],
                        run_id=run_id,
                        error=error_message,
                    )
        except Exception:  # noqa: BLE001
            self.log.exception("failed to mark AgentRun failed run_id=%s", run_id)


# ── Snapshot listener + main loop ────────────────────────────────────────


class RuntimeService:
    def __init__(self, config: RuntimeConfig, log: logging.Logger):
        self.config = config
        self.log = log
        self.db = init_firestore(config)
        self.http = httpx.Client()
        self.executor = ThreadPoolExecutor(
            max_workers=config.max_concurrent_inbound,
            thread_name_prefix="chat-runtime",
        )
        self.processor = InboundProcessor(config, self.db, self.http, log)
        self._stop_event = threading.Event()
        self._watch = None  # type: ignore[assignment]
        self._hostname = socket.gethostname()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._reaper_thread: Optional[threading.Thread] = None
        # ms-epoch stamped ONCE at process start; preserved across every beat
        # so the Watchers UI can show a stable "online since" for this machine.
        self._online_since = int(time.time() * 1000)

    # ── Heartbeat (powers /api/aurelius/bridge-status liveness) ──────────

    def _write_heartbeat(self) -> None:
        """Write instances/{id}/gatewayStatus/chatRuntime as a DEDICATED
        liveness signal for THIS web-chat listener — distinct from the
        generic `current` gateway-status doc (which a separate process keeps
        fresh regardless of whether the chat runtime is up). The web's
        bridge-status endpoint consumes this to prove the listener is alive."""
        gateway_ok = False
        try:
            resp = self.http.get(f"{self.config.gateway_url}/health", timeout=5.0)
            gateway_ok = resp.status_code == 200
        except Exception:  # noqa: BLE001
            gateway_ok = False
        # Live in-flight telemetry from the processor (Watchers UI). Read under
        # the processor's turn lock; fully non-fatal — a bad read must never
        # block a heartbeat, so fall back to safe defaults.
        active_turns = 0
        current_run_id: Optional[str] = None
        current_model: Optional[str] = None
        try:
            proc = self.processor
            with proc._turn_lock:
                active_turns = proc._active_turns
                current_run_id = proc._current_run_id
                current_model = proc._current_model
        except Exception:  # noqa: BLE001
            pass
        # launchd vs nohup: XPC_SERVICE_NAME is set by launchd and absent under
        # nohup. ppid is NOT a reliable discriminator on macOS (both report 1).
        supervised = "launchd" if os.getenv("XPC_SERVICE_NAME") else "nohup"
        payload = {
            "online": True,
            "lastSeenAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "source": "agent-chat-runtime",
            "host": self._hostname,
            "instanceId": self.config.instance_id,
            "machineId": self.config.machine_id or None,
            "machineName": self.config.machine_name or None,
            "capabilities": ["messages"],
            "gatewayHealthy": gateway_ok,
            # ── Enriched presence (Watchers UI) ──────────────────────────
            "role": "fallback" if self.config.fallback_for else "primary",
            "fallbackFor": self.config.fallback_for or None,
            "gatewayUrl": self.config.gateway_url,
            "onlineSince": self._online_since,
            "supervised": supervised,
            "ppid": os.getppid(),
            "activeTurns": active_turns,
            "currentRunId": current_run_id,
            "currentModel": current_model,
        }
        # The legacy `chatRuntime` doc backs bridge-status; a per-machine
        # `chatRuntime-{id}` doc backs the console device indicator + the
        # fallback's primary-staleness check. Write both.
        doc_ids = ["chatRuntime"]
        if self.config.machine_id:
            doc_ids.append(f"chatRuntime-{self.config.machine_id}")
        status_col = (
            self.db.collection("instances")
            .document(self.config.instance_id)
            .collection("gatewayStatus")
        )
        for doc_id in doc_ids:
            try:
                status_col.document(doc_id).set(payload, merge=True)
            except Exception:  # noqa: BLE001
                self.log.warning(
                    "heartbeat write failed (non-fatal) doc=%s", doc_id, exc_info=True
                )

    def _write_offline(self) -> None:
        """Flip to offline on clean shutdown so bridge-status reflects reality
        immediately instead of waiting out the 10-min freshness TTL."""
        status_col = (
            self.db.collection("instances")
            .document(self.config.instance_id)
            .collection("gatewayStatus")
        )
        doc_ids = ["chatRuntime"]
        if self.config.machine_id:
            doc_ids.append(f"chatRuntime-{self.config.machine_id}")
        for doc_id in doc_ids:
            try:
                status_col.document(doc_id).set(
                    {
                        "online": False,
                        "lastSeenAt": firestore.SERVER_TIMESTAMP,
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        "source": "agent-chat-runtime",
                    },
                    merge=True,
                )
            except Exception:  # noqa: BLE001
                pass

    def _heartbeat_loop(self) -> None:
        # Immediate write so bridge-status flips ready without waiting a cycle.
        self._write_heartbeat()
        while not self._stop_event.wait(self.config.heartbeat_interval_seconds):
            self._write_heartbeat()

    # ── Orphan reaper loop ───────────────────────────────────────────────

    def _reaper_loop(self) -> None:
        """Periodically reap docs a dead runtime left in 'processing' forever.
        Reuses the processor's transactional helpers. The first sweep is delayed
        one full interval so a turn that's legitimately in flight at startup is
        never racing a cold reaper (the TTL already protects it, but this keeps
        startup quiet). Fully non-fatal."""
        while not self._stop_event.wait(REAPER_INTERVAL_SECONDS):
            try:
                n = self.processor.reap_orphans()
                if n:
                    self.log.info("reaper sweep: reaped %d orphan(s)", n)
            except Exception:  # noqa: BLE001 — never let the loop die
                self.log.warning("reaper loop sweep failed (non-fatal)", exc_info=True)

    def start(self) -> None:
        query = (
            self.db.collection("agentChatInbound")
            .where(filter=FieldFilter("instanceId", "==", self.config.instance_id))
            .where(filter=FieldFilter("status", "==", "pending"))
        )

        def on_snapshot(col_snapshot, changes, _read_time):
            for change in changes:
                # ADDED fires for both brand-new docs and the initial
                # backlog (everything matching the query at subscribe time).
                if change.type.name not in ("ADDED", "MODIFIED"):
                    continue
                snap = change.document
                data = snap.to_dict() or {}
                if data.get("status") != "pending":
                    continue
                event_id = snap.id
                self.log.info("dispatching event_id=%s", event_id)
                self.executor.submit(self._safe_process, event_id)

        self._watch = query.on_snapshot(on_snapshot)
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, name="heartbeat", daemon=True
        )
        self._heartbeat_thread.start()
        self._reaper_thread = threading.Thread(
            target=self._reaper_loop, name="reaper", daemon=True
        )
        self._reaper_thread.start()
        reaper_ttl = self.processor._reaper_ttl_seconds(
            self.config.gateway_timeout_seconds
        )
        self.log.info(
            "watching agentChatInbound where instanceId=%s AND status=pending "
            "(heartbeat every %ss, reaper every %ss, reap TTL %.0fs)",
            self.config.instance_id,
            self.config.heartbeat_interval_seconds,
            REAPER_INTERVAL_SECONDS,
            reaper_ttl,
        )

    def _safe_process(self, event_id: str) -> None:
        try:
            self.processor.process(event_id)
        except Exception:  # noqa: BLE001
            self.log.exception("uncaught exception in handler event_id=%s", event_id)

    def wait_forever(self) -> None:
        while not self._stop_event.is_set():
            self._stop_event.wait(60)

    def stop(self) -> None:
        self.log.info("shutting down")
        self._stop_event.set()
        if self._watch is not None:
            try:
                self._watch.unsubscribe()
            except Exception:  # noqa: BLE001
                pass
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=5)
        if self._reaper_thread is not None:
            self._reaper_thread.join(timeout=5)
        self._write_offline()
        self.executor.shutdown(wait=True, cancel_futures=False)
        try:
            self.http.close()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    config = RuntimeConfig.from_env()
    log = configure_logging(config.log_level)
    log.info("starting agent-chat-runtime for instance_id=%s", config.instance_id)
    log.info("gateway_url=%s", config.gateway_url)

    service = RuntimeService(config, log)

    def handle_signal(signum, _frame):
        log.info("received signal %s", signum)
        service.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        service.start()
        service.wait_forever()
    finally:
        service.stop()

    log.info("exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
