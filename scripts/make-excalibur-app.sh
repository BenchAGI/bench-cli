#!/usr/bin/env bash
# Build the canonical Excalibur One-Surface macOS launcher.
#
# Unlike the legacy Native/Aurelius preview and BenchAGI launcher, this bundle
# pins one exact Node runtime + excalibur entry and refuses to open a session
# until `excalibur doctor --launch-check` verifies the manifest, sidecar
# endpoints, shared contract digests, and served-model posture. There is no PATH
# or direct-provider fallback.
set -euo pipefail

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  echo "make-excalibur-app: macOS only — skipped."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${EXCALIBUR_APP_DIR:-$PACKAGE_ROOT/.staging-apps}"
APP_NAME="${EXCALIBUR_APP_NAME:-Excalibur One Surface}"
ICON="${EXCALIBUR_ICON:-$PACKAGE_ROOT/assets/benchagi-icon.png}"
CLI_NODE="${EXCALIBUR_CLI_NODE:-$(command -v node 2>/dev/null || true)}"
CLI_ENTRY="${EXCALIBUR_CLI_ENTRY:-$PACKAGE_ROOT/bin/excalibur.mjs}"
ORCHESTRA_CONFIG="${EXCALIBUR_ORCHESTRA_CONFIG:-}"

if [[ ! "$APP_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]{0,63}$ ]]; then
  echo "make-excalibur-app: EXCALIBUR_APP_NAME contains unsafe path characters" >&2
  exit 1
fi
case "$APP_DIR" in
  /*) ;;
  *) echo "make-excalibur-app: EXCALIBUR_APP_DIR must be absolute" >&2; exit 1 ;;
esac

if [ -z "$CLI_NODE" ] || [ ! -x "$CLI_NODE" ]; then
  echo "make-excalibur-app: an exact executable EXCALIBUR_CLI_NODE is required" >&2
  exit 1
fi
if [ ! -f "$CLI_ENTRY" ]; then
  echo "make-excalibur-app: an exact EXCALIBUR_CLI_ENTRY is required" >&2
  exit 1
fi
CLI_NODE="$(cd "$(dirname "$CLI_NODE")" && pwd)/$(basename "$CLI_NODE")"
CLI_ENTRY="$(cd "$(dirname "$CLI_ENTRY")" && pwd)/$(basename "$CLI_ENTRY")"

case "$CLI_ENTRY" in
  */bin/excalibur.mjs) ;;
  *) echo "make-excalibur-app: CLI entry must be the standalone bin/excalibur.mjs" >&2; exit 1 ;;
esac

if [ ! -f "$PACKAGE_ROOT/dist/v2/excalibur/contract-baseline.js" ]; then
  echo "make-excalibur-app: compiled contract baseline missing; run npm run build first" >&2
  exit 1
fi
if [ ! -d "$PACKAGE_ROOT/dist" ] || [ ! -d "$PACKAGE_ROOT/node_modules" ] || [ ! -f "$PACKAGE_ROOT/package.json" ]; then
  echo "make-excalibur-app: complete dist, node_modules, and package.json runtime closure is required" >&2
  exit 1
fi
CLI_IDENTITY="$("$CLI_NODE" "$CLI_ENTRY" version 2>/dev/null || true)"
if [[ ! "$CLI_IDENTITY" =~ ^excalibur\ [0-9] ]]; then
  echo "make-excalibur-app: pinned entry did not identify as the Excalibur CLI" >&2
  exit 1
fi

