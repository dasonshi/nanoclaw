#!/usr/bin/env bash
set -euo pipefail

# HyloClaw Data Migration: MacBook → VPS
# Run this FROM the MacBook

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

VPS_HOST=""
VPS_USER="nanoclaw"

while [[ $# -gt 0 ]]; do
  case $1 in
    --host)  VPS_HOST="$2"; shift 2 ;;
    --user)  VPS_USER="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --host VPS_IP [--user nanoclaw]"
      echo "Migrates NanoClaw data from MacBook to VPS"
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

[[ -z "$VPS_HOST" ]] && error "Missing --host (VPS IP address)"

NANOCLAW_DIR="$HOME/Projects/active/nanoclaw"
BRIDGE_DIR="$HOME/.openclaw/hylo-bridge"
GHL_DIR="$HOME/.ghl"

[[ -d "$NANOCLAW_DIR" ]] || error "NanoClaw not found at $NANOCLAW_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Migrating to $VPS_HOST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Sync NanoClaw repo ──────────────────────────────────

log "Syncing NanoClaw source..."
rsync -avz --exclude node_modules --exclude dist --exclude .git \
  "$NANOCLAW_DIR/" "${VPS_USER}@${VPS_HOST}:/opt/nanoclaw/"

# ── Step 2: Sync SQLite database ────────────────────────────────

log "Syncing database..."
rsync -avz "$NANOCLAW_DIR/store/" "${VPS_USER}@${VPS_HOST}:/opt/nanoclaw/store/"

# ── Step 3: Sync group configurations ───────────────────────────

log "Syncing group configurations..."
rsync -avz "$NANOCLAW_DIR/groups/" "${VPS_USER}@${VPS_HOST}:/opt/nanoclaw/groups/"

# ── Step 4: Sync session data ───────────────────────────────────

log "Syncing session data..."
rsync -avz "$NANOCLAW_DIR/data/sessions/" "${VPS_USER}@${VPS_HOST}:/opt/nanoclaw/data/sessions/"

# ── Step 5: Sync GHL profiles ──────────────────────────────────

log "Syncing GHL profiles..."
rsync -avz "$GHL_DIR/profiles.yaml" "${VPS_USER}@${VPS_HOST}:/home/${VPS_USER}/.ghl/profiles.yaml"
ssh "${VPS_USER}@${VPS_HOST}" "chmod 600 /home/${VPS_USER}/.ghl/profiles.yaml"

# ── Step 6: Sync Hylo Bridge ───────────────────────────────────

log "Syncing Hylo Bridge..."
rsync -avz --exclude node_modules \
  "$BRIDGE_DIR/" "${VPS_USER}@${VPS_HOST}:/opt/hylo-bridge/"

# ── Step 7: Sync .env ──────────────────────────────────────────

if [[ -f "$NANOCLAW_DIR/.env" ]]; then
  log "Syncing .env..."
  rsync -avz "$NANOCLAW_DIR/.env" "${VPS_USER}@${VPS_HOST}:/opt/nanoclaw/.env"
  ssh "${VPS_USER}@${VPS_HOST}" "chmod 600 /opt/nanoclaw/.env"
else
  warn ".env not found — configure manually on VPS"
fi

# ── Step 8: Install systemd services ───────────────────────────

log "Installing systemd services..."
ssh "root@${VPS_HOST}" "cp /opt/nanoclaw/deploy/nanoclaw.service /etc/systemd/system/ && \
  cp /opt/nanoclaw/deploy/hylo-bridge.service /etc/systemd/system/ && \
  systemctl daemon-reload"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Migration complete${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "On the VPS, run:"
echo "  cd /opt/nanoclaw && npm ci && npm run build"
echo "  docker build -t nanoclaw-agent:latest container/"
echo "  sudo systemctl enable --now nanoclaw hylo-bridge"
echo ""
