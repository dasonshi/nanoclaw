#!/usr/bin/env bash
# Health check for NanoClaw Telegram polling + Codex OAuth.
#
# Fires every 10 min via nanoclaw-healthcheck.timer.
#
# Check 1 — Telegram polling: Calls getWebhookInfo and reads
# pending_update_count. If the queue is >5 twice in a row, the long-polling
# loop is presumed dead and we restart nanoclaw. Safety net for the May 14
# incident (an unhandled getUpdates 409 killed grammy's polling silently).
# Two recovery layers back this up:
#   1. unhandledRejection handler in src/index.ts (immediate, in-process)
#   2. this timer (10-min worst-case detection)
#
# Check 2 — Codex OAuth: probes the ChatGPT Responses backend with the
# runner's access token. A 401 means the OAuth refresh token went stale
# (it can't self-renew once invalidated — needs a human `codex login
# --device-auth`). When that happens the OpenAI runner silently fails over
# to Claude and burns Anthropic credit, so we send a throttled (1/hour)
# Telegram alert to OPS_NOTIFY_JID *before* the bill grows. Added 2026-06-02
# after the token died idle (~9 days) and went unnoticed for an hour.
#
# Uses curl + sed + python3 — all present on the stock VPS install set.

set -u

STATE_DIR=/var/lib/nanoclaw-healthcheck
STATE_FILE=${STATE_DIR}/pending_count
mkdir -p "${STATE_DIR}"

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "${TOKEN}" ]]; then
  # No bot configured (e.g. WhatsApp-only deploy). Nothing to check.
  exit 0
fi

INFO=$(curl -sS --max-time 10 "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" || true)
if [[ -z "${INFO}" ]]; then
  logger -t nanoclaw-healthcheck "Telegram API unreachable, skipping check"
  exit 0
fi

PENDING=$(echo "${INFO}" | sed -n 's/.*"pending_update_count":\([0-9]*\).*/\1/p')
PENDING=${PENDING:-0}

PREV=0
if [[ -r "${STATE_FILE}" ]]; then
  PREV=$(cat "${STATE_FILE}")
  PREV=${PREV:-0}
fi
echo "${PENDING}" > "${STATE_FILE}"

if (( PENDING > 5 && PREV > 5 )); then
  logger -t nanoclaw-healthcheck \
    "pending_update_count=${PENDING} twice in a row (prev=${PREV}), restarting nanoclaw"
  systemctl restart nanoclaw
  # Clear state so we don't immediately re-trigger after restart
  echo 0 > "${STATE_FILE}"
fi

# --- Check 2: Codex OAuth token validity -----------------------------------
# A stale/invalidated OAuth refresh token makes the OpenAI runner 401 and
# silently fall back to Claude. Probe auth before that costs real money.
CODEX_AUTH=/home/nanoclaw/.codex/auth.json
CODEX_TS_FILE=${STATE_DIR}/codex_alert_ts

if [[ -r "${CODEX_AUTH}" ]]; then
  # Extract auth_mode + account_id + access_token (robust JSON parse; the
  # token is a long whitespace-free string so `read` splits cleanly).
  read -r CODEX_MODE CODEX_AID CODEX_AT < <(python3 - "${CODEX_AUTH}" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    t = d.get("tokens", {}) or {}
    print(d.get("auth_mode", ""), t.get("account_id", ""), t.get("access_token", ""))
except Exception:
    print("", "", "")
PY
)

  # Only the ChatGPT-subscription OAuth path can silently go stale this way.
  if [[ "${CODEX_MODE}" == "chatgpt" && -n "${CODEX_AT}" ]]; then
    # Deliberately minimal body: the backend authenticates BEFORE validating
    # the request, so a healthy token returns 400 (bad body) and a dead one
    # returns 401 — no model is invoked, so this costs no quota.
    CODE=$(curl -sS --max-time 15 -o /dev/null -w "%{http_code}" \
      https://chatgpt.com/backend-api/codex/responses \
      -H "Authorization: Bearer ${CODEX_AT}" \
      -H "chatgpt-account-id: ${CODEX_AID}" \
      -H "OpenAI-Beta: responses=experimental" \
      -H "originator: codex_cli_rs" \
      -H "Content-Type: application/json" \
      -d '{"model":"gpt-5.5","stream":true,"store":false,"input":[{"role":"user","content":[{"type":"input_text","text":"ping"}]}]}' \
      || echo "000")

    if [[ "${CODE}" == "401" ]]; then
      logger -t nanoclaw-healthcheck "Codex OAuth token invalid (HTTP 401) — runner is failing over to Claude"
      NOW=$(date +%s)
      LAST=0
      if [[ -r "${CODEX_TS_FILE}" ]]; then LAST=$(cat "${CODEX_TS_FILE}"); LAST=${LAST:-0}; fi
      # Throttle to one alert per hour, matching the in-app escalation notifier.
      if (( NOW - LAST >= 3600 )); then
        CHAT_ID=${OPS_NOTIFY_JID:-}   # default-empty: script runs under `set -u`
        CHAT_ID=${CHAT_ID#tg:}
        if [[ -n "${TOKEN}" && -n "${CHAT_ID}" ]]; then
          MSG="⚠️ NanoClaw: Codex OAuth token invalidated (HTTP 401). OpenAI runner is failing over to Claude — Anthropic credit is being spent. Re-auth on the VPS: sudo -u nanoclaw codex login --device-auth"
          curl -sS --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${CHAT_ID}" \
            --data-urlencode "text=${MSG}" >/dev/null || true
          echo "${NOW}" > "${CODEX_TS_FILE}"
        fi
      fi
    elif [[ "${CODE}" == "000" || -z "${CODE}" ]]; then
      logger -t nanoclaw-healthcheck "Codex probe network error, skipping"
    else
      # Healthy (200/400/etc): clear the throttle so the next real failure
      # alerts immediately rather than being suppressed by a stale timestamp.
      rm -f "${CODEX_TS_FILE}" 2>/dev/null || true
    fi
  fi
fi
