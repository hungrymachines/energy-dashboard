#!/usr/bin/env bash
# Build the Hungry Machines HACS bundle and print the dist path + size.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

DIST="dist/hungry-machines.js"

if [[ ! -f "$DIST" ]]; then
  echo "error: expected $DIST to exist after build" >&2
  exit 1
fi

SIZE_BYTES=$(wc -c < "$DIST" | tr -d ' ')
SIZE_KB=$(awk "BEGIN { printf \"%.1f\", $SIZE_BYTES / 1024 }")

echo ""
echo "Bundle: $(pwd)/$DIST"
echo "Size:   ${SIZE_KB} KB (${SIZE_BYTES} bytes)"
