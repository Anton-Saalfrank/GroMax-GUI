#!/usr/bin/env bash
# GroMax GUI — Setup Script
# Run once: bash setup.sh

set -e
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║      GroMax GUI  —  Setup        ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# ─── Check prerequisites ──────────────────────────────────────────────────────

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "  ✗ '$1' not found. $2"
    exit 1
  else
    echo "  ✓ $1 found: $(command -v $1)"
  fi
}

echo "Checking prerequisites..."
check_cmd node    "Install from https://nodejs.org (v20+)"
check_cmd npm     "Comes with Node.js"
check_cmd python3 "Install from https://python.org (3.11+)"

# GROMACS is optional at setup time — warn but don't fail
if command -v gmx &>/dev/null; then
  echo "  ✓ gmx found: $(command -v gmx)"
else
  echo "  ⚠  gmx not found — GROMACS analyses won't run, but the app will still start."
fi

echo ""

# ─── Node dependencies ────────────────────────────────────────────────────────
echo "Installing Node dependencies..."
npm install --silent
echo "  ✓ Node packages installed"
echo ""

# ─── Python dependencies ──────────────────────────────────────────────────────
echo "Installing Python dependencies..."
python3 -m pip install -r backend/requirements.txt --quiet
echo "  ✓ Python packages installed"
echo ""

# ─── Done ─────────────────────────────────────────────────────────────────────
echo "  ╔══════════════════════════════════╗"
echo "  ║        Setup complete! ✓         ║"
echo "  ╚══════════════════════════════════╝"
echo ""
echo "  To run the app:"
echo ""
echo "    Option A — Electron desktop app (needs Electron installed):"
echo "      npm run dev"
echo ""
echo "    Option B — Browser only (backend + Vite, no Electron):"
echo "      bash run-browser.sh"
echo ""
