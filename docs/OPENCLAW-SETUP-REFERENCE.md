# OpenClaw Setup Reference

## Overview

Self-hosted AI agent running on primary MacBook Pro, accessible via Telegram, WhatsApp, and Web UI at `claw.savvysales.ai`. Uses Claude Haiku 4.5 as LLM backend.

## Machine

- MacBook Pro M4 Max, 48GB RAM, macOS Darwin 24.6.0
- Docker v29.1.3 + Compose v2.40.3
- Network: DHCP/residential, dynamic IP

## Architecture

```
[Telegram] ──long poll──> [OpenClaw Gateway :18789] ──> [Anthropic API]
[WhatsApp] ──baileys───>  [  Docker Container       ]
[Web UI]   ──tunnel────>  [  ~/.openclaw/            ]
                               |
                          [Cloudflare Tunnel: coi-local]
                               |
                          [claw.savvysales.ai]
                               |
                          [Cloudflare Zero Trust / Access]
                          (email OTP: sonshine.david@gmail.com)
```

## Key URLs & Endpoints

| What | URL |
|------|-----|
| Web UI (local) | http://127.0.0.1:18789/ |
| Web UI (remote) | https://claw.savvysales.ai/ |
| Cloudflare Zero Trust dashboard | https://one.dash.cloudflare.com/ |
| Anthropic console | https://console.anthropic.com/ |
| OpenClaw GitHub | https://github.com/openclaw/openclaw |

## Credentials & Tokens (names only, not values)

| Secret | Location |
|--------|----------|
| Anthropic API key | `~/Desktop/openclaw/repo/.env` → `ANTHROPIC_API_KEY` |
| Gateway auth token | `~/.openclaw/openclaw.json` → `gateway.auth.token` |
| Gateway auth token (also in) | `~/Desktop/openclaw/repo/.env` → `OPENCLAW_GATEWAY_TOKEN` |
| Telegram bot token | Added via CLI, stored in `~/.openclaw/` |
| WhatsApp session | `~/.openclaw/credentials/whatsapp/` |
| Cloudflare tunnel credentials | `~/.cloudflared/f53a6130-bdc6-4157-a785-0d5a43d288e3.json` |

## File Locations

| File | Purpose |
|------|---------|
| `~/Desktop/openclaw/repo/` | OpenClaw git repo + docker-compose |
| `~/Desktop/openclaw/repo/.env` | Environment vars (API keys, gateway token) |
| `~/Desktop/openclaw/repo/docker-compose.yml` | Docker service definitions |
| `~/.openclaw/openclaw.json` | Core config (security, channels, model, tools) |
| `~/.openclaw/agents/main/agent/AGENTS.md` | Agent system prompt (behavior rules) |
| `~/.openclaw/workspace/` | Agent sandboxed workspace |
| `~/.openclaw/credentials/` | Channel credentials (WhatsApp, etc.) |
| `~/.openclaw/logs/` | Cloudflared and healthcheck logs |
| `~/.openclaw/scripts/healthcheck.sh` | 5-min health monitor (not yet in crontab) |
| `~/.openclaw/scripts/backup.sh` | Weekly config backup (not yet in crontab) |
| `~/.openclaw/scripts/rotate-token.sh` | Gateway token rotation |
| `~/.openclaw/backups/` | Config backup archives |
| `~/.cloudflared/config.yml` | Cloudflare tunnel ingress rules |
| `~/Library/LaunchAgents/com.openclaw.caffeinate.plist` | AC-only sleep prevention |
| `~/Library/LaunchAgents/com.openclaw.cloudflared.plist` | Auto-start tunnel on login |

## Security Layers

### Layer 1: Cloudflare Zero Trust (Access)
- Protects `claw.savvysales.ai` with email OTP
- Only `sonshine.david@gmail.com` is approved
- 24-hour session duration
- Team: `savvysales.cloudflareaccess.com`

### Layer 2: Gateway Auth Token
- Required to access Web UI and API
- Rate limited: 10 attempts per 60s, 5-min lockout
- Loopback (localhost) exempt from rate limiting

### Layer 3: Docker Sandbox
- Mode: `all` (every agent runs sandboxed)
- Network: `none` (no outbound from sandbox)
- Read-only root filesystem
- 1GB RAM, 1 CPU, 256 PID limit
- Workspace access: read/write within `~/.openclaw/workspace/` only

### Layer 4: Tool Restrictions
- Profile: `messaging` (restrictive baseline)
- Denied: `group:automation`, `group:runtime`, `group:fs`, `sessions_spawn`, `sessions_send`
- Filesystem: workspace only
- Exec: requires user approval on every command
- Elevated access: disabled
- Loop detection: warns at 10, critical at 20, circuit breaker at 30

### Layer 5: Channel Access Control
- Telegram: pairing mode (must approve device)
- WhatsApp: pairing mode, groups disabled
- Session isolation: `per-channel-peer`

### Layer 6: Budget
- LLM: Claude Haiku 4.5 ($1/M input, $5/M output)
- Anthropic balance: ~$12 (natural hard cap)
- Agent: maxConcurrent 1, timeout 120s

## LLM Configuration

