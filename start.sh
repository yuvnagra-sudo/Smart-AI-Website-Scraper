#!/bin/sh
# Start the background worker and then run the web server in the foreground.
# Using exec for the web server makes it PID 1 (the process Railway monitors).
# The worker runs as a background child; it is killed automatically when the
# container exits.

export NODE_ENV=production

echo "[start.sh] Starting background worker..."
node dist/worker.js &

echo "[start.sh] Starting web server (foreground)..."
exec node dist/index.js
