#!/bin/bash
# DropCull launcher — double-click me.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "DropCull needs Node.js (free). Grab it here, install, then double-click me again:"
  echo ""
  echo "    https://nodejs.org"
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — downloading the free open-source parts (one time, ~1 min)..."
  npm install --no-audit --no-fund || { echo "Install hit a snag. Check your internet and try again."; read -r -p "Press Enter to close..."; exit 1; }
fi

# Self-update: checks GitHub for a newer version. Fails safe — offline just starts the app.
node update.js
if [ $? -eq 10 ]; then
  npm install --no-audit --no-fund
fi

echo ""
echo "  DropCull is starting... your browser will open in a second."
echo "  Leave this window open while you work. Close it to quit."
echo ""
exec node server.js --open
