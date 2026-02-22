#!/bin/bash
# Worker Daemon Script for 24/7 Operation
# Automatically restarts worker if it crashes

WORKER_LOG="/tmp/worker-daemon.log"
RESTART_DELAY=5

echo "[$(date)] Worker daemon starting..." | tee -a "$WORKER_LOG"

while true; do
  echo "[$(date)] Starting worker..." | tee -a "$WORKER_LOG"
  
  cd /home/ubuntu/vc-enrichment-web
  npm exec tsx server/worker.ts 2>&1 | tee -a "$WORKER_LOG"
  
  EXIT_CODE=$?
  echo "[$(date)] Worker exited with code $EXIT_CODE" | tee -a "$WORKER_LOG"
  
  # Wait before restarting
  echo "[$(date)] Restarting in ${RESTART_DELAY} seconds..." | tee -a "$WORKER_LOG"
  sleep $RESTART_DELAY
done
