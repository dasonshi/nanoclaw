#!/usr/bin/env bash
# Host-side gate for the hylo-post-deploy-verify skill.
#
# Fires every 30 min via hylo-post-deploy-gate.timer. Runs the *cheap*
# detection half of the skill directly on the host (a single GitHub search
# API call, no LLM) and only enqueues a one-off agent task when an
# auto-draft PR was actually merged in the last hour.
#
# Before this, a `*/30 * * * *` cron spun up a full Codex/Claude agent
# container every 30 min just to run `gh pr list`, find nothing ~99% of the
# time, and exit — ~48 wasted agent calls/day (2026-07-04). The agent is now
# invoked only when there is real work, so the steady-state cost is one
# GitHub API request per tick.
#
# The enqueued task runs the same `hylo-post-deploy-verify` skill, whose own
# 1h-lookback gh query + closed-fixed.jsonl dedup make it idempotent, so an
# occasional double-enqueue is harmless. We still dedup by PR number here to
# avoid re-enqueuing across the overlapping 30-min ticks / 1h window.
#
# Env (from /etc/nanoclaw/hylo-monitor.env): HYLO_GH_PAT.
# Uses curl + python3 + sqlite3 — all present on the stock VPS.

set -u

REPO="dasonshi/hylo"
DB="/opt/nanoclaw/store/messages.db"
GROUP="hylo_monitor"
CHAT_JID="tg:-5292785894"
STATE_DIR="/var/lib/nanoclaw-hylo-gate"
SEEN_FILE="${STATE_DIR}/enqueued_prs"
mkdir -p "${STATE_DIR}"
touch "${SEEN_FILE}"

if [[ -z "${HYLO_GH_PAT:-}" ]]; then
  logger -t hylo-post-deploy-gate "missing HYLO_GH_PAT, skipping"
  exit 0
fi

SINCE=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)

# Single GitHub search: merged auto-draft PRs since SINCE. No model, no cost.
RESP=$(curl -sS --max-time 20 -G "https://api.github.com/search/issues" \
  --data-urlencode "q=repo:${REPO} is:pr is:merged label:auto-draft merged:>=${SINCE}" \
  --data-urlencode "per_page=50" \
  -H "Authorization: Bearer ${HYLO_GH_PAT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" || true)

if [[ -z "${RESP}" ]]; then
  logger -t hylo-post-deploy-gate "GitHub API unreachable, skipping tick"
  exit 0
fi

# Extract PR numbers (one per line). On API error (no .items) prints nothing.
# python3 -c (not a heredoc) — a heredoc inside $(...) with a trailing `|| true`
# is a bash parse error.
NUMBERS=$(printf '%s' "${RESP}" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    for it in d.get("items", []):
        n = it.get("number")
        if isinstance(n, int):
            print(n)
except Exception:
    pass
' 2>/dev/null || true)

if [[ -z "${NUMBERS}" ]]; then
  # Nothing merged in the window — the common case. Exit silently, no LLM.
  exit 0
fi

# Enqueue only PR numbers we haven't already handed to the agent.
NEW=""
while read -r PR; do
  [[ -z "${PR}" ]] && continue
  if ! grep -qx "${PR}" "${SEEN_FILE}"; then
    NEW="${NEW} ${PR}"
  fi
done <<< "${NUMBERS}"

NEW=$(echo "${NEW}" | xargs || true)
if [[ -z "${NEW}" ]]; then
  # Seen every candidate on a previous tick already — nothing to do.
  exit 0
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
TASK_ID="hylo-verify-$(date -u +%s)"

# Insert one once-task; the scheduler picks it up on its next poll, runs the
# skill once, then flips status to 'completed'. busy_timeout guards against
# the live nanoclaw process holding a write lock (journal_mode=delete).
sqlite3 "${DB}" <<SQL
PRAGMA busy_timeout=10000;
INSERT INTO scheduled_tasks
  (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES
  ('${TASK_ID}', '${GROUP}', '${CHAT_JID}', 'Run skill hylo-post-deploy-verify.', 'once', '${NOW}', 'isolated', '${NOW}', 'active', '${NOW}');
SQL
RC=$?

if [[ ${RC} -ne 0 ]]; then
  logger -t hylo-post-deploy-gate "sqlite insert failed (rc=${RC}) for PRs:${NEW} — will retry next tick"
  exit 0   # don't record as seen; retry on the next tick
fi

# Record as enqueued and keep the state file bounded.
for PR in ${NEW}; do echo "${PR}" >> "${SEEN_FILE}"; done
tail -n 500 "${SEEN_FILE}" > "${SEEN_FILE}.tmp" && mv "${SEEN_FILE}.tmp" "${SEEN_FILE}"

logger -t hylo-post-deploy-gate "enqueued ${TASK_ID} for merged auto-draft PRs:${NEW}"
