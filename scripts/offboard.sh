#!/usr/bin/env bash
set -euo pipefail

# HyloClaw Customer Offboarding Script
# Usage: ./scripts/offboard.sh --slug customer_slug [--delete]

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILES_PATH="$HOME/.ghl/profiles.yaml"
BRIDGE_URL="http://localhost:18800"
DB_PATH="$NANOCLAW_DIR/store/messages.db"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

SLUG=""
DELETE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --slug)   SLUG="$2"; shift 2 ;;
    --delete) DELETE=true; shift ;;
    -h|--help)
      echo "Usage: $0 --slug SLUG [--delete]"
      echo ""
      echo "Options:"
      echo "  --slug    Customer slug to offboard"
      echo "  --delete  Permanently delete group folder (default: archive to groups/_archived/)"
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

[[ -z "$SLUG" ]] && error "Missing --slug"

# Validate slug format (same as onboard — alphanumeric + underscores only)
[[ ! "$SLUG" =~ ^[a-z0-9_]{1,64}$ ]] && error "Invalid slug format: $SLUG"

GROUP_FOLDER="telegram_${SLUG}"
GROUP_PATH="$NANOCLAW_DIR/groups/$GROUP_FOLDER"
SAFE_FOLDER="${GROUP_FOLDER//\'/\'\'}"

echo "Offboarding: $SLUG (folder: $GROUP_FOLDER)"
echo ""

# ── Step 1: Unregister via IPC (no restart needed) ──────────────

JID=$(sqlite3 "$DB_PATH" "SELECT jid FROM registered_groups WHERE folder='${SAFE_FOLDER}'" 2>/dev/null || echo "")

if [[ -n "$JID" ]]; then
  IPC_DIR="$NANOCLAW_DIR/data/ipc/telegram_main/tasks"
  mkdir -p "$IPC_DIR"
  TASK_FILE="$IPC_DIR/unregister-${SLUG}-$(date +%s).json"

  python3 -c "
import json, sys
data = {
    'type': 'unregister_group',
    'jid': sys.argv[1]
}
json.dump(data, open(sys.argv[2], 'w'), indent=2)
" "$JID" "$TASK_FILE"

  log "Unregister IPC task written for '$GROUP_FOLDER' ($JID)"

  # Wait for IPC processing
  echo -n "Waiting for unregistration..."
  for i in 1 2 3 4 5; do
    sleep 1
    echo -n "."
    if ! sqlite3 "$DB_PATH" "SELECT folder FROM registered_groups WHERE folder='${SAFE_FOLDER}'" 2>/dev/null | grep -q "$GROUP_FOLDER"; then
      echo ""
      log "Group unregistered from database and in-memory map"
      break
    fi
    if [[ $i -eq 5 ]]; then
      echo ""
      warn "Unregistration not confirmed after 5s. If NanoClaw is not running, it will process on next start."
    fi
  done
else
  warn "Group '$GROUP_FOLDER' not found in database — may already be unregistered"
fi

# ── Step 2: Remove GHL profile ──────────────────────────────────

# Use python for safe YAML manipulation instead of fragile sed
if grep -q "^  ${SLUG}:" "$PROFILES_PATH" 2>/dev/null; then
  python3 -c "
import sys
slug = sys.argv[1]
path = sys.argv[2]
with open(path) as f:
    lines = f.readlines()
output = []
skip = False
for line in lines:
    # Start skipping when we hit the slug's profile block
    if line.rstrip() == f'  {slug}:':
        skip = True
        continue
    # Stop skipping when we hit the next profile (or end of indentation)
    if skip and (line.strip() == '' or (not line.startswith('    ') and line.strip())):
        skip = False
    if not skip:
        output.append(line)
# Remove trailing blank lines
while output and output[-1].strip() == '':
    output.pop()
output.append('\n')
with open(path, 'w') as f:
    f.writelines(output)
" "$SLUG" "$PROFILES_PATH"
  log "Removed profile '$SLUG' from profiles.yaml"
else
  warn "Profile '$SLUG' not found in profiles.yaml"
fi

# ── Step 3: Reload bridge ───────────────────────────────────────

RELOAD_RESULT=$(curl -s -X POST "$BRIDGE_URL/admin/reload" 2>/dev/null || echo '{"error":"bridge not reachable"}')

if echo "$RELOAD_RESULT" | grep -q '"status":"reloaded"'; then
  ACCOUNT_COUNT=$(echo "$RELOAD_RESULT" | grep -o '"accounts":[0-9]*' | grep -o '[0-9]*')
  log "Bridge reloaded ($ACCOUNT_COUNT accounts)"
else
  warn "Bridge reload failed. Reload manually."
fi

# ── Step 4: Archive or delete group folder ──────────────────────

if [[ -d "$GROUP_PATH" ]]; then
  if $DELETE; then
    rm -rf "$GROUP_PATH"
    log "Deleted $GROUP_PATH"
  else
    mkdir -p "$NANOCLAW_DIR/groups/_archived"
    mv "$GROUP_PATH" "$NANOCLAW_DIR/groups/_archived/$GROUP_FOLDER"
    log "Archived to groups/_archived/$GROUP_FOLDER"
  fi
else
  warn "Group folder '$GROUP_PATH' not found"
fi

# ── Step 5: Clean up session data ───────────────────────────────

SESSION_DIR="$NANOCLAW_DIR/data/sessions/$GROUP_FOLDER"
if [[ -d "$SESSION_DIR" ]]; then
  if $DELETE; then
    rm -rf "$SESSION_DIR"
    log "Deleted session data: $SESSION_DIR"
  else
    mkdir -p "$NANOCLAW_DIR/data/sessions/_archived"
    mv "$SESSION_DIR" "$NANOCLAW_DIR/data/sessions/_archived/$GROUP_FOLDER"
    log "Archived session data to data/sessions/_archived/$GROUP_FOLDER"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Offboarding complete: ${SLUG}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo ""
