#!/bin/bash
set -e

# Force software OpenGL rendering (no GPU in container)
# This makes WebGL work via Mesa software rasterizer,
# which is critical for passing Cloudflare's invisible Turnstile checks
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export MOZ_WEBRENDER=0
export MOZ_ACCELERATED=0

echo "[entrypoint] Starting Camoufox Worker (PORT=$PORT) with Xvfb virtual display..."
echo "  LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE"
echo "  GALLIUM_DRIVER=$GALLIUM_DRIVER"
exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -ac" node src/server.js
