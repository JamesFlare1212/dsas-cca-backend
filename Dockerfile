FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS base

WORKDIR /usr/src/app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/usr/src/app/data \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

FROM base AS dependencies

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime

COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY package.json bun.lock ./

# Install Chromium's OS libraries only. CloakBrowser supplies the browser binary.
RUN DEBIAN_FRONTEND=noninteractive bun node_modules/playwright-core/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Keep the image input explicit: no .env, local cookies, tests, or host dependencies.
COPY src/ ./src/
COPY scripts/install-browser.ts scripts/browser-smoke.ts scripts/login.ts scripts/migrate-cache.ts ./scripts/
COPY --chmod=0755 startup.sh ./startup.sh

# New named volumes inherit this directory's ownership from the image.
RUN mkdir -p /usr/src/app/data /opt/cloakbrowser \
    && chown bun:bun /usr/src/app/data /opt/cloakbrowser \
    && chmod 0700 /usr/src/app/data

USER bun

# ensureBinary verifies the official signed checksum manifest and the archive.
# Installation errors fail the build; runtime uses this baked, frozen cache.
RUN bun run browser:install

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "--eval", "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health/ready', { signal: AbortSignal.timeout(4000) }); if (!response.ok) process.exit(1);"]

CMD ["./startup.sh"]
