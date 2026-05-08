#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "📦 Installing Johan agent service..."

# Ensure data directory exists
mkdir -p "$PROJECT_DIR/data/johan"

# Install npm deps if needed
cd "$PROJECT_DIR"
if [ ! -d node_modules ]; then
  echo "📥 Installing dependencies..."
  npm install
fi

# Install systemd service
sudo cp "$SCRIPT_DIR/johan.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable johan

echo "✅ Installed. Commands:"
echo "  bin/start.sh     — start Johan"
echo "  bin/stop.sh      — stop Johan"
echo "  bin/restart.sh   — restart Johan"
echo "  bin/logs.sh      — view live logs"
echo "  bin/mind.sh      — open mind viewer"
echo "  bin/clear.sh     — wipe memory (requires stop first)"
echo "  bin/status.sh    — check service status"
