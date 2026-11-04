#!/usr/bin/env bash
# Start the dialer for a demo: backend on :4000, phone forwarded over USB, app opened.
# Usage: ./.start_all.sh   (Ctrl+C stops the backend)
set -e
cd "$(dirname "$0")/backend"
ADB=~/Library/Android/sdk/platform-tools/adb
PORT=4000

pkill -f "node server.js" 2>/dev/null || true # an old backend would hold the port
PORT=$PORT node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

for _ in $(seq 20); do curl -s localhost:$PORT/api/health >/dev/null && break; sleep 0.5; done
curl -s localhost:$PORT/api/health >/dev/null || { echo "Backend did not start"; exit 1; }
echo "Backend running on :$PORT"

if $ADB get-state >/dev/null 2>&1; then
  $ADB reverse tcp:$PORT tcp:$PORT >/dev/null
  $ADB shell monkey -p com.kalvium.dialer -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  echo "Phone connected; Dialer opened"
else
  echo "No phone found: plug it in (USB debugging on), then run: $ADB reverse tcp:$PORT tcp:$PORT"
fi

echo "Ctrl+C to stop"
wait $SERVER
