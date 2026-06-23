#!/usr/bin/env bash
set -euo pipefail

# Rotate bridge tokens for one or all accounts
# Usage:
#   ./scripts/rotate-tokens.sh                    # rotate ALL bridge tokens
#   ./scripts/rotate-tokens.sh --slug weight_loss_now  # rotate one account
#   ./scripts/rotate-tokens.sh --admin             # rotate admin token

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILES_PATH="$HOME/.ghl/profiles.yaml"
BRIDGE_URL="http://localhost:18800"
PLIST_PATH="$HOME/Library/LaunchAgents/com.hylo-bridge.plist"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

MODE="all"
TARGET_SLUG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --slug)  MODE="single"; TARGET_SLUG="$2"; shift 2 ;;
    --admin) MODE="admin"; shift ;;
    --all)   MODE="all"; shift ;;
    -h|--help)
      echo "Usage: $0 [--slug SLUG | --admin | --all]"
      echo ""
      echo "  --slug SLUG  Rotate bridge token for a single account"
      echo "  --admin      Rotate the BRIDGE_ADMIN_TOKEN"
      echo "  --all        Rotate ALL bridge tokens + admin token (default)"
      exit 0
      ;;
    *) error "Unknown option: $1" ;;
  esac
done

rotate_bridge_token() {
  local slug="$1"
  local new_token
  new_token=$(openssl rand -hex 24)

  # Update profiles.yaml
  python3 -c "
import sys

slug = sys.argv[1]
new_token = sys.argv[2]
profiles_path = sys.argv[3]

with open(profiles_path, 'r') as f:
    lines = f.readlines()

in_target = False
replaced = False
insert_after = -1

for i, line in enumerate(lines):
    stripped = line.rstrip()
    # Check for profile header (2-space indent, word, colon)
    if stripped and not stripped.startswith('    ') and stripped.startswith('  ') and stripped.endswith(':'):
        name = stripped.strip().rstrip(':')
        in_target = (name == slug)
        continue
    if in_target:
        if '    bridge_token:' in line:
            lines[i] = f'    bridge_token: \"{new_token}\"\n'
            replaced = True
            break
        if '    access_token:' in line:
            insert_after = i

if not replaced and insert_after >= 0:
    lines.insert(insert_after + 1, f'    bridge_token: \"{new_token}\"\n')
    replaced = True

if not replaced:
    print(f'ERROR: Could not find profile {slug}', file=sys.stderr)
    sys.exit(1)

with open(profiles_path, 'w') as f:
    f.writelines(lines)
" "$slug" "$new_token" "$PROFILES_PATH"

  # Update .bridge-token file
  local group_folder="telegram_${slug}"
  local token_file="$NANOCLAW_DIR/groups/$group_folder/.bridge-token"
  if [[ -d "$NANOCLAW_DIR/groups/$group_folder" ]]; then
    echo -n "$new_token" > "$token_file"
    chmod 600 "$token_file"
  fi

  # Also check global and main folders (admin uses these)
  for special_folder in global telegram_main; do
    local special_token="$NANOCLAW_DIR/groups/$special_folder/.bridge-token"
    if [[ -f "$special_token" ]]; then
      local current
      current=$(cat "$special_token" | tr -d '[:space:]')
      # Only update if this file held the OLD token for this account
      # (admin tokens in main/global are handled separately)
    fi
  done

  log "Rotated bridge token for '$slug': ${new_token:0:8}...${new_token: -8}"
}

rotate_admin_token() {
  local new_admin_token
  new_admin_token=$(openssl rand -hex 24)

  # Update LaunchAgent plist
  if [[ -f "$PLIST_PATH" ]]; then
    # Use python3 to safely update the plist XML
    python3 -c "
import sys, re

new_token = sys.argv[1]
plist_path = sys.argv[2]

with open(plist_path, 'r') as f:
    content = f.read()

# Replace BRIDGE_ADMIN_TOKEN value in the plist
# Pattern: <key>BRIDGE_ADMIN_TOKEN</key> followed by <string>...</string>
content = re.sub(
    r'(<key>BRIDGE_ADMIN_TOKEN</key>\s*<string>)[^<]*(</string>)',
    rf'\g<1>{new_token}\g<2>',
    content
)

with open(plist_path, 'w') as f:
    f.write(content)
" "$new_admin_token" "$PLIST_PATH"
    log "Updated BRIDGE_ADMIN_TOKEN in LaunchAgent plist"
  else
    warn "LaunchAgent plist not found at $PLIST_PATH"
  fi

  # Update .bridge-token files for David's sessions (main + global)
  for folder in telegram_main global; do
    local token_file="$NANOCLAW_DIR/groups/$folder/.bridge-token"
    if [[ -f "$token_file" ]]; then
      echo -n "$new_admin_token" > "$token_file"
      chmod 600 "$token_file"
      log "Updated .bridge-token for $folder"
    fi
  done

  log "New admin token: ${new_admin_token:0:8}...${new_admin_token: -8}"
  warn "You must reload the bridge for the new admin token to take effect:"
  warn "  launchctl unload ~/Library/LaunchAgents/com.hylo-bridge.plist"
  warn "  launchctl load ~/Library/LaunchAgents/com.hylo-bridge.plist"
}

# ── Execute ─────────────────────────────────────────────────

case "$MODE" in
  single)
    [[ -z "$TARGET_SLUG" ]] && error "Missing --slug value"
    [[ ! "$TARGET_SLUG" =~ ^[a-z0-9_]{1,64}$ ]] && error "Invalid slug: $TARGET_SLUG"
    rotate_bridge_token "$TARGET_SLUG"
    ;;
  admin)
    rotate_admin_token
    ;;
  all)
    echo "Rotating ALL bridge tokens..."
    echo ""

    # Parse slugs from profiles.yaml (skip default, skip placeholder accounts)
    SLUGS=$(python3 -c "
import sys
with open(sys.argv[1]) as f:
    for line in f:
        stripped = line.rstrip()
        if stripped.startswith('  ') and not stripped.startswith('    ') and stripped.endswith(':'):
            name = stripped.strip().rstrip(':')
            if name != 'default' and name != 'profiles':
                print(name)
" "$PROFILES_PATH")

    for slug in $SLUGS; do
      # Skip placeholder accounts
      if grep -A2 "^  ${slug}:" "$PROFILES_PATH" | grep -q '\${'; then
        warn "Skipping placeholder account: $slug"
        continue
      fi
      rotate_bridge_token "$slug"
    done

    echo ""
    rotate_admin_token

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}All tokens rotated${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    warn "Reload the bridge to activate new tokens:"
    warn "  launchctl unload ~/Library/LaunchAgents/com.hylo-bridge.plist"
    warn "  launchctl load ~/Library/LaunchAgents/com.hylo-bridge.plist"
    warn "  OR: curl -s -X POST http://localhost:18800/admin/reload"
    warn "  (bridge reload picks up new bridge_tokens but NOT new admin token)"
    ;;
esac
