---
name: hylo-weekly-trends
description: Runs weekly (Mon 06:00 UTC). Computes 7-day rollups — success rate, top failure modes, latency drift per tool, and self-improvement loop stats (issues filed/fixed/verified this week). Posts a Telegram trend report.
---

# Hylo Weekly Trends

Strategic snapshot, not action-driving. The digest tells you what's broken today; this tells you whether the system is trending better or worse week-over-week.

## Inputs

- `HYLO_SUPABASE_SERVICE_ROLE`
- `/workspace/group/memory/delta-log.md` (event history)
- `/workspace/group/memory/known-issues.jsonl` + `closed-fixed.jsonl`

## Step 1 — Pull 7d of invocations

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
mkdir -p "$DIR"; cd "$DIR"

SINCE=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
PRIOR_SINCE=$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-14d +%Y-%m-%dT%H:%M:%SZ)

curl -sS --fail \
  "https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/mcp_tool_invocations?ts=gte.$SINCE&select=tool_name,status,error,duration_ms,client_id,ts" \
  -H "apikey: $HYLO_SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $HYLO_SUPABASE_SERVICE_ROLE" > week.json

curl -sS --fail \
  "https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/mcp_tool_invocations?ts=gte.$PRIOR_SINCE&ts=lt.$SINCE&select=tool_name,status,duration_ms" \
  -H "apikey: $HYLO_SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $HYLO_SUPABASE_SERVICE_ROLE" > prior_week.json
```

## Step 2 — Compute the metrics

```bash
python3 <<'PY'
import json, statistics
from collections import defaultdict

week = json.load(open("week.json"))
prior = json.load(open("prior_week.json"))

def percentile(xs, p):
    if not xs: return 0
    xs = sorted(xs)
    k = int(round((p/100) * (len(xs)-1)))
    return xs[k]

def stats(rows):
    out = {
        "total": len(rows),
        "ok": sum(1 for r in rows if r["status"]=="ok"),
        "err": sum(1 for r in rows if r["status"]!="ok"),
        "by_tool": defaultdict(lambda: {"total":0,"err":0,"p50":0,"p95":0,"latencies":[]}),
    }
    for r in rows:
        t = r["tool_name"]
        out["by_tool"][t]["total"] += 1
        if r["status"] != "ok": out["by_tool"][t]["err"] += 1
        if r.get("duration_ms") is not None: out["by_tool"][t]["latencies"].append(r["duration_ms"])
    for t, s in out["by_tool"].items():
        s["p50"] = percentile(s["latencies"], 50)
        s["p95"] = percentile(s["latencies"], 95)
        del s["latencies"]
    return out

w = stats(week)
p = stats(prior)

w_err_rate = (w["err"]/w["total"]*100) if w["total"] else 0
p_err_rate = (p["err"]/p["total"]*100) if p["total"] else 0
err_delta = w_err_rate - p_err_rate

# Top failure clusters
clusters = defaultdict(int)
for r in week:
    if r["status"] == "ok": continue
    import re
    err = r.get("error") or "unknown"
    m = re.search(r"\b([0-9]{3})\b", err)
    cls = m.group(1) if m else (err.split()[0] if err else "unknown")[:20]
    slug = re.sub(r"[^a-z0-9]+", "_", err.lower()[:80]).strip("_")[:40]
    clusters[f"{r['tool_name']}:{cls}:{slug}"] += 1
top_clusters = sorted(clusters.items(), key=lambda x: -x[1])[:5]

# Per-tool latency drift
drift = []
for tool, ws in w["by_tool"].items():
    ps = p["by_tool"].get(tool, {})
    p95_then = ps.get("p95", 0) or 0
    p95_now = ws["p95"]
    if p95_then > 0:
        delta_pct = ((p95_now - p95_then) / p95_then) * 100
        if abs(delta_pct) >= 25:  # only flag ≥25% changes
            drift.append((tool, p95_then, p95_now, delta_pct))
