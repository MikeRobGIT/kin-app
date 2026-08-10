# ---- Base ----
FROM node:20-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Dependencies ----
# Full deps (incl. build toolchain) so better-sqlite3 can compile its native addon.
FROM base AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Use ci when a lockfile exists, otherwise fall back to install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- Build ----
FROM base AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Runtime ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data
ARG TARGETARCH

# Litestream (continuous SQLite replication to R2) runs INSIDE this container: Coolify
# deploys this image directly via the Dockerfile build pack, so a docker-compose sidecar
# would never run. ca-certificates is required for Litestream's TLS connection to R2.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.14/litestream-v0.3.14-linux-${TARGETARCH}.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone server + static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Litestream config + entrypoint (starts the server, under Litestream when R2 is set).
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persistent SQLite location.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000
CMD ["/usr/local/bin/docker-entrypoint.sh"]
