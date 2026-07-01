#!/usr/bin/env bash
# make-dock-app.sh — build the clickable "BenchAGI" Dock app (the glyph). Clicking it
# opens a terminal running `benchagi`: boot cinematic → agent selector → configure
# Cloud, Direct, Claude, or Codex seat mode → launch.
#
# The app pins the exact CLI that created it when BENCHAGI_CLI_NODE +
# BENCHAGI_CLI_ENTRY are provided, then falls back to PATH. This keeps a stale
# Homebrew formula from shadowing a newer npm/curl install in the Dock launcher.
#
# Idempotent + reversible:  rm -rf "$HOME/Applications/BenchAGI.app"
# Env overrides: BENCHAGI_APP_DIR (default ~/Applications), BENCHAGI_ICON (default ../assets/benchagi-icon.png).
# BENCHAGI_CLI_NODE + BENCHAGI_CLI_ENTRY pin the launcher to a specific CLI.
# BENCHAGI_CLI_CMD pins a command path fallback when the JS entry cannot be used.
# BENCHAGI_NO_CLI_PIN=1 builds a PATH-only launcher for generic DMG artifacts.
# Set BENCHAGI_SKIP_DOCK_PIN=1 to build the app without pinning it to the Dock.
set -euo pipefail

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  echo "make-dock-app: macOS only — skipped."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICON="${BENCHAGI_ICON:-$SCRIPT_DIR/../assets/benchagi-icon.png}"
APP_DIR="${BENCHAGI_APP_DIR:-$HOME/Applications}"
APP="$APP_DIR/BenchAGI.app"

# 1) Applet that opens Terminal on its OWN embedded launch command (self-contained).
mkdir -p "$APP_DIR"
[ -e "$APP" ] && rm -rf "$APP"
tmp="$(mktemp -d)"
cat > "$tmp/b.applescript" <<'OSA'
on run
  set me_path to POSIX path of (path to me)
  set cmd to quoted form of (me_path & "Contents/Resources/launch.command")
  tell application "Terminal"
    activate
    set benchTab to do script cmd
    try
      set current settings of benchTab to settings set "Pro"
    on error
      try
        set current settings of benchTab to settings set "Clear Dark"
      on error
        try
          set current settings of benchTab to settings set "Silver Aerogel"
        end try
      end try
    end try
    try
      set custom title of benchTab to "BenchAGI"
    end try
    try
      set number of columns of front window to 120
      set number of rows of front window to 34
    end try
  end tell
end run
OSA
/usr/bin/osacompile -o "$APP" "$tmp/b.applescript"
rm -rf "$tmp"

# 2) Embedded launch command — prefer the install-time CLI, then PATH fallbacks.
shell_quote() {
  printf '%q' "$1"
}

CLI_NODE="${BENCHAGI_CLI_NODE:-}"
CLI_ENTRY="${BENCHAGI_CLI_ENTRY:-}"
CLI_CMD="${BENCHAGI_CLI_CMD:-}"
if [ "${BENCHAGI_NO_CLI_PIN:-0}" = "1" ]; then
  CLI_NODE=""
  CLI_ENTRY=""
  CLI_CMD=""
elif [ -z "$CLI_CMD" ] && command -v benchagi >/dev/null 2>&1; then
  CLI_CMD="$(command -v benchagi)"
fi

cat > "$APP/Contents/Resources/launch.command" <<LAUNCH
#!/usr/bin/env bash
BENCHAGI_CLI_NODE=$(shell_quote "$CLI_NODE")
BENCHAGI_CLI_ENTRY=$(shell_quote "$CLI_ENTRY")
BENCHAGI_CLI_CMD=$(shell_quote "$CLI_CMD")

if [ -n "\$BENCHAGI_CLI_NODE" ] && [ -x "\$BENCHAGI_CLI_NODE" ] && [ -n "\$BENCHAGI_CLI_ENTRY" ] && [ -f "\$BENCHAGI_CLI_ENTRY" ]; then
  exec "\$BENCHAGI_CLI_NODE" "\$BENCHAGI_CLI_ENTRY"
fi

if [ -n "\$BENCHAGI_CLI_CMD" ] && [ -x "\$BENCHAGI_CLI_CMD" ]; then
  exec "\$BENCHAGI_CLI_CMD"
fi

export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
if command -v benchagi >/dev/null 2>&1; then exec benchagi; fi
echo "BenchAGI CLI isn't installed yet. Install it with:"
echo "  brew install BenchAGI/tap/benchagi"
echo "  (or)  curl -fsSL https://raw.githubusercontent.com/BenchAGI/bench-cli/main/scripts/install.sh | sh"
echo; echo "Then click BenchAGI again. Press any key to close…"; read -r -n 1 _
LAUNCH
chmod +x "$APP/Contents/Resources/launch.command"

# 3) Bench glyph icon (CFBundleIconName is the key modern macOS actually reads).
if [ -f "$ICON" ]; then
  iset="$(mktemp -d)/BenchAGI.iconset"; mkdir -p "$iset"
  for s in 16 32 128 256 512; do
    /usr/bin/sips -z "$s" "$s" "$ICON" --out "$iset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s * 2)); /usr/bin/sips -z "$d" "$d" "$ICON" --out "$iset/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  /usr/bin/iconutil -c icns "$iset" -o "$APP/Contents/Resources/BenchAGI.icns" 2>/dev/null || true
  cp "$APP/Contents/Resources/BenchAGI.icns" "$APP/Contents/Resources/applet.icns" 2>/dev/null || true
  rm -rf "$(dirname "$iset")"
fi

PL="$APP/Contents/Info.plist"
set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PL" 2>/dev/null || true; }
[ -f "$ICON" ] && set_plist CFBundleIconFile BenchAGI && set_plist CFBundleIconName BenchAGI
set_plist CFBundleName BenchAGI
set_plist CFBundleIdentifier com.benchagi.benchagi-launcher
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
      "{\"tile-data\"={\"file-data\"={\"_CFURLString\"=\"$APP_URL\"; \"_CFURLStringType\"=15;}; \"file-label\"=\"BenchAGI\";}; \"tile-type\"=\"file-tile\";}"
    /usr/bin/killall Dock >/dev/null 2>&1 || true
  fi
fi

echo "✓ BenchAGI.app → $APP"
echo "  Click the Dock glyph → boot → pick your agent → cloud or local seat."
