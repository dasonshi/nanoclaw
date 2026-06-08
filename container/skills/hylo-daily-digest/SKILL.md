---
name: hylo-daily-digest
description: Runs once daily. Queries the Supabase mcp_tool_invocations table for the last 24h of hosted Hylo MCP traffic, clusters failures by (tool_name, error pattern), posts a digest to Telegram, and files GitHub issues for new patterns with ≥3 occurrences. Source of truth for "what broke today."
---

# Hylo Daily Digest

You are the morning monitor for the hosted Hylo MCP server. Your only job: look at the last 24h of traffic, surface what's broken, and either file or update GitHub issues so failure patterns don't get lost.

## Inputs you have

**Env vars (per-group, via `$PROCESS_ENV` allowlist):**

- `HYLO_SUPABASE_SERVICE_ROLE` — Bearer token for `https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/`
- `HYLO_GH_PAT` — GitHub PAT scoped to `dasonshi/hylo` (Issues:write)

**Files:**

- `/workspace/group/memory/known-issues.jsonl` — append-only, one row per pattern we've filed. Check this BEFORE filing a new issue to avoid duplicates.
- `/workspace/group/memory/closed-fixed.jsonl` — issues that were merged + post-deploy-verified. Also check for dedup (closed issues that recur are a regression — handle differently).
- `/workspace/group/memory/delta-log.md` — append events here.
- `/workspace/group/auto-approve.json` — read the `digest_to_issue` gate to confirm thresholds (`occurrences>=3` by default).

**Tools:**

- `curl` for Supabase REST API
- `gh` CLI for GitHub Issues (`GH_TOKEN=$HYLO_GH_PAT gh issue create ...`)
- `jq` for JSON manipulation
- NanoClaw MCP tool `mcp__nanoclaw__send_message` (with `jid: tg:-5292785894`) for Telegram posts. This is the ONLY way to post to Telegram — `/usr/local/bin/bridge-call` is the GHL API wrapper, not a messaging tool.

## Step 1 — Set up the day's state dir

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
mkdir -p "$DIR"
cd "$DIR"
```

## Step 2 — Pull last 24h of invocations

```bash
SINCE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)

curl -sS --fail \
  "https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/mcp_tool_invocations?ts=gte.$SINCE&select=id,client_id,tool_name,args,intent,error,status,duration_ms,ts" \
  -H "apikey: $HYLO_SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $HYLO_SUPABASE_SERVICE_ROLE" \
  > $DIR/raw.json

echo "Pulled $(jq length $DIR/raw.json) rows"
```

If `raw.json` has 0 rows: the digest is "no traffic in last 24h." Post that to Telegram and exit.

## Step 3 — Compute summary stats

```bash
TOTAL=$(jq length raw.json)
OK=$(jq '[.[] | select(.status == "ok")] | length' raw.json)
ERR=$(jq '[.[] | select(.status != "ok")] | length' raw.json)
ERR_RATE=$(awk -v e=$ERR -v t=$TOTAL 'BEGIN{ if(t>0) printf "%.1f", (e/t)*100; else print "0.0" }')

# Top callers (per client_id, ok + error counts)
jq '[group_by(.client_id)[] | {client: .[0].client_id, total: length, errors: [.[] | select(.status != "ok")] | length}] | sort_by(-.total)' raw.json > by_client.json
```

## Step 4 — Cluster failure patterns

Each failure gets a stable **signature**: `<tool_name>:<error_class>:<short_slug>`

- `error_class`: extract HTTP status if present (`/[0-9]{3}/`), else first word of error message
- `short_slug`: lowercase + replace non-alphanumeric with `_`, truncate to 40 chars

```bash
jq -r '
  [.[] | select(.status != "ok") | {
    tool_name,
    error,
    intent,
    client_id,
    ts,
    args
  }] | .[] | @json
' raw.json > errors.jsonl

