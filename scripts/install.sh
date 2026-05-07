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

PACKAGE=${BENCHAGI_PACKAGE:-@benchagi/cli}

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
if ! command -v openclaw >/dev/null 2>&1; then
  warn 'OpenClaw is required. Install with: npm install -g openclaw'
  exit 0
fi
ok "OpenClaw is available at $(command -v openclaw)"

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

step 'Verifying bench binary'
if ! command -v bench >/dev/null 2>&1; then
  NPM_BIN=''
  if command -v npm >/dev/null 2>&1; then
    NPM_BIN=$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null | sed 's:$:/bin:' || printf '%s' '')
  fi

  if [ -n "$NPM_BIN" ]; then
    die "bench is not on PATH. Add npm global bin to PATH: export PATH=\"$NPM_BIN:\$PATH\""
  fi
  die 'bench is not on PATH. Add your npm global bin directory to PATH.'
fi
ok "bench is available at $(command -v bench)"

step 'Verifying benchagi streaming console'
if ! command -v benchagi >/dev/null 2>&1; then
  NPM_BIN=''
  if command -v npm >/dev/null 2>&1; then
    NPM_BIN=$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null | sed 's:$:/bin:' || printf '%s' '')
  fi

  if [ -n "$NPM_BIN" ]; then
    die "benchagi is not on PATH. Add npm global bin to PATH: export PATH=\"$NPM_BIN:\$PATH\""
  fi
  die 'benchagi is not on PATH. Add your npm global bin directory to PATH.'
fi
benchagi version >/dev/null
ok "benchagi is available at $(command -v benchagi)"

step 'Running BenchAGI setup'
if bench setup --help >/dev/null 2>&1; then
  bench setup --non-interactive
else
  bench --help
fi
ok 'BenchAGI CLI install completed'
