# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **ops:** Host-side post-deploy gate (`deploy/hylo-post-deploy-gate.*`, systemd timer) replaces the `*/30` agent cron that spun a full LLM container every 30 min just to find no merged PR — eliminates ~48 wasted agent calls/day and alerts on GitHub API/auth failure instead of failing silently.
- **feat(hylo_monitor):** `hylo-auto-merge` skill — gated auto-merge of green `auto-draft` PRs (deterministic gate re-run at merge time + independent review + adversarial self-audit; ships report-only via `pr_to_merge.enabled`).

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