if [ -n "$ORCHESTRA_CONFIG" ]; then
  case "$ORCHESTRA_CONFIG" in
    /*) ;;
    *) echo "make-excalibur-app: EXCALIBUR_ORCHESTRA_CONFIG must be absolute" >&2; exit 1 ;;
  esac
  ORCHESTRA_CONFIG="$({
    EXCALIBUR_ORCHESTRA_CONFIG="$ORCHESTRA_CONFIG" \
    EXCALIBUR_PACKAGE_ROOT="$PACKAGE_ROOT" \
    "$CLI_NODE" --input-type=module -e '
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const modulePath = join(process.env.EXCALIBUR_PACKAGE_ROOT, "dist/v2/excalibur/orchestra-broker.js");
      const orchestra = await import(pathToFileURL(modulePath).href);
      const result = await orchestra.resolveOrchestraBrokerConfig(process.env);
      if ("reason" in result) {
        process.stderr.write(`make-excalibur-app: invalid orchestra config: ${result.reason}\n`);
        process.exit(1);
      }
      process.stdout.write(result.configPath);
    '
  })"
fi

mkdir -p "$APP_DIR"
APP_DIR="$(cd "$APP_DIR" && pwd)"
case "$APP_DIR" in
  "/Applications"|"$HOME/Applications")
    if [ "${EXCALIBUR_ALLOW_APPLICATIONS_WRITE:-0}" != "1" ]; then
      echo "make-excalibur-app: installed Applications directories require EXCALIBUR_ALLOW_APPLICATIONS_WRITE=1" >&2
      exit 1
    fi
    ;;
esac
TARGET_APP="$APP_DIR/$APP_NAME.app"
if [ -L "$TARGET_APP" ]; then
  echo "make-excalibur-app: refusing to replace a symlinked app target" >&2
  exit 1
fi
if [ -e "$TARGET_APP" ] && [ "${EXCALIBUR_REPLACE_EXISTING:-0}" != "1" ]; then
  echo "make-excalibur-app: target already exists; set EXCALIBUR_REPLACE_EXISTING=1 for an explicit replacement" >&2
  exit 1
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
APP="$tmp/$APP_NAME.app"

cat > "$tmp/excalibur.applescript" <<'OSA'
on run
  set me_path to POSIX path of (path to me)
  set cmd to quoted form of (me_path & "Contents/Resources/launch.command")
  tell application "Terminal"
    activate
    set excaliburTab to do script cmd
    try
      set custom title of excaliburTab to "Excalibur One Surface"
      set number of columns of front window to 132
      set number of rows of front window to 42
    end try
  end tell
end run
OSA
/usr/bin/osacompile -o "$APP" "$tmp/excalibur.applescript"

# The toolbar app owns its exact runtime closure. Workspace Node, bin, dist,
# package metadata, and dependencies can drift later without changing a staged
# bundle. Ad-hoc code signing below seals the copied closure, and launch.command
# verifies that signature before it executes the bundled Node binary.
RUNTIME="$APP/Contents/Resources/runtime"
mkdir -p "$RUNTIME/cli/bin"
/bin/cp -p "$CLI_NODE" "$RUNTIME/node"
/bin/cp -p "$CLI_ENTRY" "$RUNTIME/cli/bin/excalibur.mjs"
/bin/cp -p "$PACKAGE_ROOT/package.json" "$RUNTIME/cli/package.json"
/usr/bin/ditto --noqtn "$PACKAGE_ROOT/dist" "$RUNTIME/cli/dist"
/usr/bin/ditto --noqtn "$PACKAGE_ROOT/node_modules" "$RUNTIME/cli/node_modules"
chmod 0755 "$RUNTIME/node" "$RUNTIME/cli/bin/excalibur.mjs"

shell_quote() { printf '%q' "$1"; }
if [ -n "$ORCHESTRA_CONFIG" ]; then
  ORCHESTRA_BINDING="export EXCALIBUR_ORCHESTRA_CONFIG=$(shell_quote "$ORCHESTRA_CONFIG")
unset EXCALIBUR_PATTERN_A_STATE_ROOT EXCALIBUR_ORCHESTRA_STATE_DIR"
else
  ORCHESTRA_BINDING="unset EXCALIBUR_ORCHESTRA_CONFIG EXCALIBUR_PATTERN_A_STATE_ROOT EXCALIBUR_ORCHESTRA_STATE_DIR"
fi
cat > "$APP/Contents/Resources/launch.command" <<LAUNCH
#!/usr/bin/env bash
set -euo pipefail
RESOURCE_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="\$(cd "\$RESOURCE_DIR/../.." && pwd)"
CLI_NODE="\$RESOURCE_DIR/runtime/node"
CLI_ENTRY="\$RESOURCE_DIR/runtime/cli/bin/excalibur.mjs"
CLI_NODE_DIR="\$RESOURCE_DIR/runtime"
MANIFEST="\$RESOURCE_DIR/excalibur-launcher.json"
export EXCALIBUR_CANONICAL_LAUNCH_MANIFEST="\$MANIFEST"
export EXCALIBUR_LAUNCHED_FROM_BUNDLE=1
export PATH="\$CLI_NODE_DIR:\$HOME/.local/bin:\$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
$ORCHESTRA_BINDING

if ! /usr/bin/codesign --verify --deep --strict "\$APP_BUNDLE"; then
  echo "Excalibur canonical launch blocked. The self-contained runtime signature is invalid."
  echo "No bundled CLI, provider session, or effect path was opened."
  exit 1
fi

if ! "\$CLI_NODE" "\$CLI_ENTRY" doctor --launch-check; then
  echo
  echo "Excalibur canonical launch blocked. The diagnostics above are authoritative."
  echo "No provider session or effect path was opened."
  echo "Press any key to close."
  read -r -n 1 _ || true
  exit 1
fi
exec "\$CLI_NODE" "\$CLI_ENTRY"
LAUNCH
chmod 0755 "$APP/Contents/Resources/launch.command"

EXCALIBUR_MANIFEST_PATH="$APP/Contents/Resources/excalibur-launcher.json" \
EXCALIBUR_MANIFEST_ROOT="$PACKAGE_ROOT" \
"$CLI_NODE" --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFile, writeFile } from "node:fs/promises";
  import { dirname, join } from "node:path";
  import { pathToFileURL } from "node:url";
  const root = process.env.EXCALIBUR_MANIFEST_ROOT;
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const baseline = await import(pathToFileURL(join(root, "dist/v2/excalibur/contract-baseline.js")).href);
  const launchCommand = await readFile(join(dirname(process.env.EXCALIBUR_MANIFEST_PATH), "launch.command"));
  const manifest = {
    schemaVersion: "excalibur.canonical-launcher.v1",
    surface: "excalibur-one-surface",
    cliVersion: pkg.version,
    cliEntry: "runtime/cli/bin/excalibur.mjs",
    nodePath: "runtime/node",
    launchCommandDigest: createHash("sha256").update(launchCommand).digest("hex"),
    requiredDigests: baseline.EXCALIBUR_EXPECTED_DIGESTS,
    healthGate: "doctor --launch-check",
    bundleIntegrityGate: "codesign --verify --deep --strict",
    selfContainedRuntime: true,
    sidecarRequired: true,
    directProviderLaunch: false,
  };
  await writeFile(process.env.EXCALIBUR_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
'

if [ -f "$ICON" ]; then
  icon_root="$(mktemp -d)"
  iset="$icon_root/ExcaliburOneSurface.iconset"
  mkdir -p "$iset"
  for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$ICON" --out "$iset/icon_${size}x${size}.png" >/dev/null 2>&1 || true
    retina=$((size * 2))
    /usr/bin/sips -z "$retina" "$retina" "$ICON" --out "$iset/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  /usr/bin/iconutil -c icns "$iset" -o "$APP/Contents/Resources/ExcaliburOneSurface.icns" 2>/dev/null || true
  cp "$APP/Contents/Resources/ExcaliburOneSurface.icns" "$APP/Contents/Resources/applet.icns" 2>/dev/null || true
  rm -rf "$icon_root"
fi

PLIST="$APP/Contents/Info.plist"
set_plist() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST" 2>/dev/null || true
}
[ -f "$APP/Contents/Resources/ExcaliburOneSurface.icns" ] \
  && set_plist CFBundleIconFile ExcaliburOneSurface \
  && set_plist CFBundleIconName ExcaliburOneSurface
set_plist CFBundleName "$APP_NAME"
set_plist CFBundleIdentifier "com.benchagi.excalibur-one-surface"
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
/usr/bin/xattr -cr "$APP" 2>/dev/null || true
/usr/bin/touch "$APP"

EXCALIBUR_VERIFY_MANIFEST="$APP/Contents/Resources/excalibur-launcher.json" \
EXCALIBUR_VERIFY_ENTRY="$APP/Contents/Resources/runtime/cli/bin/excalibur.mjs" \
EXCALIBUR_PACKAGE_ROOT="$PACKAGE_ROOT" \
"$CLI_NODE" --input-type=module -e '
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const modulePath = join(process.env.EXCALIBUR_PACKAGE_ROOT, "dist/v2/excalibur/launcher-integrity.js");
  const launcher = await import(pathToFileURL(modulePath).href);
  await launcher.verifyCanonicalLauncherManifest(
    process.env.EXCALIBUR_VERIFY_MANIFEST,
    process.env.EXCALIBUR_VERIFY_ENTRY,
  );
'

if [ -e "$TARGET_APP" ]; then
  mv "$TARGET_APP" "$tmp/previous.app"
fi
if ! mv "$APP" "$TARGET_APP"; then
  [ -e "$tmp/previous.app" ] && mv "$tmp/previous.app" "$TARGET_APP"
  echo "make-excalibur-app: failed to install staged bundle at target" >&2
  exit 1
fi

echo "Packaged (not runtime-certified): $TARGET_APP"
echo "Every click runs the canonical doctor gate before opening Excalibur."
echo "The legacy Excalibur CLI Preview bundle is not modified or selected."
if [ -n "$ORCHESTRA_CONFIG" ]; then
  echo "Pattern A wrapper config is path-bound; wrapper bytes, broker closure, and owner-private state root passed preflight."
  echo "No config, provider credential, or secret was copied into the bundle."
else
  echo "Pattern A broker config is unbound; /orchestra reports unavailable until a validated rebuild binds one."
fi