# Build cluster file: { signature, tool_name, error_class, slug, occurrences, sample_errors, sample_intents, client_count }
python3 <<'PY'
import json, re
from collections import defaultdict
clusters = defaultdict(lambda: {
    "tool_name": None, "error_class": None, "slug": None,
    "occurrences": 0, "sample_errors": [], "sample_intents": [],
    "clients": set(), "args_samples": [], "first_ts": None, "last_ts": None,
})
for line in open("errors.jsonl"):
    r = json.loads(line)
    err = r.get("error") or "unknown"
    m = re.search(r"\b([0-9]{3})\b", err)
    cls = m.group(1) if m else (err.split()[0] if err else "unknown")[:20]
    slug_src = err.lower()[:80]
    slug = re.sub(r"[^a-z0-9]+", "_", slug_src).strip("_")[:40]
    sig = f"{r['tool_name']}:{cls}:{slug}"
    c = clusters[sig]
    c["tool_name"] = r["tool_name"]
    c["error_class"] = cls
    c["slug"] = slug
    c["occurrences"] += 1
    c["clients"].add(r.get("client_id") or "unknown")
    if len(c["sample_errors"]) < 3: c["sample_errors"].append(err[:200])
    if r.get("intent") and len(c["sample_intents"]) < 3: c["sample_intents"].append(r["intent"][:200])
    if len(c["args_samples"]) < 3: c["args_samples"].append(r.get("args"))
    ts = r.get("ts")
    if ts:
        if not c["first_ts"] or ts < c["first_ts"]: c["first_ts"] = ts
        if not c["last_ts"]  or ts > c["last_ts"]:  c["last_ts"]  = ts

with open("clusters.json", "w") as f:
    out = []
    for sig, c in sorted(clusters.items(), key=lambda x: -x[1]["occurrences"]):
        c["signature"] = sig
        c["client_count"] = len(c["clients"])
        c["clients"] = sorted(c["clients"])
        out.append(c)
    json.dump(out, f, indent=2)
print(f"Built {len(out)} failure clusters")
PY
```

## Step 5 — Dedup against known and closed issues

```bash
# Load known signatures (open OR pr_drafted)
KNOWN_SIGS=$(jq -r 'select(.status == "open" or .status == "pr_drafted") | .signature' /workspace/group/memory/known-issues.jsonl 2>/dev/null | sort -u)
CLOSED_SIGS=$(jq -r '.signature' /workspace/group/memory/closed-fixed.jsonl 2>/dev/null | sort -u)

# For each cluster in clusters.json: tag with status
#   - "known_open"   if sig in KNOWN_SIGS
#   - "closed_fixed" if sig in CLOSED_SIGS (REGRESSION — must alert)
#   - "new"          otherwise
python3 <<PY
import json
known = set("""$KNOWN_SIGS""".split())
closed = set("""$CLOSED_SIGS""".split())
data = json.load(open("clusters.json"))
for c in data:
    sig = c["signature"]
    if sig in closed: c["status_vs_history"] = "regression"
    elif sig in known: c["status_vs_history"] = "known_open"
    else: c["status_vs_history"] = "new"
json.dump(data, open("clusters.json", "w"), indent=2)
PY
```

## Step 6 — File new issues (gated by auto-approve)

Read the gate config:

```bash
THRESHOLD=$(jq -r '.digest_to_issue.require[] | select(startswith("occurrences"))' /workspace/group/auto-approve.json | sed 's/occurrences>=//')
# default 3 if missing
THRESHOLD=${THRESHOLD:-3}
```

For each cluster with `status_vs_history == "new"` AND `occurrences >= THRESHOLD`:

Cap at **3 new issues per run** (per group CLAUDE.md rule). If more qualify, file the top 3 by occurrences and note the rest in the digest.

For each qualifying cluster, file an issue with this body shape:

```bash
export GH_TOKEN="$HYLO_GH_PAT"

