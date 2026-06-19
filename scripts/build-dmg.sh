#!/usr/bin/env bash
# build-dmg.sh — package BenchAGI.app into a drag-to-Applications .dmg for download
# distribution (e.g. benchagi.com).
#
# IMPORTANT (read before publishing):
#   1. The app this builds is a LAUNCHER that runs the `benchagi` CLI — it expects
#      the CLI on PATH (brew/npm). For a fully self-contained consumer download,
#      ship the Tauri app (apps/bench-desktop) instead, or bundle node+CLI here.
#   2. For PUBLIC download you MUST Developer-ID sign + notarize the .app, else
#      macOS Gatekeeper quarantine-blocks it. Steps after this script builds:
#        codesign --deep --options runtime --sign "Developer ID Application: <Team>" BenchAGI.app
#        xcrun notarytool submit BenchAGI.dmg --keychain-profile <profile> --wait
#        xcrun stapler staple BenchAGI.dmg
#   Until notarized this .dmg is internal/testing only.
#
# Usage: build-dmg.sh [out-dir]   (default: ./dist-dmg)
set -euo pipefail
[ "$(uname -s 2>/dev/null)" = "Darwin" ] || { echo "build-dmg: macOS only" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$PWD/dist-dmg}"
STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/BenchAGI"
mkdir -p "$STAGE"

# Build the .app into the staging folder (reuses the single source of truth).
# Generic DMGs must not capture the build machine's local benchagi path.
BENCHAGI_APP_DIR="$STAGE" BENCHAGI_NO_CLI_PIN=1 bash "$SCRIPT_DIR/make-dock-app.sh"
ln -s /Applications "$STAGE/Applications" # drag-target convenience in the dmg window

mkdir -p "$OUT"
hdiutil create -volname "BenchAGI" -srcfolder "$STAGE" -ov -format UDZO "$OUT/BenchAGI.dmg" >/dev/null
rm -rf "$STAGE_PARENT"
echo "✓ $OUT/BenchAGI.dmg"
echo "  (sign + notarize before hosting on benchagi.com — see header)"
