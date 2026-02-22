#!/bin/bash

# Worker Startup Script
# Ensures Chrome is installed before starting the worker process

set -e

echo "[Worker Startup] Initializing VC Enrichment Worker..."

# Run Chrome installation check/install
/home/ubuntu/vc-enrichment-web/scripts/install-chrome.sh

# Start the worker
echo "[Worker Startup] Starting worker process..."
cd /home/ubuntu/vc-enrichment-web
exec pnpm tsx server/worker.ts
