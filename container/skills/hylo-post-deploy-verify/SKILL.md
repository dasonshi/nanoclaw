---
name: hylo-post-deploy-verify
description: Runs every 30 minutes. For each PR merged in the last hour that closes an auto-filed issue, replays the original failing tool call against the live api.hylo.pro/mcp endpoint. If it now succeeds → marks issue verified-fixed. If it still fails → loud alert + revert recommendation.
---

# Hylo Post-Deploy Verify

You close the self-improvement loop. After David merges a draft PR and Render auto-deploys, you confirm the fix actually works in production.

## Inputs you have

- `HYLO_GH_PAT` env — `export GH_TOKEN="$HYLO_GH_PAT"` for `gh`
- `HYLO_SUPABASE_SERVICE_ROLE` env — Supabase REST
- `/workspace/group/memory/known-issues.jsonl` — to find issue→pattern mapping
- `/workspace/group/memory/closed-fixed.jsonl` — already-verified (skip these)
- `mcp__nanoclaw__send_message` (or `bridge-call.sh`) for Telegram

## Step 1 — Find candidate PRs (merged in last hour, with `auto-draft` label)

```bash
export GH_TOKEN="$HYLO_GH_PAT"

# gh search: merged in last hour (use ISO timestamp)
SINCE=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)

gh pr list --repo dasonshi/hylo \
  --state merged \
  --search "label:auto-draft merged:>$SINCE" \
  --json number,title,mergedAt,body \
  > /workspace/scratch/candidates.json

COUNT=$(jq length /workspace/scratch/candidates.json)
echo "Found $COUNT candidate PRs"
if [ "$COUNT" = "0" ]; then exit 0; fi
```

## Step 2 — For each PR, find the linked issue and its signature

```bash
jq -c '.[]' /workspace/scratch/candidates.json | while read PR_JSON; do
  PR_NUM=$(echo "$PR_JSON" | jq -r .number)
  PR_BODY=$(echo "$PR_JSON" | jq -r .body)

  # Extract "Closes #N" from body
  ISSUE_NUM=$(echo "$PR_BODY" | grep -oE 'Closes #[0-9]+' | head -1 | grep -oE '[0-9]+')

  if [ -z "$ISSUE_NUM" ]; then
    echo "PR #$PR_NUM: no Closes #N reference, skipping"
    continue
  fi

  # Already verified?
  if jq -e --argjson n "$ISSUE_NUM" 'select(.issue_number == $n)' /workspace/group/memory/closed-fixed.jsonl >/dev/null 2>&1; then
    echo "Issue #$ISSUE_NUM already in closed-fixed, skipping"
    continue
  fi

  # Get signature from known-issues
  # Last-appended row per issue wins (append-only log); not max_by(.first_seen).
  SIGNATURE=$(jq -s --argjson n "$ISSUE_NUM" 'reduce .[] as $r ({}; .[$r.issue_number|tostring] = $r) | [.[]] | map(select(.issue_number == $n)) | .[0].signature' /workspace/group/memory/known-issues.jsonl 2>/dev/null | tr -d '"')

  if [ -z "$SIGNATURE" ] || [ "$SIGNATURE" = "null" ]; then
    echo "Issue #$ISSUE_NUM not in known-issues.jsonl, skipping"
    continue
  fi

  # Process this PR/issue
  bash -c "verify_one '$PR_NUM' '$ISSUE_NUM' '$SIGNATURE'"
done
```

(For clarity, define `verify_one` as a function with steps 3-6.)

## Step 3 — Pull a sample failing call from Supabase, by signature

For the linked issue's signature `<tool>:<class>:<slug>`, grab one sample failing call from **before** the PR merged.

```bash
TOOL_NAME=$(echo "$SIGNATURE" | cut -d: -f1)

# Get one pre-merge failing sample to replay
PRE_MERGE_TS=$(echo "$PR_JSON" | jq -r .mergedAt)
curl -sS --fail \
  "https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/mcp_tool_invocations?tool_name=eq.$TOOL_NAME&status=neq.ok&ts=lt.$PRE_MERGE_TS&select=args,error&order=ts.desc&limit=1" \
  -H "apikey: $HYLO_SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $HYLO_SUPABASE_SERVICE_ROLE" > /workspace/scratch/sample-call.json

SAMPLE_ARGS=$(jq -r '.[0].args' /workspace/scratch/sample-call.json)
```

## Step 4 — Replay against the live MCP endpoint

The hosted MCP is at `https://api.hylo.pro/mcp/`. You'll need an auth header — the MCP requires `X-Client-Id` + `X-Client-Secret`. **Use a dedicated post-deploy-verify client** (separate from real users so we don't pollute their dashboards). Credentials should be in env as `HYLO_MCP_VERIFY_CLIENT_ID` and `HYLO_MCP_VERIFY_CLIENT_SECRET`.

