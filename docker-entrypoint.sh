#!/bin/sh
set -e

# Start API server in background
echo "Starting API server on port ${PORT:-3001}..."
bun /app/apps/api/dist/index.js &
API_PID=$!

# Start web server in background
echo "Starting web server on port 3000..."
bun /app/apps/web/.output/server/index.mjs &
WEB_PID=$!

# Optionally start Discord bot
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  echo "Starting Discord bot..."
  bun /app/apps/discord-bot/src/index.ts &
  DISCORD_PID=$!
fi

cleanup() {
  echo "Shutting down services..."
  kill $API_PID $WEB_PID $DISCORD_PID 2>/dev/null
  wait $API_PID $WEB_PID $DISCORD_PID 2>/dev/null
  exit 0
}

trap cleanup TERM INT

echo "All services started. PID: API=$API_PID, Web=$WEB_PID${DISCORD_PID:+, Discord=$DISCORD_PID}"

wait
