#!/usr/bin/env bash
# disk-watchdog.sh — guard the volume that holds ~/.openclaw against fill-up.
#
# WHY: the memory-core reindex tmp-leak (see reap-memory-tmp.sh) plus large
# *.sqlite stores can fill a disk to ~100%. Log rotators only watch
# ~/.openclaw/logs/*.log — they never see ~/.openclaw/memory. This watchdog adds
# the missing VISIBILITY: every ~10 min it checks free space on the volume
# backing ~/.openclaw and (optionally) posts a Slack alert when free space drops
# below the threshold.
#
# Alerting is OPTIONAL. If DISK_WATCH_CHANNEL is set and a SLACK_BOT_TOKEN can be
# read from DISK_WATCH_BRIDGE_ENV, the watchdog posts chat.postMessage; otherwise
# it just logs locally. De-duped via a state file so a persisting low-disk
# condition does not spam every cycle; posts a single ALL-CLEAR when it recovers.
# Alert-only — it never deletes anything (the reaper does cleanup).
set -uo pipefail

# --- thresholds (override via plist EnvironmentVariables) ---
WATCH_PATH="${DISK_WATCH_PATH:-$HOME/.openclaw}"
THRESHOLD_GIB="${DISK_WATCH_THRESHOLD_GIB:-10}"

# --- alert plumbing (all optional) ---
# Slack channel id to post into. Empty = alerting disabled (log only).
HARNESS_CHANNEL="${DISK_WATCH_CHANNEL:-}"
# A file containing a `SLACK_BOT_TOKEN=...` line, read at runtime. Empty/missing
# = alerting disabled (log only).
BRIDGE_ENV="${DISK_WATCH_BRIDGE_ENV:-}"
LOGDIR="${DISK_WATCH_LOGDIR:-$HOME/Library/Logs/BenchAGI}"
mkdir -p "$LOGDIR"
HEALTHLOG="$LOGDIR/disk-watchdog.log"
STATEF="$LOGDIR/disk-watchdog.state"   # holds "ALERT" or "OK"
HOSTLABEL="${DISK_WATCH_HOST:-$(hostname -s 2>/dev/null || echo host)}"
now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

log() { printf '%s %s\n' "$now" "$*" >> "$HEALTHLOG"; }

post_slack() {
  local text="$1" tok payload
  [ -n "$HARNESS_CHANNEL" ] || { log "no DISK_WATCH_CHANNEL; skip post"; return 0; }
  [ -n "$BRIDGE_ENV" ] && [ -f "$BRIDGE_ENV" ] || { log "no bridge env; skip post"; return 0; }
  tok="$(grep -m1 '^SLACK_BOT_TOKEN=' "$BRIDGE_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')"
  [ -n "$tok" ] || { log "no SLACK_BOT_TOKEN; skip post"; return 0; }
  command -v jq >/dev/null 2>&1 || { log "no jq; skip post"; return 0; }
  payload="$(jq -nc --arg c "$HARNESS_CHANNEL" --arg t "$text" \
    '{channel:$c,text:$t,unfurl_links:false,unfurl_media:false}' 2>/dev/null)"
  [ -n "$payload" ] || return 0
  curl -sS --max-time 8 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $tok" -H 'content-type: application/json' \
    -d "$payload" >/dev/null 2>&1 || log "slack post failed (network?)"
}

# Resolve free space on the volume backing WATCH_PATH. df -k → 1024-byte blocks;
# avail is column 4. Convert to integer GiB (floor) for a clean comparison.
avail_kb="$(df -k "$WATCH_PATH" 2>/dev/null | awk 'NR==2{print $4}')"
if ! printf '%s' "${avail_kb:-}" | grep -Eq '^[0-9]+$'; then
  log "could not read df for $WATCH_PATH (avail_kb='${avail_kb:-}'); skipping cycle"
  exit 0
fi
avail_gib=$(( avail_kb / 1024 / 1024 ))

prev="$(cat "$STATEF" 2>/dev/null || echo 'OK')"

if [ "$avail_gib" -lt "$THRESHOLD_GIB" ]; then
  log "LOW disk on $HOSTLABEL: ${avail_gib}GiB free at $WATCH_PATH (<${THRESHOLD_GIB}GiB)"
  if [ "$prev" != "ALERT" ]; then
    # Best-effort: surface the biggest offenders to make the alert actionable.
    big="$(du -sh "$WATCH_PATH"/memory/*.sqlite "$WATCH_PATH"/memory/*.tmp-* 2>/dev/null \
            | sort -rh | head -5 | awk '{printf "%s %s; ", $1, $2}')"
    post_slack ":rotating_light: disk-watchdog [$HOSTLABEL]: only ${avail_gib}GiB free on the volume holding ${WATCH_PATH} (threshold ${THRESHOLD_GIB}GiB). Top: ${big:-n/a}"
    printf 'ALERT' > "$STATEF"
  fi
else
  if [ "$prev" = "ALERT" ]; then
    post_slack ":white_check_mark: disk-watchdog [$HOSTLABEL]: RECOVERED — ${avail_gib}GiB free on ${WATCH_PATH} (>=${THRESHOLD_GIB}GiB)."
    log "RECOVERED on $HOSTLABEL: ${avail_gib}GiB free"
  fi
  printf 'OK' > "$STATEF"
fi
exit 0
