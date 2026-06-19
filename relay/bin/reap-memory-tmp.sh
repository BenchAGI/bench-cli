#!/usr/bin/env bash
# reap-memory-tmp.sh — reclaim leaked memory-core reindex scratch files.
#
# ROOT CAUSE (OpenClaw memory-core atomic reindex):
#   The atomic reindex writes `${dbPath}.tmp-${randomUUID()}` (+ -wal/-shm)
#   during a long build() phase, then atomically swaps. It ONLY removes the tmp
#   on a *caught* exception. A HARD death during build() (SIGKILL/OOM/power-loss/
#   launchd bootout — e.g. a gateway nightly-restart firing mid-reindex) skips the
#   catch, orphaning the tmp triple forever. The random UUID name means a later
#   run can never re-find its own orphan. The swap step likewise creates a
#   `${target}.backup-${randomUUID()}` that leaks if the process dies between the
#   two moves. Each orphan is ~the full DB size and they stack with every cron
#   tick → disk fills.
#
# This reaper is SAFE BY CONSTRUCTION: it deletes a candidate ONLY when ALL hold:
#   1. name matches ${STEM}.tmp-* or ${STEM}.backup-* (incl. -wal/-shm siblings)
#   2. file mtime older than REAP_AGE_HOURS (default 2h) — never touches a fresh
#      reindex that is still legitimately writing
#   3. lsof reports NO open holder on the file — an in-flight reindex is protected
#
# It sweeps every memory root that exists on this host. Idempotent, no sudo.
# Run from a LaunchAgent on a StartInterval.
set -uo pipefail

REAP_AGE_HOURS="${REAP_AGE_HOURS:-2}"
# The on-disk DB filename stem whose scratch files we reap (without extension).
REAP_DB_STEM="${REAP_DB_STEM:-memory}"
LOGDIR="${REAP_LOGDIR:-$HOME/Library/Logs/BenchAGI}"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/reap-memory-tmp.log"
LSOF="${LSOF_BIN:-/usr/sbin/lsof}"
now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Memory roots to sweep. Extra roots can be appended via REAP_EXTRA_ROOTS
# (colon-separated). Roots that do not exist on this host are silently skipped.
ROOTS=(
  "$HOME/.openclaw/memory"
)
if [ -n "${REAP_EXTRA_ROOTS:-}" ]; then
  IFS=':' read -r -a _extra <<< "$REAP_EXTRA_ROOTS"
  ROOTS+=("${_extra[@]}")
fi

log() { printf '%s %s\n' "$now" "$*" >> "$LOG"; }

reaped=0
freed_bytes=0
skipped_held=0
skipped_fresh=0

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  # Find tmp/backup scratch (and their -wal/-shm siblings) older than the age gate.
  # -mmin avoids any locale/date math; REAP_AGE_HOURS*60.
  while IFS= read -r -d '' f; do
    # Gate 3: must be lsof-clear. lsof exits non-zero when no process holds it.
    if "$LSOF" -- "$f" >/dev/null 2>&1; then
      skipped_held=$((skipped_held+1))
      log "SKIP held=$f"
      continue
    fi
    sz="$(stat -f%z "$f" 2>/dev/null || echo 0)"
    if rm -f -- "$f"; then
      reaped=$((reaped+1))
      freed_bytes=$((freed_bytes+sz))
      log "REAP $f (${sz} bytes)"
    else
      log "FAIL rm $f"
    fi
  done < <(find "$root" \
              \( -name "${REAP_DB_STEM}.sqlite.tmp-*" -o -name "${REAP_DB_STEM}.sqlite.backup-*" \) \
              -type f -mmin +$((REAP_AGE_HOURS*60)) -print0 2>/dev/null)
done

freed_gib="$(awk "BEGIN{printf \"%.2f\", $freed_bytes/1073741824}")"
log "DONE reaped=$reaped freed=${freed_gib}GiB skipped_held=$skipped_held"
# stdout line for the LaunchAgent log
printf '%s reap-memory-tmp: reaped=%s freed=%sGiB held=%s\n' "$now" "$reaped" "$freed_gib" "$skipped_held"
exit 0
