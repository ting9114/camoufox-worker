FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ─── System dependencies for Firefox (Camoufox) + Xvfb ───
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    xvfb \
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
    # Fonts (critical for OS fingerprint consistency)
    fonts-noto \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# ─── Download and extract Camoufox binary ───
ENV CAMOUFOX_VERSION=150.0.2-alpha.26
ENV CAMOUFOX_PATH=/opt/camoufox/camoufox-bin

RUN mkdir -p /opt/camoufox \
    && curl -fSL "https://github.com/daijro/camoufox/releases/download/v150.0.2-beta.25/camoufox-${CAMOUFOX_VERSION}-lin.x86_64.zip" \
       -o /tmp/camoufox.zip \
    && unzip -q /tmp/camoufox.zip -d /opt/camoufox \
    && rm /tmp/camoufox.zip \
    && chmod +x /opt/camoufox/camoufox-bin \
    && chmod +x /opt/camoufox/camoufox 2>/dev/null || true \
    && ls -la /opt/camoufox/

WORKDIR /app

# Install Node.js deps (skip Playwright browser download — we use Camoufox binary)
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

COPY src/ ./src/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 3002

ENV PORT=3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

ENTRYPOINT ["./entrypoint.sh"]
