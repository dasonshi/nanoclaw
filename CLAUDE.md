# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Deployment

Production runs on the Hetzner VPS (see MEMORY.md → VPS deployment) as a **system** systemd unit. The Mac launchd service is intentionally unloaded — do not reload it without first stopping the VPS, or both will race for the same Telegram bot token.

Companion `nanoclaw-healthcheck.timer` (system unit) fires every 10 min and runs two checks. **Check 1 (Telegram polling):** hits `getWebhookInfo` and `systemctl restart nanoclaw` if `pending_update_count > 5` twice in a row (state file `/var/lib/nanoclaw-healthcheck/pending_count`). **Check 2 (Codex OAuth):** probes `chatgpt.com/backend-api/codex/responses` with the runner's access token from `/home/nanoclaw/.codex/auth.json`; a 401 means the OAuth token went stale (the refresh token can't self-renew once invalidated — needs a human `sudo -u nanoclaw codex login --device-auth`), so it sends a throttled (1/hour, state file `codex_alert_ts`) Telegram alert to `OPS_NOTIFY_JID`. The probe uses a deliberately minimal body so the backend 401s on bad auth / 400s on good auth without invoking a model (no quota cost). Without it, a stale token silently fails the OpenAI runner over to Claude and burns Anthropic credit unnoticed. Install via `sudo bash /opt/nanoclaw/deploy/install-healthcheck.sh`.

In-process recovery: `installChannelRecoveryHandler` in `src/index.ts` re-inits the Telegram channel on grammy/network-class unhandled rejections (the May 14 silent-bot incident). Trip the matcher with regex `grammy|getUpdates|ETIMEDOUT|ECONNRESET|fetch failed|409|Conflict`.

Codex→Claude escalation alert: when the OpenAI runner escalates, a Telegram message goes to `OPS_NOTIFY_JID` (env var, set to `tg:8590801863` on VPS). Throttled to one per group per hour. See `makeEscalationNotifier` in `src/index.ts`.

Service management:
```bash
# VPS (system systemd, run as root over SSH)
sudo systemctl {start,stop,restart,status} nanoclaw
journalctl -u nanoclaw -f                # live tail
journalctl -u nanoclaw --since "1 hour ago"

# macOS (launchd) — local dev only, keep VPS stopped while running
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Mount allowlist & per-group env

`src/mount-security.ts` enforces additional-mount safety against `~/.config/nanoclaw/mount-allowlist.json` (loaded once at startup, cached). Defaults block `.ssh`, `id_ed25519`, `.env`, etc. (`DEFAULT_BLOCKED_PATTERNS` at `:29`). For genuinely-required exceptions (e.g. mounting a single SSH deploy key file), add `bypassDefaultBlocks: ["pattern1", "pattern2"]` to that specific `AllowedRoot` — never globally.

`ContainerConfig.env` (per-group) is allowlisted in `src/container-runner.ts` to keys matching `^(OPENAI|ROUTEAWARE|HYLO)_`. The gate exists so per-group config (set by main-group operators through `register_group` IPC) can't become a generic env-injection surface. Extend the regex when adding a new namespace.

## Cross-group task scheduling

By default, non-main groups can only schedule IPC tasks for themselves (`src/ipc.ts:208`). To pair groups (e.g. the routeaware standup → routeaware-implementer-exec handoff where exec holds the deploy key), set `allowedTargets: ["target_folder"]` on the source group at registration. Stored in `registered_groups.allowed_targets` (JSON-encoded). Migration is at `src/db.ts` and the column is read in `getAllRegisteredGroups`.

## RouteAware standup loop

Daily agentic loop for `dasonshi/route-aware`. Two groups in cluster:
- `telegram_routeaware_standup` (chat `tg:-5257303857`) — strategist + reviewers + spec + plan + audit run here. Mounts the GH PAT (read-only).
- `routeaware_implementer_exec` (synthetic JID `routeaware-exec@local`, no inbound channel) — only the implementer-exec skill runs here. Mounts deploy key, PAT, scratch dir, standup state (ro), standup memory (rw).

Per-gate auto-approve config at `groups/telegram_routeaware_standup/auto-approve.json`. `always_human` floor (migrations, package.json, env, branch=main, force_push, new_dependency, schema_change) escalates regardless of gate state. Memory layer at `groups/telegram_routeaware_standup/memory/` — per-agent durable files + shared approvals.md / delta-log.md. See the layer README in that folder.

Cron rows in `scheduled_tasks` prefixed `ra-*` (all default paused until first end-to-end smoke test passes).

## OpenAI Runner Auth

The `openai` runner (`container/openai-runner/`) accepts two auth sources, in order of preference:

1. **Codex OAuth (ChatGPT subscription).** Run `codex login` on the host; this creates `~/.codex/auth.json`. The container mount picks it up and calls `https://chatgpt.com/backend-api/codex` via the Responses API. Tokens are refreshed in place by the runner. Default model: `gpt-5.5` (override with `OPENAI_MODEL`). The ChatGPT-account backend rejects other model names (e.g. `gpt-5-codex`, `gpt-4o`) with HTTP 400.
2. **`OPENAI_API_KEY`.** Standard `api.openai.com` Responses API. Default model: `gpt-4o`.

If neither is present, `runContainerWithFallback` skips the OpenAI runner and goes straight to the Claude runner. The runner returns `escalate` on API errors so the orchestrator can retry against Claude.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