- Provider: Anthropic
- Model: `anthropic/claude-haiku-4-5`
- Max concurrent agents: 1
- Timeout per turn: 120 seconds
- Estimated cost: ~$10-15/month at moderate usage

## Cloudflare Tunnel

- Tunnel name: `coi-local`
- Tunnel ID: `f53a6130-bdc6-4157-a785-0d5a43d288e3`
- Ingress rules:
  - `dev-api.savvysales.ai` → `localhost:8080` (legacy, unused)
  - `claw.savvysales.ai` → `localhost:18789` (OpenClaw)
  - Catch-all → 404

## Docker

- Container: `repo-openclaw-gateway-1`
- Image: `ghcr.io/openclaw/openclaw:latest`
- Ports: 18789-18790
- Restart policy: `unless-stopped`
- Docker Desktop: should be set to start on login

## Common Commands

```bash
# --- Gateway ---
cd ~/Desktop/openclaw/repo

# Check status
docker compose ps
curl http://127.0.0.1:18789/healthz

# Restart gateway
docker compose restart openclaw-gateway

# View logs
docker compose logs openclaw-gateway --tail 50

# Update OpenClaw
git pull
docker pull ghcr.io/openclaw/openclaw:latest
docker compose up -d openclaw-gateway

# --- CLI ---
CLI="docker compose run --rm openclaw-cli"

# View config
$CLI config get agents.defaults.sandbox.mode

# Set config
$CLI config set <key> <value>

# Security audit
$CLI security audit --deep

# Channel status
$CLI channels status

# --- Channels ---
# Add Telegram bot
$CLI channels add --channel telegram --token "BOT_TOKEN"

# Link WhatsApp (QR code)
$CLI channels login --channel whatsapp

# Approve pairing
$CLI pairing list telegram
$CLI pairing approve telegram <CODE>

# --- Tunnel ---
cloudflared tunnel info coi-local
cloudflared tunnel list

# --- Maintenance ---
~/.openclaw/scripts/healthcheck.sh    # manual health check
~/.openclaw/scripts/backup.sh         # manual backup
~/.openclaw/scripts/rotate-token.sh   # rotate gateway token
docker system prune -f                # reclaim disk space

# --- Rollback (full removal) ---
docker compose down
launchctl unload ~/Library/LaunchAgents/com.openclaw.caffeinate.plist
launchctl unload ~/Library/LaunchAgents/com.openclaw.cloudflared.plist
rm -rf ~/Desktop/openclaw/repo
rm -rf ~/.openclaw
rm ~/Library/LaunchAgents/com.openclaw.caffeinate.plist
rm ~/Library/LaunchAgents/com.openclaw.cloudflared.plist
# Then remove claw.savvysales.ai CNAME in Cloudflare dashboard
# Then remove Access application in Zero Trust dashboard
```

## Agent Behavior (Semi-Autonomous)

Defined in `~/.openclaw/agents/main/agent/AGENTS.md`:

- **Auto-approve**: reads, searches, answering questions
- **Require approval**: writes, exec, external API calls, proactive messages
- **Auto-pause**: 3+ failed tool calls, low confidence, no progress

## Completed Setup Steps

- [x] Connect Telegram (@SavvyClaw_Bot, long polling mode)
- [x] Web UI paired and working (local + remote via claw.savvysales.ai)
- [x] Enable FileVault
- [x] Docker Desktop auto-updates disabled
- [x] Cloudflare Zero Trust (email OTP) protecting remote access
- [x] Gateway tool denied (agent cannot modify its own config)

## Not Yet Done (Optional)

- [ ] Connect WhatsApp (skipped — would share business contacts; use separate number if desired)
- [ ] Docker Desktop auto-start on login (user didn't sign in)
- [ ] Crontab for healthcheck and backup scripts (user declined)
- [ ] Re-enable Docker sandbox (requires Docker socket mount in docker-compose.yml)
- [ ] Anthropic spend limit (currently capped by $12 balance)

## Monthly Maintenance

1. Check Anthropic spend / top up balance
2. `docker pull ghcr.io/openclaw/openclaw:latest && docker compose up -d`
3. `docker system prune -f`
4. Review `~/.openclaw/logs/healthcheck.log`
5. Verify `fdesetup status` (FileVault ON)
6. Check `~/.openclaw/logs/cloudflared.err.log`
7. Consider rotating gateway token

## Adversarial Review Notes

These were identified during planning and addressed:

| Risk | Mitigation |
|------|-----------|
| Gateway exposed to internet | Cloudflare Access (email OTP) |
| Static gateway token | Rotation script available |
| Telegram bot discoverable | BotFather: disable join groups + enable privacy |
| Prompt injection via web content | Browser denied, exec requires approval, loop detection |
| FileVault OFF on laptop | Must enable (currently still off) |
| No backup plan | Backup script created |
| Token budget overrun | $12 balance cap + loop detection + maxConcurrent 1 |
| Semi-autonomous ambiguity | Explicit rules in AGENTS.md |
| Battery drain from caffeinate | AC-only (`-s` flag) |
| Docker auto-updates | Disable in Docker Desktop settings |
