#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Safety check
if systemctl is-active --quiet johan 2>/dev/null; then
  echo "⚠️  Johan is running. Stop first: bin/stop.sh"
  exit 1
fi

echo "🧹 Clearing Johan's memory..."
rm -f "$PROJECT_DIR/agents/johan/tick.db"
rm -f "$PROJECT_DIR/agents/johan/tick.db-wal"
rm -f "$PROJECT_DIR/agents/johan/tick.db-shm"
echo "✅ Memory cleared. Start with: bin/start.sh"
