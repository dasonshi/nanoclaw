---
name: hylo-model-drift
description: Runs daily (06:15 UTC). Diffs Hylo's declared model IDs and base token rates against Anthropic's live models API and published pricing page. Flags dead model IDs, stale rates that silently change the margin, retired models, and newly available ones. Telegram alert + GitHub issue on drift.
---

# Hylo Model & Pricing Drift

Hylo hardcodes three Anthropic model IDs and their base token rates in
`api/core/pricing.py`, and calls them via `PROVIDER_MODELS` in
`api/services/agent.py`. Both files are static; Anthropic's catalogue is not.
Nothing else in the system notices when they diverge.

**Why this skill exists.** On 2026-08-10 a manual check found two bugs that had
been live for months, neither of which produced an error anyone saw:

- `POWER` pointed at `claude-opus-4-5-20250129` — a model id that does not
  exist (the real Opus 4.5 is `-20251101`). Every Power request 404'd at
  Anthropic. Prod showed **zero** successful Opus calls, ever. A broken tier
  reads exactly like an unpopular tier.
- `FAST` carried `$0.80/$4` — retired Haiku **3.5** rates — while serving Haiku
  4.5 at `$1/$5`. Customer price is base × `MARKUP_MULTIPLIER` (2.0), so the
  intended 2× margin was actually **1.6×** on ~100% of traffic.

Both are silent by construction: a wrong rate still bills, and a dead tier just
looks unused. `tests/test_model_pricing.py` in the hylo repo pins the values
that are correct *today*; only this skill can see Anthropic change them
tomorrow.

## Inputs

- `HYLO_GH_PAT` — read `api/core/pricing.py` + `api/services/agent.py` from
  `dasonshi/hylo`, and file the issue.
- `ANTHROPIC_API_KEY` — **optional**. If present, model-id validity is checked
  against the live models API (authoritative). If absent, the skill degrades to
  the published pricing page alone and says so in its report rather than
  silently skipping the check. Requires an allowlist entry for this group; see
  the group `CLAUDE.md`.

## Step 1 — Fetch the upstream truth

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
mkdir -p "$DIR"; cd "$DIR"

# Published pricing page (public, no auth).
# NOTE the `.md` suffix — it serves the markdown source. The bare URL returns
# rendered HTML, in which the pricing *table* does not survive as pipe-delimited
# rows, so the Step 3 parser matches nothing and every tier reports
# `rate_unparsed`. Caught in a dry run; the skill would otherwise have cried
# wolf daily until someone muted it.
curl -sS --fail -L https://platform.claude.com/en/docs/about-claude/pricing.md \
  -o pricing_page.md || echo "PRICING_FETCH_FAILED" > pricing_fetch.err

# Live model catalogue (authoritative for "does this id exist").
if [ -n "$ANTHROPIC_API_KEY" ]; then
  curl -sS --fail https://api.anthropic.com/v1/models \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" > models.json \
    || echo "MODELS_FETCH_FAILED" > models.err
fi
```

## Step 2 — Fetch what Hylo currently declares

```bash
for f in api/core/pricing.py api/services/agent.py; do
  curl -sS --fail -H "Authorization: Bearer $HYLO_GH_PAT" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/dasonshi/hylo/contents/$f?ref=main" \
    -o "$(basename $f)"
done
```

## Step 3 — Diff

Parse `pricing.py` with `ast` — **do not regex it**. The docstring deliberately
names the old dead model id while explaining the incident, and a regex will
match that and report a phantom finding every single day until someone mutes
the skill.

```bash
python3 <<'PY'
import ast, json, os, pathlib, re

src = pathlib.Path("pricing.py").read_text()
tree = ast.parse(src)

# Pull ModelConfig(...) kwargs out of the MODEL_CONFIGS dict literal.
declared = {}
for node in ast.walk(tree):
    if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "ModelConfig"):
        continue
    kw = {k.arg: k.value for k in node.keywords}
    def const(name):
        v = kw.get(name)
        return v.value if isinstance(v, ast.Constant) else None
    tier = getattr(kw.get("tier"), "attr", "?")
    declared[tier] = {
        "model_id": const("model_id"),
        "input": const("input_price_per_1m"),
        "output": const("output_price_per_1m"),
    }

markup = next(
    (n.value.value for n in tree.body
     if isinstance(n, ast.Assign)
     and getattr(n.targets[0], "id", "") == "MARKUP_MULTIPLIER"),
    None,
)

findings = []

# --- 3a. Model id validity (only when the models API was reachable) ---
if os.path.exists("models.json"):
    live = {m["id"] for m in json.load(open("models.json"))["data"]}
    for tier, d in declared.items():
        if d["model_id"] not in live:
            findings.append({
                "severity": "critical",
                "tier": tier,
                "kind": "dead_model_id",
                "detail": f'{d["model_id"]} is not in the live model list — '
                          f'every {tier} request 404s',
            })
    known = {d["model_id"] for d in declared.values()}
    findings.append({
        "severity": "info", "kind": "catalogue",
        "detail": f"live models: {sorted(live)}; hylo uses: {sorted(known)}",
    })
