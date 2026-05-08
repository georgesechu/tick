#!/bin/bash
# Live logs with follow
# Usage: bin/logs.sh        — live follow
#        bin/logs.sh 100    — last 100 lines
#        bin/logs.sh all    — all logs since boot

if [ "$1" = "all" ]; then
  journalctl -u johan --no-pager
elif [ -n "$1" ]; then
  journalctl -u johan -n "$1" --no-pager
else
  journalctl -u johan -f
fi
