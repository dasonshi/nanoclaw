#!/usr/bin/env bash
# Set up the host-side prerequisites for the RouteAware Daily Standup loop.
# Run on the VPS as the `nanoclaw` user.
#
# What this does (idempotent):
#   - Generates an SSH deploy key at ~/.ssh/routeaware_deploy
#   - Creates the scratch directory at /var/agent-work/routeaware
#     (requires sudo; will prompt or skip with instructions)
#   - Creates ~/.config/nanoclaw/mount-allowlist.json with the routeaware
#     entries (merges with existing entries; backs up first)
#   - Prompts for the GitHub PAT and writes it to
#     ~/.config/nanoclaw/routeaware-gh.token (mode 0600)
#
# What this does NOT do (you handle manually):
#   - Create the "RouteAware Standup" Telegram chat and add @SavvyClaw_Bot.
#     Send `/chatid` to the new chat in DM mode and capture the JID.
#   - Add the public deploy key to GitHub:
#       https://github.com/davidsonshine/routeaware/settings/keys
#     Tick "Allow write access".
#   - Create a fine-scoped GitHub PAT:
#       https://github.com/settings/personal-access-tokens/new
#     Repository access: only davidsonshine/routeaware
#     Repository permissions: Contents=Read+Write, Pull requests=Read+Write
#     (everything else: No access). Expiry: pick what you're comfortable with.

set -euo pipefail

if [[ "$(whoami)" != "nanoclaw" ]]; then
  echo "Run as the nanoclaw user (sudo -u nanoclaw $0)" >&2
  exit 1
fi

SSH_KEY=~/.ssh/routeaware_deploy
CONFIG_DIR=~/.config/nanoclaw
ALLOWLIST=${CONFIG_DIR}/mount-allowlist.json
TOKEN_FILE=${CONFIG_DIR}/routeaware-gh.token
SCRATCH_DIR=/var/agent-work/routeaware

echo "=== 1. SSH deploy key ==="
if [[ -f "${SSH_KEY}" ]]; then
  echo "Already exists at ${SSH_KEY} — skipping."
else
  ssh-keygen -t ed25519 -f "${SSH_KEY}" -N "" -C "routeaware-deploy@$(hostname)"
  chmod 600 "${SSH_KEY}"
fi
echo
echo "Public key to add to GitHub Deploy Keys (Allow write access):"
echo "-----------------------------"
cat "${SSH_KEY}.pub"
echo "-----------------------------"
echo

echo "=== 2. Scratch directory at ${SCRATCH_DIR} ==="
if [[ -d "${SCRATCH_DIR}" ]]; then
  echo "Already exists — skipping."
else
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo mkdir -p "${SCRATCH_DIR}" && sudo chown nanoclaw:nanoclaw "${SCRATCH_DIR}"
    echo "Created and chowned."
  else
    echo "Cannot sudo. Run this as root:"
    echo "  mkdir -p ${SCRATCH_DIR} && chown nanoclaw:nanoclaw ${SCRATCH_DIR}"
  fi
fi
echo

echo "=== 3. Mount allowlist at ${ALLOWLIST} ==="
mkdir -p "${CONFIG_DIR}"
if [[ -f "${ALLOWLIST}" ]]; then
  BACKUP="${ALLOWLIST}.bak.$(date +%s)"
  cp "${ALLOWLIST}" "${BACKUP}"
  echo "Backed up existing allowlist to ${BACKUP}"
  echo "MERGE NEEDED: the script does not auto-merge. Review and add these"
  echo "entries by hand if they aren't already present:"
else
  cat > "${ALLOWLIST}" <<JSON
{
  "allowedRoots": [
    {
      "path": "/home/nanoclaw/.config/nanoclaw",
      "allowReadWrite": false,
      "description": "Nanoclaw CLI tokens (routeaware-gh.token, etc.)"
    },
    {
      "path": "/home/nanoclaw/.ssh/routeaware_deploy",
      "allowReadWrite": false,
      "description": "RouteAware GitHub deploy key (file mount)",
      "bypassDefaultBlocks": [".ssh", "id_ed25519"]
    },
    {
      "path": "/var/agent-work/routeaware",
      "allowReadWrite": true,
      "description": "Implementer scratch dir for fresh repo clones"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
JSON
  chmod 600 "${ALLOWLIST}"
  echo "Wrote new allowlist."
fi

cat <<'JSON'
Required entries (verify they are present):

  {
    "path": "/home/nanoclaw/.config/nanoclaw",
    "allowReadWrite": false,
    "description": "Nanoclaw CLI tokens"
  },
  {
    "path": "/home/nanoclaw/.ssh/routeaware_deploy",
    "allowReadWrite": false,
    "description": "RouteAware GitHub deploy key",
    "bypassDefaultBlocks": [".ssh", "id_ed25519"]
  },
  {
    "path": "/var/agent-work/routeaware",
    "allowReadWrite": true,
    "description": "Implementer scratch dir"
  }
JSON
echo

echo "=== 4. GitHub PAT file at ${TOKEN_FILE} ==="
if [[ -f "${TOKEN_FILE}" ]]; then
  echo "Already exists — skipping."
else
  echo "Create a fine-scoped PAT at:"
  echo "  https://github.com/settings/personal-access-tokens/new"
  echo "  Repository: davidsonshine/routeaware only"
  echo "  Contents: Read+Write, Pull requests: Read+Write, Metadata: Read"
  echo
  read -r -s -p "Paste the PAT here (input hidden, press Enter when done): " PAT
  echo
  # Strip every char that isn't a valid PAT character. Defends against stray
  # arrow keys / ANSI escapes that some terminals inject on paste (seen in
  # practice: paste appended an ESC[D left-arrow sequence to the captured
  # token and authenticated as "Bad credentials" against GitHub).
  PAT="${PAT//[!a-zA-Z0-9_]/}"
  if [[ ! "${PAT}" =~ ^github_pat_[A-Za-z0-9_]+$ ]] || (( ${#PAT} < 70 )); then
    echo "Token doesn't look like a fine-grained PAT (length=${#PAT}, prefix=${PAT:0:11}). Skipping."
    echo "Create manually:"
    echo "  printf '%s' '<your-pat>' > ${TOKEN_FILE} && chmod 600 ${TOKEN_FILE}"
  else
    printf '%s' "${PAT}" > "${TOKEN_FILE}"
    chmod 600 "${TOKEN_FILE}"
    echo "Saved (${#PAT} bytes)."
  fi
  unset PAT
fi
echo

echo "=== Done ==="
echo "Remaining manual steps:"
echo "  1. In Telegram: create chat 'RouteAware Standup', add @SavvyClaw_Bot."
echo "     DM the bot with /chatid in that chat to capture the JID."
echo "  2. Add the printed public key to GitHub Deploy Keys (with write access)."
echo "  3. Tell Claude the chat JID so it can register the group and seed the cron rows."
