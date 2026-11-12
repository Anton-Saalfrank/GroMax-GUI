#!/usr/bin/env bash
# Run GroMax in browser mode (no Electron needed for development/testing)
# Open http://localhost:5173 in your browser

set -e
cd "$(dirname "$0")"

echo ""
echo "  Starting GroMax (browser mode)..."
echo ""
echo "  Backend  → http://localhost:7432"
echo "  Frontend → http://localhost:5173"
echo ""
echo "  Open http://localhost:5173 in your browser."
echo "  Press Ctrl+C to stop."
echo ""

# Start Python backend in background
python3 backend/main.py --port 7432 &
BACKEND_PID=$!

# Give backend a moment to start
sleep 1

# Start Vite dev server (foreground)
npm run vite

# Kill backend when Vite exits
kill $BACKEND_PID 2>/dev/null || true
