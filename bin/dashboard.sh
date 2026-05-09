#!/bin/bash
# Launch the web dashboard
# Usage: bin/dashboard.sh [port]
PORT=${1:-8090}
exec npx tsx src/dashboard.ts --agent agents/johan --port "$PORT"
