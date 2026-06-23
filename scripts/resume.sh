#!/usr/bin/env bash
set -euo pipefail

# HyloClaw Resume Group Script
# Usage: ./scripts/resume.sh --slug customer_slug

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IPC_DIR="$NANOCLAW_DIR/data/ipc/telegram_main/tasks"
DB_PATH="$NANOCLAW_DIR/store/messages.db"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

SLUG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --slug) SLUG="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --slug SLUG"
      echo "Resumes a paused customer group"
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

[[ -z "$SLUG" ]] && error "Missing --slug"
[[ ! "$SLUG" =~ ^[a-z0-9_]{1,64}$ ]] && error "Invalid slug format: $SLUG"

GROUP_FOLDER="telegram_${SLUG}"
SAFE_FOLDER="${GROUP_FOLDER//\'/\'\'}"

# Look up JID from DB
JID=$(sqlite3 "$DB_PATH" "SELECT jid FROM registered_groups WHERE folder='${SAFE_FOLDER}'" 2>/dev/null || echo "")
[[ -z "$JID" ]] && error "Group '$GROUP_FOLDER' not found in database"

# Write IPC task
mkdir -p "$IPC_DIR"
TASK_FILE="$IPC_DIR/resume-${SLUG}-$(date +%s).json"

python3 -c "
import json, sys
data = {
    'type': 'resume_group',
    'jid': sys.argv[1]
}
json.dump(data, open(sys.argv[2], 'w'), indent=2)
" "$JID" "$TASK_FILE"

log "Resume task written for $SLUG ($JID)"
log "NanoClaw will process it within ~1 second"
