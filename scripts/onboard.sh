#!/usr/bin/env bash
set -euo pipefail

# HyloClaw Customer Onboarding Script
# Usage: ./scripts/onboard.sh --name "Biz Name" --slug "biz_name" --location-id "abc123" \
#          --pit-token "pit-xxx" --chat-id "tg:12345" --description "Short biz description"

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILES_PATH="$HOME/.ghl/profiles.yaml"
TEMPLATE_PATH="$NANOCLAW_DIR/groups/_templates/customer.md"
BRIDGE_URL="http://localhost:18800"
DB_PATH="$NANOCLAW_DIR/store/messages.db"
IPC_DIR="$NANOCLAW_DIR/data/ipc/telegram_main/tasks"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

# Parse arguments
NAME="" SLUG="" LOCATION_ID="" PIT_TOKEN="" CHAT_ID="" DESCRIPTION="" BOT_NAME="HyloClaw"

while [[ $# -gt 0 ]]; do
  case $1 in
    --name)         NAME="$2"; shift 2 ;;
    --slug)         SLUG="$2"; shift 2 ;;
    --location-id)  LOCATION_ID="$2"; shift 2 ;;
    --pit-token)    PIT_TOKEN="$2"; shift 2 ;;
    --chat-id)      CHAT_ID="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --bot-name)     BOT_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --name NAME --slug SLUG --location-id LOC_ID --pit-token TOKEN --chat-id CHAT_ID --description DESC"
      echo ""
      echo "Options:"
      echo "  --name         Business display name (e.g. \"Acme Plumbing\")"
      echo "  --slug         URL-safe identifier, lowercase+underscores (e.g. \"acme_plumbing\")"
      echo "  --location-id  GHL sub-account Location ID (alphanumeric)"
      echo "  --pit-token    GHL Private Integration Token (starts with pit-)"
      echo "  --chat-id      Telegram JID (e.g. \"tg:12345\" or \"tg:-100123456\")"
      echo "  --description  Short business description for the AI"
      echo "  --bot-name     Custom bot name (default: HyloClaw)"
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

# ── Validate inputs ──────────────────────────────────────────────

[[ -z "$NAME" ]]        && error "Missing --name"
[[ -z "$SLUG" ]]        && error "Missing --slug"
[[ -z "$LOCATION_ID" ]] && error "Missing --location-id"
[[ -z "$PIT_TOKEN" ]]   && error "Missing --pit-token"
[[ -z "$CHAT_ID" ]]     && error "Missing --chat-id"
[[ -z "$DESCRIPTION" ]] && error "Missing --description"

# Slug: lowercase alphanumeric + underscores, 1-64 chars
[[ ! "$SLUG" =~ ^[a-z0-9_]{1,64}$ ]] && error "Slug must be lowercase alphanumeric + underscores, 1-64 chars. Got: $SLUG"

# Location ID: alphanumeric only
[[ ! "$LOCATION_ID" =~ ^[a-zA-Z0-9]{10,30}$ ]] && error "Location ID must be 10-30 alphanumeric chars. Got: $LOCATION_ID"

# PIT token: must start with pit- and contain only hex + dashes
[[ ! "$PIT_TOKEN" =~ ^pit-[a-f0-9-]{30,}$ ]] && error "PIT token format invalid. Must be pit-<uuid>. Got: ${PIT_TOKEN:0:10}..."

# Chat ID: must start with tg: followed by digits (optionally with | suffix)
[[ ! "$CHAT_ID" =~ ^tg:-?[0-9]+ ]] && error "Chat ID must start with 'tg:' followed by digits. Got: $CHAT_ID"