drift.sort(key=lambda x: -abs(x[3]))

with open("weekly.json","w") as f:
    json.dump({
        "this_week": {"total": w["total"], "err": w["err"], "err_rate": round(w_err_rate,1)},
        "prior_week": {"total": p["total"], "err": p["err"], "err_rate": round(p_err_rate,1)},
        "err_delta_pp": round(err_delta, 1),
        "top_clusters": top_clusters,
        "latency_drift": drift,
    }, f, indent=2)
print("weekly.json written")
PY
```

## Step 3 — Read loop-stats from delta-log (this week)

```bash
THIS_WEEK_START=$(date -u -d '7 days ago' +%F 2>/dev/null || date -u -v-7d +%F)
ISSUES_FILED=$(awk -F'\t' -v s="$THIS_WEEK_START" '$1 >= s && $2 == "issue_filed"' /workspace/group/memory/delta-log.md | wc -l)
PRS_DRAFTED=$(awk -F'\t' -v s="$THIS_WEEK_START" '$1 >= s && $2 == "pr_drafted"' /workspace/group/memory/delta-log.md | wc -l)
VERIFIED=$(awk -F'\t' -v s="$THIS_WEEK_START" '$1 >= s && $2 == "verified"' /workspace/group/memory/delta-log.md | wc -l)
REGRESSIONS=$(awk -F'\t' -v s="$THIS_WEEK_START" '$1 >= s && $2 == "regression"' /workspace/group/memory/delta-log.md | wc -l)
# Last-appended row per issue wins (append-only log); not max_by(.first_seen).
OPEN_NOW=$(jq -s 'reduce .[] as $r ({}; .[$r.issue_number|tostring] = $r) | [.[]] | map(select(.status == "open" or .status == "pr_drafted")) | length' /workspace/group/memory/known-issues.jsonl 2>/dev/null || echo 0)
```

## Step 4 — Format + send

Telegram message format (use real emoji, keep under 4000 chars):

```
📊 Hylo MCP — Weekly Trends (week ending YYYY-MM-DD UTC)

7d traffic
  Total: <total>  · OK: <ok>  · Errors: <err> (<err_rate>%)
  Prior 7d: <p_total> calls, <p_err_rate>% err
  Delta: <err_delta_pp> pp  <arrow>

🔥 Top failure clusters this week
  1. <signature>  <count>x
  2. ...

⏱ Latency drift (p95, ≥25% change vs prior week)
  - <tool>: <p95_then>ms → <p95_now>ms  (<delta>%)
  (or: "No significant drift" if empty)

🔁 Self-improvement loop
  Issues filed: <ISSUES_FILED>
  PRs drafted:  <PRS_DRAFTED>
  Verified-fixed: <VERIFIED>
  Regressions:  <REGRESSIONS>
  Currently open: <OPEN_NOW>

(For dashboards/raw data: query mcp_tool_invocations directly with the service_role key.)
```

For the err delta arrow:
- `err_delta_pp < -1`: ⬇ green ("improving")
- `err_delta_pp > 1`: ⬆ red ("worsening")
- `else`: → flat

Send:

Use the `mcp__nanoclaw__send_message` MCP tool with `jid: "tg:-5292785894"` and `text: "$REPORT"`. (`bridge-call` is the GHL API wrapper, not a messaging tool.)

## Step 5 — Append summary to delta-log

```bash
echo "$(date -u +%F)	weekly	<TOTAL> calls / <ERR_RATE>% err / <ISSUES_FILED> filed / <VERIFIED> verified / <REGRESSIONS> regr" >> /workspace/group/memory/delta-log.md
```

## Don't

- Don't include args or response bodies. Numbers and signatures only.
- Don't post if the week had zero invocations — send a one-liner: `📊 Hylo MCP weekly: no traffic this week.`
- Don't try to "explain" trends. Report numbers; the human reading does the interpretation.
- Don't flag latency drift below 25% — too noisy.
