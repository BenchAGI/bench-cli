#!/usr/bin/env bash
# make-dock-app.sh — build the clickable "BenchAGI" Dock app (the glyph). Clicking it
# opens a terminal running `benchagi`: boot cinematic → agent selector → choose a
# CLOUD seat (Enter) or a LOCAL Claude Code seat (l).
#
# The app is SELF-CONTAINED (its launch command lives inside the bundle and resolves
# `benchagi` on PATH at click time) so the same build works for: local install
# (scripts/install.sh), the Homebrew cask, and the .dmg (scripts/build-dmg.sh).
#
# Idempotent + reversible:  rm -rf "$HOME/Applications/BenchAGI.app"
# Env overrides: BENCHAGI_APP_DIR (default ~/Applications), BENCHAGI_ICON (default ../assets/benchagi-icon.png).
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
  set cmd to me_path & "Contents/Resources/launch.command"
  do shell script "/usr/bin/open -a Terminal " & quoted form of cmd
end run
OSA
/usr/bin/osacompile -o "$APP" "$tmp/b.applescript"
rm -rf "$tmp"

# 2) Embedded launch command — resolves benchagi on PATH at click time.
cat > "$APP/Contents/Resources/launch.command" <<'LAUNCH'
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:$PATH"
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

echo "✓ BenchAGI.app → $APP"
echo "  Drag it to your Dock. Click → boot → pick your agent → cloud or local seat."
