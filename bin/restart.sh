#!/bin/bash
echo "🔄 Restarting Johan..."
sudo systemctl restart johan
sleep 2
sudo systemctl status johan --no-pager | head -5
