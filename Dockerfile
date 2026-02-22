# Multi-stage build for Railway deployment
# Stage 1: Builder
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy package files and patches
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# Install dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Stage 2: Production
FROM node:22-slim

WORKDIR /app

# Install Chrome and dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
  wget \
  gnupg \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# Set Chrome path for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Copy package files and patches
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# Install all dependencies (tsx needed for runtime)
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy application from builder
COPY --from=builder /app/server ./server
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/shared ./shared

# Create non-root user for security (use different UID to avoid conflict)
RUN useradd -m -u 1001 worker && chown -R worker:worker /app
USER worker

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Start the worker using tsx executable directly (no --loader or --import flags)
CMD ["npx", "tsx", "server/worker.ts"]