ISSUE_BODY=$(cat <<EOF
**Auto-filed by hylo_monitor** — $(date -u +%FT%TZ)

## Failure signature
\`<signature>\`

## Last 24h
- Occurrences: **<N>**
- Affected clients: <client_count>
- First seen: <first_ts>
- Last seen:  <last_ts>

## Sample errors
\`\`\`
<sample_errors joined with newline>
\`\`\`

## Sample user intents (Claude's reconstruction)
<sample_intents — if all null, write "(no intent reconstructions yet — connector cache may be stale)">

## Sample args
\`\`\`json
<args_samples[0]>
\`\`\`

---
Filed automatically because: occurrences ≥ \$THRESHOLD, signature not in known-issues.jsonl, signature not in closed-fixed.jsonl.

NanoClaw \`hylo-pr-drafts\` will attempt a fix in tomorrow's run. If you want it to skip this issue, label it \`wontfix\` or close it.
EOF
)

ISSUE_NUM=$(gh issue create --repo dasonshi/hylo \
  --title "[auto] <tool_name>: <error_class> <slug> (<N> in 24h)" \
  --body "$ISSUE_BODY" \
  --label "auto-filed,hylo-monitor" \
  | grep -oE '[0-9]+$')

echo "Filed #$ISSUE_NUM for $signature"

# Append to known-issues.jsonl
echo "{\"issue_number\": $ISSUE_NUM, \"signature\": \"$SIG\", \"first_seen\": \"$FIRST_TS\", \"last_seen\": \"$LAST_TS\", \"occurrences\": $N, \"status\": \"open\"}" >> /workspace/group/memory/known-issues.jsonl

# Append to delta-log
echo "$(date -u +%F)	issue_filed	#$ISSUE_NUM $signature ($N in 24h)" >> /workspace/group/memory/delta-log.md
```

For each cluster with `status_vs_history == "known_open"`: update the existing issue's row in `known-issues.jsonl` with new occurrence count + last_seen (append a new row; readers take the latest per `issue_number`).

For each cluster with `status_vs_history == "regression"`: **alert loudly.** Telegram message starts with `🚨 REGRESSION` mentioning the issue/PR that was supposed to fix it.

## Step 7 — Post the digest to Telegram

Format:

```
🔍 Hylo MCP — Daily Digest (YYYY-MM-DD UTC)

24h: <TOTAL> calls · <OK> ok · <ERR> errors (<ERR_RATE>%)

🆕 New issues filed today (<count>)
1. #<num> <tool_name> · <error_class> <slug> (<N>x, <client_count> clients)
2. ...

📊 Continuing patterns (<count>)
1. #<num> <tool_name> · <error_class> <slug> (<N> more today, <total_since_filed> total)
2. ...

🚨 Regressions (<count>)
1. PR #<pr> → #<orig_issue>: <signature> failing again (<N>x in 24h) — RECOMMEND REVERT

(empty sections omitted)
```

Keep it under 4000 chars (Telegram limit). If too long, trim to top-5 in each section and add `…+<N> more (see GH issues)`.

Send:

Use the `mcp__nanoclaw__send_message` MCP tool with `jid: "tg:-5292785894"` and `text: "$DIGEST"`. (There is no shell command for this — posting goes through the MCP tool, not `bridge-call`.)

## Step 8 — Append summary to delta-log

```bash
echo "$(date -u +%F)	digest	<TOTAL> calls / <ERR> errors / <new_count> new / <regression_count> regressions" >> /workspace/group/memory/delta-log.md
```

## Don't

- Don't include raw `args` or `response` bodies in the Telegram digest (PII risk). The full data is in Supabase for diagnosis; the digest is summary only.
- Don't file more than 3 new issues per run.
- Don't file an issue if the signature exists in `known-issues.jsonl` (open OR pr_drafted) or `closed-fixed.jsonl`. (Closed-fixed = regression — alert, don't file.)
- Don't post the digest if there were zero rows in the 24h window. Send a one-liner instead: `🔍 Hylo MCP: no traffic in last 24h. (Either users are quiet or the connector's down — worth checking the live /mcp endpoint.)`
- Don't run if `$HYLO_SUPABASE_SERVICE_ROLE` or `$HYLO_GH_PAT` is unset. Send a Telegram alert and exit.
