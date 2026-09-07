#!/usr/bin/env bash
# Install a .desktop launcher so the taskbar/dock uses the Agent Smith icon
# (matches StartupWMClass=agent-smith in main.js).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON="$ROOT/build/icons/512x512.png"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$DESKTOP_DIR/agent-smith.desktop"

if [[ ! -f "$ICON" ]]; then
  echo "Missing $ICON — run from a built checkout with build/icons/." >&2
  exit 1
fi

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Agent Smith Reloaded
GenericName=AI Agent
Comment=Local AI coding agent
Exec=bash -lc 'cd "$ROOT" && npm start'
Icon=$ICON
Terminal=false
Categories=Development;Utility;
StartupWMClass=agent-smith
EOF

chmod +x "$DESKTOP_FILE"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed $DESKTOP_FILE"
echo "Launch Agent Smith from your app menu for the correct taskbar icon."
