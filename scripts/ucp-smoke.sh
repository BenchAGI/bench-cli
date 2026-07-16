#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/excalibur-ucp-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

cd "$ROOT"
npm run build >/dev/null
node --test dist/v2/test/ucp-*.test.js

echo "ucp-smoke: PASS · local UCP tests only · draft publication exists only at /orchestra propose"
