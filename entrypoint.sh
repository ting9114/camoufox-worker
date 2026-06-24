#!/bin/bash
set -e

# Start Xvfb virtual display (recommended for anti-detection — avoids native headless fingerprints)
echo "[entrypoint] Starting Xvfb for virtual display mode..."
Xvfb :99 -screen 0 1920x1080x24 -ac &
export DISPLAY=:99
sleep 1
echo "[entrypoint] Xvfb started on :99"

echo "[entrypoint] Starting Camoufox Worker (PORT=$PORT)..."
exec node src/server.js
