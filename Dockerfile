FROM oven/bun:latest

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /usr/src/app

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package.json bun.lock ./

# Install dependencies (including Playwright)
RUN bun install --production

# Install Playwright browsers
RUN bunx playwright install chromium --with-deps || true

# Copy application code
COPY . .

# Make startup script executable
RUN chmod +x startup.sh

# Create non-root user for security
RUN adduser --disabled-password --gecos '' appuser && \
    chown -R appuser:appuser /usr/src/app

USER appuser

EXPOSE 3000

# Use startup script
CMD ["/bin/sh", "startup.sh"]
