#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="/home/guojiao/github/openclaw-integration"
TARGET_ROOT="/home/guojiao/github/openclaw"

SOURCE_DIST="$SOURCE_ROOT/dist"
TARGET_DIST="$TARGET_ROOT/dist"
SOURCE_CONTROL_UI_INDEX="$SOURCE_ROOT/dist/control-ui/index.html"
SOURCE_A2UI_BUNDLE="$SOURCE_ROOT/src/canvas-host/a2ui/a2ui.bundle.js"
TARGET_A2UI_BUNDLE="$TARGET_ROOT/src/canvas-host/a2ui/a2ui.bundle.js"

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "Missing source repo: $SOURCE_ROOT" >&2
  exit 1
fi

if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "Missing target repo: $TARGET_ROOT" >&2
  exit 1
fi

if [[ ! -d "$SOURCE_DIST" ]]; then
  echo "Missing build output directory: $SOURCE_DIST" >&2
  echo "Run 'pnpm build' and 'pnpm ui:build' in $SOURCE_ROOT first." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_CONTROL_UI_INDEX" ]]; then
  echo "Missing Control UI assets: $SOURCE_CONTROL_UI_INDEX" >&2
  echo "Run 'pnpm ui:build' in $SOURCE_ROOT first." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_A2UI_BUNDLE" ]]; then
  echo "Missing A2UI bundle: $SOURCE_A2UI_BUNDLE" >&2
  echo "Run 'pnpm build' in $SOURCE_ROOT first." >&2
  exit 1
fi

mkdir -p "$TARGET_DIST"
mkdir -p "$(dirname "$TARGET_A2UI_BUNDLE")"

echo "Syncing dist -> $TARGET_DIST"
rsync -a --delete "$SOURCE_DIST/" "$TARGET_DIST/"

echo "Syncing a2ui.bundle.js -> $TARGET_A2UI_BUNDLE"
install -m 0644 "$SOURCE_A2UI_BUNDLE" "$TARGET_A2UI_BUNDLE"

echo "Sync complete."