# Name: reject characters that would break sed or YAML
[[ "$NAME" =~ [\"\'\`\$\\\|] ]] && error "Name contains unsafe characters (quotes, backticks, dollar, backslash, pipe)"

# Description: reject characters that would break sed or YAML
[[ "$DESCRIPTION" =~ [\"\'\`\$\\] ]] && error "Description contains unsafe characters (quotes, backticks, dollar, backslash)"

GROUP_FOLDER="telegram_${SLUG}"

# ── Check for conflicts ──────────────────────────────────────────

[[ -f "$TEMPLATE_PATH" ]] || error "Template not found: $TEMPLATE_PATH"

if grep -q "^  ${SLUG}:" "$PROFILES_PATH" 2>/dev/null; then
  error "Profile '$SLUG' already exists in $PROFILES_PATH"
fi

if [[ -d "$NANOCLAW_DIR/groups/$GROUP_FOLDER" ]]; then
  error "Group folder already exists: groups/$GROUP_FOLDER"
fi

# Safe SQLite queries — escape single quotes
SAFE_CHAT_ID="${CHAT_ID//\'/\'\'}"
SAFE_FOLDER="${GROUP_FOLDER//\'/\'\'}"

if sqlite3 "$DB_PATH" "SELECT jid FROM registered_groups WHERE jid='${SAFE_CHAT_ID}'" 2>/dev/null | grep -q .; then
  error "Chat ID '$CHAT_ID' is already registered"
fi

if sqlite3 "$DB_PATH" "SELECT folder FROM registered_groups WHERE folder='${SAFE_FOLDER}'" 2>/dev/null | grep -q .; then
  error "Folder '$GROUP_FOLDER' is already registered"
fi

log "Validation passed"

# ── Step 1: Generate bridge token ────────────────────────────────

BRIDGE_TOKEN=$(openssl rand -hex 24)
log "Generated bridge token for $SLUG"

# ── Step 2: Add GHL profile with bridge_token ────────────────────

cat >> "$PROFILES_PATH" <<EOF

  ${SLUG}:
    location_id: "${LOCATION_ID}"
    access_token: "${PIT_TOKEN}"
    bridge_token: "${BRIDGE_TOKEN}"
EOF

log "Added profile '$SLUG' to profiles.yaml"

# ── Step 3: Reload bridge ───────────────────────────────────────

RELOAD_RESULT=$(curl -s -X POST "$BRIDGE_URL/admin/reload" 2>/dev/null || echo '{"error":"bridge not reachable"}')

if echo "$RELOAD_RESULT" | grep -q '"status":"reloaded"'; then
  ACCOUNT_COUNT=$(echo "$RELOAD_RESULT" | grep -o '"accounts":[0-9]*' | grep -o '[0-9]*')
  log "Bridge reloaded ($ACCOUNT_COUNT accounts)"
else
  warn "Bridge reload failed or bridge not running. Reload manually after starting it."
fi

# ── Step 4: Generate CLAUDE.md from template ─────────────────────

mkdir -p "$NANOCLAW_DIR/groups/$GROUP_FOLDER"

sed -e "s|{{BUSINESS_NAME}}|${NAME}|g" \
    -e "s|{{LOCATION_ID}}|${LOCATION_ID}|g" \
    -e "s|{{BUSINESS_DESCRIPTION}}|${DESCRIPTION}|g" \
    -e "s|{{BOT_NAME}}|${BOT_NAME}|g" \
    "$TEMPLATE_PATH" \
    > "$NANOCLAW_DIR/groups/$GROUP_FOLDER/CLAUDE.md"

# Write bridge token to a separate file (never in the prompt)
echo -n "$BRIDGE_TOKEN" > "$NANOCLAW_DIR/groups/$GROUP_FOLDER/.bridge-token"
chmod 600 "$NANOCLAW_DIR/groups/$GROUP_FOLDER/.bridge-token"

log "Generated groups/$GROUP_FOLDER/CLAUDE.md + .bridge-token"

# ── Step 5: Register group via IPC ──────────────────────────────

TASK_FILE="$IPC_DIR/register-${SLUG}-$(date +%s).json"

# Use a heredoc with single quotes to prevent any expansion in the JSON
python3 -c "
import json, sys
data = {
    'type': 'register_group',
    'jid': sys.argv[1],
    'name': sys.argv[2],
    'folder': sys.argv[3],
    'trigger': 'always',
    'requiresTrigger': False
}
json.dump(data, open(sys.argv[4], 'w'), indent=2)
" "$CHAT_ID" "$NAME" "$GROUP_FOLDER" "$TASK_FILE"

log "Wrote IPC task: $(basename "$TASK_FILE")"

# ── Step 6: Wait & verify ───────────────────────────────────────

echo -n "Waiting for registration..."
for i in 1 2 3 4 5; do
  sleep 1
  echo -n "."
  if sqlite3 "$DB_PATH" "SELECT folder FROM registered_groups WHERE folder='${SAFE_FOLDER}'" 2>/dev/null | grep -q "$GROUP_FOLDER"; then
    echo ""
    log "Group registered in database"
    break
  fi
  if [[ $i -eq 5 ]]; then
    echo ""
    warn "Registration not confirmed in DB after 5s. Check if NanoClaw is running."
    warn "The IPC file was written — it will be picked up when NanoClaw starts."
  fi
done

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Onboarding complete: ${NAME}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Slug:         $SLUG"
echo "  Folder:       groups/$GROUP_FOLDER"
echo "  Location ID:  $LOCATION_ID"
echo "  Chat ID:      $CHAT_ID"
echo "  Bridge Token: ${BRIDGE_TOKEN:0:8}...${BRIDGE_TOKEN: -8}"
echo ""
echo "Next steps:"
echo "  1. Have the customer message the bot in Telegram"
echo "  2. Verify the bot responds with ${NAME} context"
echo "  3. Ask the bot to 'show my recent contacts' to confirm GHL access"
echo ""