> **Note:** If these env vars don't exist yet, you need to provision a dedicated MCP client first. Comment on the issue with:
> "hylo-post-deploy-verify: missing `HYLO_MCP_VERIFY_*` creds — David needs to create a dedicated MCP client at https://api.hylo.pro/dashboard and add to `/etc/nanoclaw/hylo-monitor.env`. Skipping verification."
> Then skip and exit. Don't try to verify with a real user's creds.

```bash
if [ -z "$HYLO_MCP_VERIFY_CLIENT_ID" ] || [ -z "$HYLO_MCP_VERIFY_CLIENT_SECRET" ]; then
  gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "hylo-post-deploy-verify needs dedicated MCP client creds (HYLO_MCP_VERIFY_CLIENT_ID/SECRET in /etc/nanoclaw/hylo-monitor.env). Provision one at api.hylo.pro/dashboard, then this skill will run on the next 30-min tick."
  continue
fi

# Build the MCP tool call JSON-RPC payload
PAYLOAD=$(jq -n --arg tool "$TOOL_NAME" --argjson args "$SAMPLE_ARGS" '{
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: $tool, arguments: $args }
}')

# Call the live /mcp endpoint (Streamable HTTP transport)
REPLAY=$(curl -sS \
  -X POST "https://api.hylo.pro/mcp/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Client-Id: $HYLO_MCP_VERIFY_CLIENT_ID" \
  -H "X-Client-Secret: $HYLO_MCP_VERIFY_CLIENT_SECRET" \
  --data "$PAYLOAD" \
  --max-time 30)

# Did it succeed?
ERR=$(echo "$REPLAY" | jq -r 'if .result.isError == true then .result.content[0].text elif .error then .error.message else null end')
```

## Step 5a — Success path: mark fixed

If `ERR` is `null` and the response has a `result` body:

```bash
NOW=$(date -u +%FT%TZ)
MERGED_AT=$(echo "$PR_JSON" | jq -r .mergedAt)

echo "{\"issue_number\": $ISSUE_NUM, \"pr_number\": $PR_NUM, \"signature\": \"$SIGNATURE\", \"fixed_at\": \"$MERGED_AT\", \"verified_at\": \"$NOW\"}" >> /workspace/group/memory/closed-fixed.jsonl

# Update known-issues: append new row with status verified
echo "{\"issue_number\": $ISSUE_NUM, \"signature\": \"$SIGNATURE\", \"status\": \"verified\", \"pr_number\": $PR_NUM, \"last_seen\": \"$NOW\"}" >> /workspace/group/memory/known-issues.jsonl

# Comment on issue
gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "✅ **Post-deploy verified.** Replayed the original failing call ($TOOL_NAME / $SIGNATURE) against api.hylo.pro/mcp — now returns success. Closing.

Verified at: $NOW
PR: #$PR_NUM (merged $MERGED_AT)"

gh issue close $ISSUE_NUM --repo dasonshi/hylo --reason completed

# Delta log
echo "$(date -u +%F)	verified	PR #$PR_NUM → issue #$ISSUE_NUM ($SIGNATURE) — closed" >> /workspace/group/memory/delta-log.md
```

## Step 5b — Failure path: regression alert

If `ERR` is non-null:

```bash
ALERT_MSG="🚨 **Regression detected.** PR #$PR_NUM was supposed to fix issue #$ISSUE_NUM ($SIGNATURE), but the original failing call STILL fails against live /mcp.

Live error: $ERR

**Recommend:** revert PR #$PR_NUM and re-open issue #$ISSUE_NUM."

# Telegram alert (loud, immediate) — via the mcp__nanoclaw__send_message MCP
# tool with jid "tg:-5292785894" and text "$ALERT_MSG". (bridge-call is the GHL
# API wrapper, not a messaging tool — don't use it here.)

# Comment on PR + issue
gh pr comment $PR_NUM --repo dasonshi/hylo --body "$ALERT_MSG"
gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "⚠️ Post-deploy verification FAILED — see PR #$PR_NUM. Issue remains open."

# Delta log
echo "$(date -u +%F)	regression	PR #$PR_NUM → issue #$ISSUE_NUM ($SIGNATURE) STILL FAILING" >> /workspace/group/memory/delta-log.md

# DON'T update known-issues to verified. Leave it as pr_drafted so the next pr-drafts run can re-attempt.
```

## Don't

- Don't replay using a real user's MCP credentials. Use a dedicated verification client only.
- Don't close issues based on the PR merging — only based on the actual replay succeeding.
- Don't run the replay if any of the env vars are missing. Skip + alert.
- Don't replay calls that contain destructive args (e.g., delete operations against `hylo_delete_connection`). Filter those out — only verify read-style failures.
- Don't write to `closed-fixed.jsonl` unless verification actually succeeded.
- Don't comment on the same issue more than once per run.
