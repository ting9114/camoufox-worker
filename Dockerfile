FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ─── Camoufox version (override with --build-arg) ───
ARG CAMOUFOX_TAG=v150.0.2-beta.25
ARG CAMOUFOX_ASSET=camoufox-150.0.2-alpha.26-lin.x86_64.zip

# ─── System dependencies for Firefox (Camoufox) + Xvfb + init ───
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    xvfb \
    tini \
    # Firefox/GTK runtime dependencies
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libasound2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxcursor1 \
    libxi6 \
    libpango-1.0-0 \
    libcairo2 \
    libatk1.0-0 \
    libgdk-pixbuf-2.0-0 \
    libdrm2 \
    libgbm1 \
    libxshmfence1 \
    libxkbcommon0 \
    libxfixes3 \
    libxext6 \
    libx11-6 \
    libnss3 \
    libnspr4 \
    libfontconfig1 \
    libfreetype6 \
    libstdc++6 \
    libgcc-s1 \
    libpulse0 \
    libxss1 \
    libxtst6 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxinerama1 \
    libxrender1 \
    libegl1 \
    libgl1 \
    libglib2.0-0 \
    # Fonts (critical for OS fingerprint consistency)
    fonts-noto \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# ─── Download and extract Camoufox binary ───
ENV CAMOUFOX_PATH=/opt/camoufox/camoufox-bin

RUN mkdir -p /opt/camoufox \
    && curl -fSL "https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_TAG}/${CAMOUFOX_ASSET}" \
       -o /tmp/camoufox.zip \
    && unzip -q /tmp/camoufox.zip -d /opt/camoufox \
    && rm /tmp/camoufox.zip \
    && apt-get purge -y --auto-remove unzip \
    && chmod +x /opt/camoufox/camoufox-bin \
    && chmod +x /opt/camoufox/camoufox 2>/dev/null || true \
    && ls -la /opt/camoufox/camoufox-bin \
    # Verify the binary can actually be loaded (check shared lib deps)
    && ldd /opt/camoufox/camoufox-bin | grep "not found" && echo "MISSING LIBS ABOVE" && exit 1 || echo "All shared libraries OK"

WORKDIR /app

# Install Node.js deps (skip Playwright browser download — we use Camoufox binary)
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci 2>/dev/null || npm install

# ─── Non-root user ───
RUN groupadd -r camoufox && useradd -r -g camoufox -d /app -s /sbin/nologin camoufox \
    && chown -R camoufox:camoufox /app /opt/camoufox

COPY --chown=camoufox:camoufox src/ ./src/
COPY --chown=camoufox:camoufox entrypoint.sh .
RUN chmod +x entrypoint.sh

USER camoufox

EXPOSE 3002

ENV PORT=3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

# tini as PID 1 — reaps zombie Firefox/Xvfb subprocesses
ENTRYPOINT ["tini", "--", "./entrypoint.sh"]
