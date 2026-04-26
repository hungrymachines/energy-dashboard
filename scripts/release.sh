#!/usr/bin/env bash
# Build the Hungry Machines HACS bundle and print the dist path + size.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

BUNDLE="custom_components/hungry_machines/frontend/hungry-machines.js"

if [[ ! -f "$BUNDLE" ]]; then
  echo "error: expected $BUNDLE to exist after build" >&2
  exit 1
fi

SIZE_BYTES=$(wc -c < "$BUNDLE" | tr -d ' ')
SIZE_KB=$(awk "BEGIN { printf \"%.1f\", $SIZE_BYTES / 1024 }")

echo ""
echo "Bundle: $(pwd)/$BUNDLE"
echo "Size:   ${SIZE_KB} KB (${SIZE_BYTES} bytes)"
