#!/usr/bin/env bash
set -euo pipefail

# HyloClaw VPS Setup Script
# Target: Hetzner CAX11 (ARM64, 2 vCPU, 4GB RAM)
# OS: Ubuntu 24.04

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

# Must run as root
[[ $EUID -ne 0 ]] && error "Run this script as root"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  HyloClaw VPS Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: System updates + dependencies ────────────────────────

log "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

log "Installing dependencies..."
apt-get install -y -qq curl git sqlite3 logrotate ufw

# ── Step 2: Install Node.js 20 LTS ──────────────────────────────

if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v) installed"

# ── Step 3: Install Docker ──────────────────────────────────────

if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable docker
systemctl start docker
log "Docker $(docker --version | cut -d' ' -f3) installed"

# ── Step 4: Create nanoclaw user ────────────────────────────────

if ! id nanoclaw &>/dev/null; then
  useradd -m -s /bin/bash nanoclaw
  usermod -aG docker nanoclaw
  log "Created user: nanoclaw"
else
  log "User nanoclaw already exists"
fi

# ── Step 5: Create directory structure ──────────────────────────

mkdir -p /opt/nanoclaw /opt/hylo-bridge /home/nanoclaw/.ghl
chown -R nanoclaw:nanoclaw /opt/nanoclaw /opt/hylo-bridge /home/nanoclaw/.ghl
chmod 700 /home/nanoclaw/.ghl

log "Directory structure created"

# ── Step 6: Firewall ────────────────────────────────────────────

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable
log "Firewall configured (SSH only)"

# ── Step 7: Logrotate ──────────────────────────────────────────

cat > /etc/logrotate.d/hylo-bridge <<'LOGROTATE'
/opt/hylo-bridge/audit.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

log "Logrotate configured for audit.log"

# ── Step 8: Health check cron ───────────────────────────────────

# The TELEGRAM_BOT_TOKEN and HEALTH_CHAT_ID must be set after deployment
cat > /opt/nanoclaw/health-check.sh <<'HEALTH'
#!/usr/bin/env bash
# Health check — runs every 5 minutes via cron
BRIDGE_URL="http://localhost:18800"

if ! curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; then
  echo "$(date -Iseconds) Bridge health check failed" >> /opt/nanoclaw/health.log

  # Restart bridge if down
  systemctl restart hylo-bridge

  # Alert via Telegram if configured
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${HEALTH_CHAT_ID:-}" ]]; then
    curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$HEALTH_CHAT_ID" \
      -d text="⚠️ Hylo Bridge health check failed on $(hostname). Restarted." \
      >/dev/null 2>&1
  fi
fi
HEALTH

chmod +x /opt/nanoclaw/health-check.sh
echo "*/5 * * * * nanoclaw /opt/nanoclaw/health-check.sh" > /etc/cron.d/nanoclaw-health
log "Health check cron configured"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}VPS base setup complete${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Run deploy/migrate-to-vps.sh from MacBook to copy data"
echo "  2. cd /opt/nanoclaw && npm ci && npm run build"
echo "  3. Build container image: docker build -t nanoclaw-agent:latest container/"
echo "  4. Copy .env and configure environment"
echo "  5. systemctl enable --now nanoclaw hylo-bridge"
echo ""
