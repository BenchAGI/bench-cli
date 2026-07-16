#!/bin/sh
set -eu

if [ -t 1 ]; then
  BLUE=$(printf '\033[34m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m')
  RESET=$(printf '\033[0m')
else
  BLUE=''
  GREEN=''
  YELLOW=''
  RED=''
  RESET=''
fi

STEP='starting installer'

on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s==> ERROR: step failed: %s (exit %s)%s\n' "$RED" "$STEP" "$rc" "$RESET" >&2
  fi
}
trap on_exit 0

step() {
  STEP=$1
  printf '%s==> %s%s\n' "$BLUE" "$1" "$RESET"
}

ok() {
  printf '%s==> %s%s\n' "$GREEN" "$1" "$RESET"
}

warn() {
  printf '%s==> WARNING: %s%s\n' "$YELLOW" "$1" "$RESET" >&2
}

die() {
  printf '%s==> ERROR: %s%s\n' "$RED" "$1" "$RESET" >&2
  exit 1
}

node_hint() {
  if [ "$OS" = 'macos' ]; then
    printf '%s' 'Install Node.js 20 or newer with Homebrew: brew install node'
  else
    printf '%s' 'Install Node.js 20 or newer with your distro package manager, NodeSource, or nvm.'
  fi
}

global_bin_for_pm() {
  case "$PM" in
    pnpm)
      pnpm bin -g 2>/dev/null || true
      ;;
    yarn)
      yarn global bin 2>/dev/null || true
      ;;
    npm)
      NPM_BIN=$(npm bin -g 2>/dev/null || true)
      if [ -n "$NPM_BIN" ]; then
        printf '%s\n' "$NPM_BIN"
        return
      fi
      NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
      if [ -n "$NPM_PREFIX" ]; then
        printf '%s/bin\n' "$NPM_PREFIX"
      fi
      ;;
  esac
}

PACKAGE=${BENCHAGI_PACKAGE:-@benchagi/cli@1.0.0-beta.15}

case "$PACKAGE" in
  *'/refs/heads/'*|*'github:'*'#'*|*'git+'*)
    die 'Refusing an unsealed branch or git install. Set BENCHAGI_PACKAGE to a digest-pinned artifact or an exact published version.'
    ;;
esac

step 'Detecting operating system'
OS_NAME=$(uname -s 2>/dev/null || printf '%s' unknown)
case "$OS_NAME" in
  Darwin)
    OS='macos'
    ;;
  Linux)
    OS='linux'
    ;;
  *)
    die "Unsupported operating system: $OS_NAME. This installer supports macOS and Linux only."
    ;;
esac
ok "Detected $OS"

step 'Checking Node.js version'
if ! command -v node >/dev/null 2>&1; then
  HINT=$(node_hint)
  die "Node.js 20 or newer is required. $HINT"
fi

NODE_VERSION=$(node -v 2>/dev/null || printf '%s' '')
NODE_MAJOR=$(printf '%s\n' "$NODE_VERSION" | sed 's/^v//; s/\..*//')
case "$NODE_MAJOR" in
  ''|*[!0123456789]*)
    die "Could not determine Node.js version from '$NODE_VERSION'."
    ;;
esac

if [ "$NODE_MAJOR" -lt 20 ]; then
  HINT=$(node_hint)
  die "Node.js 20 or newer is required; found $NODE_VERSION. $HINT"
fi
ok "Node.js $NODE_VERSION is available"

step 'Checking OpenClaw'
OPENCLAW_BIN=$(command -v openclaw 2>/dev/null || true)
if [ -z "$OPENCLAW_BIN" ]; then
  warn 'OpenClaw not found — the CLI will install, but you need OpenClaw for the local seat:'
  warn '  npm install -g openclaw'
  OPENCLAW_MISSING=1
else
  ok "OpenClaw is available at $OPENCLAW_BIN"
fi

step 'Selecting package manager'
if command -v pnpm >/dev/null 2>&1; then
  PM='pnpm'
elif command -v yarn >/dev/null 2>&1; then
  PM='yarn'
elif command -v npm >/dev/null 2>&1; then
  PM='npm'
else
  die 'npm was not found. Reinstall Node.js 20 or newer and ensure npm is on PATH.'
fi
ok "Using $PM"

step "Installing $PACKAGE globally"
case "$PM" in
  pnpm)
    pnpm add -g "$PACKAGE"
    ;;
  yarn)
    yarn global add "$PACKAGE"
    ;;
  npm)
    npm install -g "$PACKAGE"
    ;;
esac
ok "Installed $PACKAGE"

step 'Refreshing PATH for the installed CLI'
GLOBAL_BIN=$(global_bin_for_pm)
if [ -n "$GLOBAL_BIN" ] && [ -d "$GLOBAL_BIN" ]; then
  PATH="$GLOBAL_BIN:$PATH"
  export PATH
  ok "Using $PM global bin first: $GLOBAL_BIN"
else
  warn "Could not resolve the $PM global bin; using the existing PATH"
fi

step 'Verifying Excalibur Grok-first preview'
if ! command -v excalibur >/dev/null 2>&1; then
  if [ -n "${GLOBAL_BIN:-}" ]; then
    die "excalibur is not on PATH. Add the $PM global bin to PATH: export PATH=\"$GLOBAL_BIN:\$PATH\""
  fi
  die 'excalibur is not on PATH. Add your package manager global bin directory to PATH.'
fi
excalibur version >/dev/null
ok "excalibur (canonical command, beta.15 internal preview) is available at $(command -v excalibur)"

step 'Verifying benchagi streaming console'
if ! command -v benchagi >/dev/null 2>&1; then
  if [ -n "${GLOBAL_BIN:-}" ]; then
    die "benchagi is not on PATH. Add the $PM global bin to PATH: export PATH=\"$GLOBAL_BIN:\$PATH\""
  fi
  die 'benchagi is not on PATH. Add your package manager global bin directory to PATH.'
fi
benchagi version >/dev/null
ok "benchagi (1.x compatibility command; not redirected in beta.15) is available at $(command -v benchagi)"

step 'Verifying bench compatibility binary'
if ! command -v bench >/dev/null 2>&1; then
  if [ -n "${GLOBAL_BIN:-}" ]; then
    die "bench is not on PATH. Add the $PM global bin to PATH: export PATH=\"$GLOBAL_BIN:\$PATH\""
  fi
  die 'bench is not on PATH. Add your package manager global bin directory to PATH.'
fi
ok "bench (1.x compatibility command with legacy families intact) is available at $(command -v bench)"

step 'Confirming CLI-only installation boundary'
warn 'No desktop application was installed, replaced, renamed, launched, or pinned to the Dock.'
warn 'Keep /Applications/Excalibur.app build 7 unchanged until a separate explicit desktop installation approval.'
ok 'Excalibur beta.15 CLI candidate installed; run `excalibur doctor` while the approved sidecar is available'
