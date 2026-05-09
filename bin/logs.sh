#!/bin/bash
# Live logs — clean output (strips journald prefix, shows only agent output)
# Usage: bin/logs.sh        — live follow
#        bin/logs.sh 100    — last 100 lines
#        bin/logs.sh all    — all logs since boot

if [ "$1" = "all" ]; then
  journalctl -u johan --no-pager --output=cat
elif [ -n "$1" ]; then
  journalctl -u johan -n "$1" --no-pager --output=cat
else
  journalctl -u johan -f --output=cat
fi
