#!/bin/sh
# Start the Next.js server. When R2 is configured, run it UNDER Litestream so the SQLite
# record is continuously replicated off-host. Coolify deploys this image directly via the
# Dockerfile build pack (not docker-compose), so the backup process must live INSIDE the
# app container — this is Litestream's official `-exec` pattern: Litestream supervises the
# server process, replicates the DB, forwards signals (so the app's clean-shutdown WAL
# checkpoint still runs), and does a final sync on exit. Falls back to plain `node` when
# R2 is not configured (e.g. local runs), so the image works either way.
set -e

if [ -n "$R2_BUCKET" ] && [ -n "$R2_ENDPOINT" ] && [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ]; then
  echo "[kin] Litestream enabled — replicating ${DATA_DIR:-/app/data}/tracker.db to R2 bucket '$R2_BUCKET'"
  exec litestream replicate -exec "node server.js"
fi

echo "[kin] R2 not configured — starting without Litestream backups"
exec node server.js
