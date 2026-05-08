#!/bin/bash
sudo systemctl start johan
echo "🚀 Johan started"
sudo systemctl status johan --no-pager | head -5
