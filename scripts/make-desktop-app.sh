#!/usr/bin/env bash
# make-desktop-app.sh — build the clickable desktop-seat app (default "Aurelius
# Claude"). Clicking it runs `benchagi desktop --agent <agent>` headlessly (no
# Terminal window): the CLI provisions the seat workspace, then the Claude Code
# DESKTOP app opens on it via the claude://code/new deep link.
#
# The app pins the exact CLI that created it when BENCHAGI_CLI_NODE +
# BENCHAGI_CLI_ENTRY are provided, then falls back to PATH — same contract as
# make-dock-app.sh.
#
# Idempotent + reversible:  rm -rf "$HOME/Applications/<name>.app"
# Env overrides: BENCHAGI_DESKTOP_AGENT (default aurelius),
# BENCHAGI_DESKTOP_APP_NAME (default "<Agent> Claude"), BENCHAGI_APP_DIR
# (default ~/Applications), BENCHAGI_ICON (default ../assets/benchagi-icon.png).
# BENCHAGI_CLI_NODE/BENCHAGI_CLI_ENTRY/BENCHAGI_CLI_CMD pin the CLI.
# Set BENCHAGI_SKIP_DOCK_PIN=1 to build the app without pinning it to the Dock.
set -euo pipefail

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  echo "make-desktop-app: macOS only — skipped."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICON="${BENCHAGI_ICON:-$SCRIPT_DIR/../assets/benchagi-icon.png}"
APP_DIR="${BENCHAGI_APP_DIR:-$HOME/Applications}"
AGENT="${BENCHAGI_DESKTOP_AGENT:-aurelius}"
AGENT_CAP="$(printf '%s' "$AGENT" | awk '{ print toupper(substr($0,1,1)) substr($0,2) }')"
APP_NAME="${BENCHAGI_DESKTOP_APP_NAME:-$AGENT_CAP Claude}"
APP="$APP_DIR/$APP_NAME.app"

# 1) Headless applet: run the embedded launch command directly — no Terminal.
#    `benchagi desktop` exits right after firing the deep link, so the applet
#    finishes fast; failures surface as a dialog instead of a lost window.
mkdir -p "$APP_DIR"
[ -e "$APP" ] && rm -rf "$APP"
tmp="$(mktemp -d)"
cat > "$tmp/d.applescript" <<'OSA'
on run
  set me_path to POSIX path of (path to me)
  set cmd to quoted form of (me_path & "Contents/Resources/launch.command")
  try
    do shell script cmd
  on error errMsg
    display dialog errMsg buttons {"OK"} default button 1 with title "BenchAGI desktop seat" with icon caution
  end try
end run
OSA
/usr/bin/osacompile -o "$APP" "$tmp/d.applescript"
rm -rf "$tmp"

# 2) Embedded launch command — prefer the install-time CLI, then PATH fallbacks.
shell_quote() {
  printf '%q' "$1"
}

CLI_NODE="${BENCHAGI_CLI_NODE:-}"
CLI_ENTRY="${BENCHAGI_CLI_ENTRY:-}"
CLI_CMD="${BENCHAGI_CLI_CMD:-}"
if [ -z "$CLI_CMD" ] && command -v benchagi >/dev/null 2>&1; then
  CLI_CMD="$(command -v benchagi)"
fi

cat > "$APP/Contents/Resources/launch.command" <<LAUNCH
#!/usr/bin/env bash
BENCHAGI_CLI_NODE=$(shell_quote "$CLI_NODE")
BENCHAGI_CLI_ENTRY=$(shell_quote "$CLI_ENTRY")
BENCHAGI_CLI_CMD=$(shell_quote "$CLI_CMD")
AGENT=$(shell_quote "$AGENT")

if [ -n "\$BENCHAGI_CLI_NODE" ] && [ -x "\$BENCHAGI_CLI_NODE" ] && [ -n "\$BENCHAGI_CLI_ENTRY" ] && [ -f "\$BENCHAGI_CLI_ENTRY" ]; then
  exec "\$BENCHAGI_CLI_NODE" "\$BENCHAGI_CLI_ENTRY" desktop --agent "\$AGENT"
fi

if [ -n "\$BENCHAGI_CLI_CMD" ] && [ -x "\$BENCHAGI_CLI_CMD" ]; then
  exec "\$BENCHAGI_CLI_CMD" desktop --agent "\$AGENT"
fi

export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
if command -v benchagi >/dev/null 2>&1; then exec benchagi desktop --agent "\$AGENT"; fi
echo "BenchAGI CLI isn't installed. Install it, then click again:"
echo "  brew install BenchAGI/tap/benchagi"
exit 1
LAUNCH
chmod +x "$APP/Contents/Resources/launch.command"

# 3) Bench glyph icon (CFBundleIconName is the key modern macOS actually reads).
if [ -f "$ICON" ]; then
  iset="$(mktemp -d)/DesktopSeat.iconset"; mkdir -p "$iset"
  for s in 16 32 128 256 512; do
    /usr/bin/sips -z "$s" "$s" "$ICON" --out "$iset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s * 2)); /usr/bin/sips -z "$d" "$d" "$ICON" --out "$iset/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  /usr/bin/iconutil -c icns "$iset" -o "$APP/Contents/Resources/DesktopSeat.icns" 2>/dev/null || true
  cp "$APP/Contents/Resources/DesktopSeat.icns" "$APP/Contents/Resources/applet.icns" 2>/dev/null || true
  rm -rf "$(dirname "$iset")"
fi

PL="$APP/Contents/Info.plist"
set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PL" 2>/dev/null || true; }
[ -f "$ICON" ] && set_plist CFBundleIconFile DesktopSeat && set_plist CFBundleIconName DesktopSeat
set_plist CFBundleName "$APP_NAME"
set_plist CFBundleIdentifier "com.benchagi.desktop-seat-$AGENT"
/usr/bin/touch "$APP"
# Ad-hoc sign so a LOCALLY-built app opens cleanly. Public .dmg/cask distribution
# needs a real Developer ID signature + notarization (see scripts/build-dmg.sh).
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
/usr/bin/xattr -cr "$APP" 2>/dev/null || true
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1 || true

if [ "${BENCHAGI_SKIP_DOCK_PIN:-0}" != "1" ]; then
  APP_URL="file://$APP/"
  if ! /usr/bin/defaults read com.apple.dock persistent-apps 2>/dev/null | /usr/bin/grep -Fq "$APP_URL"; then
    /usr/bin/defaults write com.apple.dock persistent-apps -array-add \
      "{\"tile-data\"={\"file-data\"={\"_CFURLString\"=\"$APP_URL\"; \"_CFURLStringType\"=15;}; \"file-label\"=\"$APP_NAME\";}; \"tile-type\"=\"file-tile\";}"
    /usr/bin/killall Dock >/dev/null 2>&1 || true
  fi
fi

echo "✓ $APP_NAME.app → $APP"
echo "  Click it → seat workspace provisions → Claude Code desktop opens as $AGENT_CAP."
