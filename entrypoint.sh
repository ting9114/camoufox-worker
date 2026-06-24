#!/bin/bash
set -e

echo "[entrypoint] Starting Camoufox Worker (PORT=$PORT) with Xvfb virtual display..."
exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -ac" node src/server.js