else:
    findings.append({
        "severity": "warn", "kind": "check_skipped",
        "detail": "ANTHROPIC_API_KEY absent or models API unreachable — model-id "
                  "validity NOT verified this run",
    })

# --- 3b. Base rates vs published pricing ---
page = pathlib.Path("pricing_page.md").read_text(errors="ignore") if \
    os.path.exists("pricing_page.md") else ""
if page:
    # Rows look like: | Claude Haiku 4.5 | $1 / MTok | ... | $5 / MTok |
    def published(display_name):
        row = re.search(rf"\|\s*{re.escape(display_name)}\s*(?:\[[^\]]*\]\([^)]*\))?\s*\|(.+)", page)
        if not row:
            return None
        money = re.findall(r"\$([0-9.]+)\s*/\s*MTok", row.group(1))
        # columns: base input, 5m write, 1h write, cache hit, output
        return (float(money[0]), float(money[-1])) if len(money) >= 5 else None

    NAME_FOR_ID = {
        "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
        "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
        "claude-opus-5": "Claude Opus 5",
        "claude-opus-4-8": "Claude Opus 4.8",
        "claude-sonnet-5": "Claude Sonnet 5",
    }
    for tier, d in declared.items():
        name = NAME_FOR_ID.get(d["model_id"])
        if not name:
            findings.append({
                "severity": "warn", "tier": tier, "kind": "unmapped_model",
                "detail": f'{d["model_id"]} has no display-name mapping — add one '
                          f'to NAME_FOR_ID so its rate can be checked',
            })
            continue
        pub = published(name)
        if not pub:
            findings.append({
                "severity": "warn", "tier": tier, "kind": "rate_unparsed",
                "detail": f"could not read published rate for {name} — page layout "
                          f"may have changed; re-check the parser",
            })
            continue
        if (d["input"], d["output"]) != pub:
            eff = (pub[0] / d["input"]) if d["input"] else 0
            findings.append({
                "severity": "critical", "tier": tier, "kind": "stale_rate",
                "detail": (f'{name}: hylo bills base ${d["input"]}/${d["output"]}, '
                           f'Anthropic charges ${pub[0]}/${pub[1]}. '
                           f'Real margin is {markup / eff:.2f}x, not {markup}x.')
                          if eff else
                          (f'{name}: hylo ${d["input"]}/${d["output"]} vs published '
                           f'${pub[0]}/${pub[1]}'),
            })
else:
    findings.append({
        "severity": "warn", "kind": "check_skipped",
        "detail": "pricing page unreachable — rates NOT verified this run",
    })

# --- 3c. agent.py must call what pricing.py bills ---
agent_src = pathlib.Path("agent.py").read_text()
for tier, d in declared.items():
    if d["model_id"] and f'anthropic/{d["model_id"]}' not in agent_src:
        findings.append({
            "severity": "critical", "tier": tier, "kind": "call_bill_mismatch",
            "detail": f'pricing.py bills {d["model_id"]} but agent.py does not '
                      f'call it — we bill for one model and call another',
        })

json.dump(findings, open("drift.json", "w"), indent=2)
crit = [f for f in findings if f["severity"] == "critical"]
warn = [f for f in findings if f["severity"] == "warn"]
print(f"critical={len(crit)} warn={len(warn)}")
PY
```

**A skipped check is a finding, not a pass.** If either fetch fails the skill
reports `check_skipped` at `warn` and says so in Telegram. Silence must mean
"verified clean", never "couldn't look" — that distinction is the whole point
of the skill.

## Step 4 — Report

```bash
CRIT=$(jq '[.[] | select(.severity=="critical")] | length' drift.json)
WARN=$(jq '[.[] | select(.severity=="warn")] | length' drift.json)
```

- **`CRIT > 0`** — Telegram alert to `tg:-5292785894`, and open a GitHub issue
  on `dasonshi/hylo` titled `model drift: <kind> on <tier>`, body = the finding
  detail plus the exact file/line to change. Check
  `/workspace/group/memory/known-issues.jsonl` first and skip if an open issue
  already carries the same `signature` (`kind:tier:model_id`) — this runs daily
  and must not file the same issue twice.
- **`WARN > 0`, no criticals** — one Telegram line. No issue.
- **Clean** — no Telegram message. Append one line to
  `/workspace/group/memory/delta-log.md` so a silent day is still auditable:
  `YYYY-MM-DD model-drift: clean (3 tiers verified against live catalogue + published pricing)`.

## Hard rules

1. **Never edit `pricing.py` or `agent.py`.** Money and model selection are
   David's call — a wrong rate written autonomously bills real customers
   wrongly, and picking a model is a product decision with a cost consequence.
   File an issue with the exact proposed diff; never draft the PR. This is a
   deliberate exception to the group's general "draft a PR with a regression
   test" pattern.
2. **Never auto-upgrade to a newly released model.** Report it as `info`. A
   newer model can be cheaper *and* change output quality and latency; that
   trade is not this skill's to make.
3. **A dead model id is always `critical`,** even on a tier with no traffic —
   zero traffic is the *symptom*, not evidence it doesn't matter.
4. **Rates are checked against the published page, not memory.** Model prices
   in an LLM's training data go stale silently; that is exactly the failure
   this skill exists to catch, so never "confirm" a rate from recall.
