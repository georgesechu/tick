#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "═══ Service ═══"
sudo systemctl status johan --no-pager 2>/dev/null | head -8 || echo "  Not installed as service"

echo ""
echo "═══ Container ═══"
docker ps -f name=tick-sandbox --format "  {{.Names}}  {{.Status}}  {{.Image}}" 2>/dev/null || echo "  No container"

echo ""
echo "═══ Database ═══"
DB="$PROJECT_DIR/agents/johan/tick.db"
if [ -f "$DB" ]; then
  SIZE=$(du -h "$DB" | cut -f1)
  echo "  $DB ($SIZE)"
  npx tsx -e "
    const Database = require('better-sqlite3')
    const db = new Database('$DB', { readonly: true })
    const ticks = (db.prepare('SELECT COUNT(*) as c FROM ticks').get()).c
    const mem = (db.prepare('SELECT COUNT(*) as c FROM memory WHERE deleted = 0 AND version = (SELECT MAX(version) FROM memory m2 WHERE m2.key = memory.key)').get()).c
    const unread = (db.prepare('SELECT COUNT(*) as c FROM inbox WHERE read = 0').get()).c
    console.log('  Ticks:', ticks, '| Memory keys:', mem, '| Unread inbox:', unread)
    db.close()
  " 2>/dev/null
else
  echo "  No database yet (first run will create it)"
fi

echo ""
echo "═══ Persist Volume ═══"
PERSIST="$PROJECT_DIR/data/johan"
if [ -d "$PERSIST" ]; then
  COUNT=$(find "$PERSIST" -type f 2>/dev/null | wc -l)
  SIZE=$(du -sh "$PERSIST" 2>/dev/null | cut -f1)
  echo "  $PERSIST ($SIZE, $COUNT files)"
else
  echo "  Not created yet"
fi
