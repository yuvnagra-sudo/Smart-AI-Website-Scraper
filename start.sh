#!/bin/sh
# Start the web server (serves API + built React frontend) and background worker together.
# Both processes run concurrently; the container exits if either one crashes.

set -e

export NODE_ENV=production

echo "[start.sh] Starting web server..."
node dist/index.js &
WEB_PID=$!

echo "[start.sh] Starting background worker..."
node dist/worker.js &
WORKER_PID=$!

echo "[start.sh] Both processes started (web=$WEB_PID, worker=$WORKER_PID)"

# Exit as soon as either process exits (Railway will restart the container)
wait -n
EXIT_CODE=$?

echo "[start.sh] A process exited with code $EXIT_CODE, shutting down..."
kill $WEB_PID $WORKER_PID 2>/dev/null || true
exit $EXIT_CODE
