---
name: hylo-pr-drafts
description: Runs once daily (06:30 UTC). For each open auto-filed GitHub issue in dasonshi/hylo with a well-understood failure signature, clones the repo fresh, writes a failing pytest that reproduces the bug, implements the minimal fix, runs the test, and opens a DRAFT PR for David's review. Never auto-merges. At most 1 PR per run to keep noise bounded.
---

# Hylo PR Drafts

You attempt to fix issues that yesterday's `hylo-daily-digest` filed. Every PR is a DRAFT — David is the only merger. Skip rather than push broken work.

## Hard rules (from group CLAUDE.md, restated)

1. **Open as DRAFT.** Never set `--ready`. David reviews and marks ready himself.
2. **Regression test required.** No test → no PR. File a comment on the issue explaining why you couldn't reproduce, instead.
3. **Tests must pass locally before opening the PR.** Run pytest in the fresh clone. If anything fails, comment + skip.
4. **Never touch `always_human` paths.** See `/workspace/group/auto-approve.json` for the list (`supabase/migrations/`, `pyproject.toml`, `api/core/config.py`, etc.). If a fix would require those, comment on the issue describing what you'd change, then skip.
5. **At most one PR per run.** Try open issues in priority order (highest occurrences first); the first one that yields a clean, tested fix gets the single draft PR, then stop. If the top issue is unsuitable, move down the list (cap: 3 attempts) — don't let one un-fixable issue starve a fixable one.

## Inputs you have

- `HYLO_GH_PAT` env — `gh` CLI: `export GH_TOKEN="$HYLO_GH_PAT"`
- `HYLO_SUPABASE_SERVICE_ROLE` env — query Supabase for full call samples
- `/workspace/group/memory/known-issues.jsonl` — pick a target from here
- `/workspace/scratch/` — clone destination (writable, ephemeral)

## Step 1 — Pick today's target

```bash
export GH_TOKEN="$HYLO_GH_PAT"

# jq is required by this skill. If it's missing, FAIL LOUDLY — do NOT silently
# treat a tooling failure as "no work" (that masks real open issues).
command -v jq >/dev/null || { echo "FATAL: jq not installed in the agent container"; exit 1; }

KI=/workspace/group/memory/known-issues.jsonl
if [ ! -s "$KI" ]; then
  echo "No known-issues.jsonl yet — nothing filed to draft against."
  echo "$(date -u +%F)	pr_drafts	skip: no known-issues file" >> /workspace/group/memory/delta-log.md
  exit 0
fi

# Latest row per issue_number, OPEN only, highest occurrences first.
# NOTE: no `2>/dev/null` — a jq error must surface, not become a false skip.
# This is an ORDERED CANDIDATE LIST, not a single pick.
# Dedup by APPEND ORDER (last row per issue_number wins) — known-issues.jsonl is
# an append-only log, so the most recently appended row is the current state.
# Do NOT use max_by(.first_seen): rows are written with inconsistent first_seen
# (status updates may omit it), so that picks stale rows over newer ones.
CANDIDATES=$(jq -s 'reduce .[] as $r ({}; .[$r.issue_number|tostring] = $r) | [.[]] | map(select(.status == "open")) | sort_by(-.occurrences)' "$KI")
N=$(echo "$CANDIDATES" | jq 'length')

if [ "$N" -eq 0 ]; then
  echo "No OPEN issues in known-issues.jsonl — nothing to draft today."
  echo "$(date -u +%F)	pr_drafts	skip: no open issues" >> /workspace/group/memory/delta-log.md
  exit 0
fi

echo "$N open issue(s) to consider, in priority order:"
echo "$CANDIDATES" | jq -r '.[] | "  #\(.issue_number) \(.signature) (\(.occurrences)x)"'
```

**Iterate over candidates — don't give up after the first.** Walk the list in
priority order (index `I` from 0). For each candidate, run Steps 2–7. The FIRST
candidate for which you can (a) pull a matching Supabase sample, (b) articulate a
specific code fix, (c) write a regression test that fails on `main` and passes
after the fix, and (d) push with no new failures gets the **single** draft PR for
this run — then STOP. If a candidate is unsuitable at ANY step (no matching
sample, signature too broad/mixed to reproduce reliably, fix would require an
`always_human` path, tests don't cooperate), comment briefly on THAT issue and
**move to the next candidate** (increment `I`). Only after exhausting all
candidates (cap: attempt at most **3** per run) without a clean PR do you finish
with no PR. This prevents an un-fixable top issue (e.g. a broad `422` catch-all)
from permanently starving a genuinely fixable lower one (e.g. a `locationId`
injection bug).

Set the current candidate's vars from index `I` (start `I=0`):

```bash
I=0   # advance to 1, 2, … when moving to the next candidate
TARGET=$(echo "$CANDIDATES" | jq ".[$I]")
ISSUE_NUM=$(echo "$TARGET" | jq -r .issue_number)
SIGNATURE=$(echo "$TARGET" | jq -r .signature)
TOOL_NAME=$(echo "$SIGNATURE" | cut -d: -f1)
ERROR_CLASS=$(echo "$SIGNATURE" | cut -d: -f2)
ERROR_SLUG=$(echo "$SIGNATURE" | cut -d: -f3-)
echo "Attempting candidate #$ISSUE_NUM: $SIGNATURE"
```

## Step 1c — Skip candidates that already have an open PR (duplicate guard)

Before doing ANY work on a candidate, check GitHub for an existing open
`auto-fix/issue-<N>-*` PR. The branch name encodes the issue number, so this is
the authoritative dedup — it holds even if `known-issues.jsonl` status is stale.
This prevents drafting a second PR for an issue that's already in review.

```bash
EXISTING_PR=$(gh pr list --repo dasonshi/hylo --state open --json number,headRefName \
  --jq "[.[] | select(.headRefName | startswith(\"auto-fix/issue-${ISSUE_NUM}-\"))] | .[0].number")

if [ -n "$EXISTING_PR" ] && [ "$EXISTING_PR" != "null" ]; then
  echo "Issue #$ISSUE_NUM already has open PR #$EXISTING_PR — skipping to next candidate."
  # Record pr_drafted so the append-order dedup keeps this out of future runs.
  NOW=$(date -u +%FT%TZ)
  echo "{\"issue_number\": $ISSUE_NUM, \"signature\": \"$SIGNATURE\", \"status\": \"pr_drafted\", \"pr_number\": $EXISTING_PR, \"last_seen\": \"$NOW\"}" >> /workspace/group/memory/known-issues.jsonl
  printf "%s\tpr_drafts\tskip: issue #%s already has open PR #%s\n" "$(date -u +%F)" "$ISSUE_NUM" "$EXISTING_PR" >> /workspace/group/memory/delta-log.md
  # MOVE TO THE NEXT CANDIDATE (increment I, re-run Step 1's candidate-vars block).
  # Only finish the run if this was the last candidate / 3-attempt cap reached.
fi
```

## Step 2 — Fetch the issue body + a fresh failing call sample

```bash
gh issue view $ISSUE_NUM --repo dasonshi/hylo --json title,body,labels > /workspace/scratch/issue.json

# Get one fresh sample of the failing call from Supabase (the issue body has samples too, but pull a current one)
SINCE=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
curl -sS --fail \
  "https://rlmkrymrxmsncumhfxeh.supabase.co/rest/v1/mcp_tool_invocations?tool_name=eq.$TOOL_NAME&status=neq.ok&ts=gte.$SINCE&select=args,error,intent&order=ts.desc&limit=5" \
  -H "apikey: $HYLO_SUPABASE_SERVICE_ROLE" \
  -H "Authorization: Bearer $HYLO_SUPABASE_SERVICE_ROLE" > /workspace/scratch/samples.json

# Verify samples include calls matching our signature
MATCHING=$(jq --arg slug "$ERROR_SLUG" --arg cls "$ERROR_CLASS" '[.[] | select((.error // "" | ascii_downcase | gsub("[^a-z0-9]+"; "_")[0:40]) | contains($slug[0:20]))] | .[0]' /workspace/scratch/samples.json)

if [ -z "$MATCHING" ] || [ "$MATCHING" = "null" ]; then
  echo "No recent matching sample for #$ISSUE_NUM — pattern may have been transient."
  gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "hylo-pr-drafts: no matching failures in the last 7d. Signature may be transient; moving on."
  # NEXT CANDIDATE: increment I and restart from Step 1's candidate-vars block.
  # Only finish the run if this was the last candidate (or you've hit the cap of 3).
fi
```

## Step 3 — Clone fresh

```bash
WORK=/workspace/scratch/hylo-$(date +%s)
mkdir -p $WORK
cd $WORK
# Clone with the token embedded in the remote URL so `git push` authenticates
# non-interactively. Do NOT use `gh repo clone` here — it sets a tokenless
# remote, and in a headless container `git push` then dies with
# "could not read Username for 'https://github.com': No such device or address".
git clone --depth 50 "https://x-access-token:${HYLO_GH_PAT}@github.com/dasonshi/hylo" .
git config user.email "hylo-monitor@nanoclaw.local"
git config user.name "Hylo Monitor"
# Belt-and-suspenders: also register gh as a git credential helper.
gh auth setup-git 2>/dev/null || true

BRANCH="auto-fix/issue-${ISSUE_NUM}-$(date +%Y%m%d)"
git checkout -b "$BRANCH"
```

## Step 3b — Set up the Python environment

The repo uses `pyproject.toml` + `requirements.txt` (no `uv.lock`). Create an
isolated venv in the clone and install deps + pytest. **All `pytest` calls in
later steps use `$WORK/.venv/bin/pytest`** — do NOT rely on a global `pytest`,
there isn't one.

```bash
python3 -m venv "$WORK/.venv"
"$WORK/.venv/bin/pip" install --quiet --upgrade pip
# Runtime deps
[ -f requirements.txt ]     && "$WORK/.venv/bin/pip" install --quiet -r requirements.txt
# Dev/test deps if the repo splits them out
[ -f requirements-dev.txt ] && "$WORK/.venv/bin/pip" install --quiet -r requirements-dev.txt
# The package itself (so `import api...` resolves)
"$WORK/.venv/bin/pip" install --quiet -e . 2>/dev/null || true
# Test runner + plugins. The repo does NOT declare its test deps (no extras, no
# requirements-dev.txt), but pyproject sets `asyncio_mode = "auto"`, so
# pytest-asyncio is required or conftest.py fails to import.
"$WORK/.venv/bin/pip" install --quiet pytest pytest-asyncio

PYTEST="$WORK/.venv/bin/pytest"
```

If a later `pytest` run dies in `conftest.py` with `ModuleNotFoundError: No
module named 'X'` (an undeclared test plugin), `pip install` that module into
the venv and retry once — don't give up on the first missing plugin:

```bash
# e.g. ModuleNotFoundError: No module named 'respx'
"$WORK/.venv/bin/pip" install --quiet respx && "$PYTEST" --collect-only -q
```

If `pip install` fails (e.g. a dep needs a system library not in the container),
**don't push a half-built environment** — comment on the issue with the install
error and skip:

```bash
gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "hylo-pr-drafts: couldn't install the repo's deps in the agent container (see error below). A maintainer may need to add a system package to container/Dockerfile.

\`\`\`
<tail of the pip error>
\`\`\`"
exit 0
```

## Step 4 — Reason about the fix

Open `api/routes/mcp_remote.py` and the tool handler files. For each of the 8 active tools, the implementation traces are findable via `grep -n 'def $TOOL_NAME' api/`. Read:

- The tool's handler function
- The Hylo API client call it makes (`api/services/...`)
- Any input validation
- The exact error path that returned the failing status

For the failure signature, ask yourself:
- **422 / 400**: Are we sending the wrong shape? Is a field being mis-injected (the `locationId` bug pattern)? Read the GHL endpoint contract from `api/routes/knowledge.py` or schemas dir.
- **404**: Wrong endpoint slug, mis-resolved connection, removed GHL endpoint?
- **500 / timeout**: Upstream issue or our error handling masking it?
- **Empty results (status=ok but useless)**: Schema search returning nothing — is the query getting normalized away?

If you cannot articulate a specific code change in `api/` that would make the failure stop, you don't understand the bug well enough yet. **Skip and comment on the issue:**

```bash
gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "hylo-pr-drafts: I read the code but can't isolate the cause from the failure signature alone (signature too broad/mixed for a safe single-cause fix). Leaving for human review and moving to the next candidate."
```

Then **move to the next candidate** (increment `I`, re-run Step 1's candidate-vars
block, continue from Step 2). Only finish with no PR once candidates are exhausted
or the 3-attempt cap is hit.

## Step 5 — Write the regression test FIRST

Test path: `tests/test_auto_<issue-num>_<short-slug>.py` (e.g. `tests/test_auto_123_locationid_injection.py`).

Use the existing test patterns in `tests/` as templates. The test must:

- Call the affected tool through the FastMCP test client (search for `from mcp.client.testing import` or similar in existing tests)
- Pass args that reproduce the failure based on `samples.json`
- Assert the response is what you'd expect AFTER the fix (not the current failing behavior)

Then run it and confirm it FAILS on main:

```bash
"$PYTEST" "tests/test_auto_${ISSUE_NUM}_*.py" -v 2>&1 | tee /workspace/scratch/test-before-fix.log
```

If the test PASSES on main — you wrote the wrong test (it's not exercising the failure). Reconsider, rewrite, and re-run. Don't proceed until the test reliably fails.

**Then capture a full-suite baseline on `main`** (BEFORE your fix). The hylo
suite is NOT green in a bare clone — a few test modules error at collection
(`FileNotFoundError`, missing fixtures, external-resource tests). That's
expected and unrelated to your change. Record the set of failing/erroring node
IDs so Step 6 can tell *pre-existing* failures apart from ones your fix
introduces:

```bash
git stash -u 2>/dev/null  # ensure we're measuring clean main (keep your new test stashed too)
"$PYTEST" api/ tests/ --continue-on-collection-errors -q 2>&1 | tee /workspace/scratch/baseline-full.log
grep -E '^(FAILED|ERROR)' /workspace/scratch/baseline-full.log | sed -E 's/ .*//' | sort -u > /workspace/scratch/baseline-fails.txt
git stash pop 2>/dev/null  # restore your new test
echo "baseline failing nodes: $(wc -l < /workspace/scratch/baseline-fails.txt)"
```

## Step 6 — Implement the minimal fix

Edit ONLY the files needed. Touch fewer lines, not more. Preserve existing patterns. If a one-line guard fixes it, that's the right shape. If you find yourself rewriting whole functions, you're over-scoping — back off and propose the change in an issue comment instead.

After editing, run the targeted test + the full suite:

```bash
"$PYTEST" "tests/test_auto_${ISSUE_NUM}_*.py" -v 2>&1 | tee /workspace/scratch/test-after-fix.log
# Must PASS now ↑

# Full suite, compared against the main baseline from Step 5 — your fix must not
# INTRODUCE any new failure. Pre-existing baseline failures are tolerated.
"$PYTEST" api/ tests/ --continue-on-collection-errors -q 2>&1 | tee /workspace/scratch/test-full.log
grep -E '^(FAILED|ERROR)' /workspace/scratch/test-full.log | sed -E 's/ .*//' | sort -u > /workspace/scratch/after-fails.txt
# New failures = in after-fails.txt but NOT in baseline-fails.txt
NEW_FAILS=$(comm -13 /workspace/scratch/baseline-fails.txt /workspace/scratch/after-fails.txt)
echo "NEW failures introduced by this fix:"; echo "${NEW_FAILS:-(none)}"
```

If the targeted test still fails OR `NEW_FAILS` is non-empty (your change broke
something that passed on main), **do NOT open a PR**. Comment on the issue with
the logs and exit:

```bash
gh issue comment $ISSUE_NUM --repo dasonshi/hylo --body "hylo-pr-drafts attempted a fix but tests failed. See logs.

\`\`\`
$(tail -30 /workspace/scratch/test-after-fix.log)
\`\`\`
Moving to the next candidate."
```

Then **move to the next candidate** (increment `I`, fresh clone, continue) unless
candidates are exhausted or the 3-attempt cap is hit.

## Step 7 — Open the DRAFT PR

```bash
git add -A
git commit -m "fix: address auto-filed issue #${ISSUE_NUM} (${TOOL_NAME} ${ERROR_CLASS})"
git push -u origin "$BRANCH"

PR_NUM=$(gh pr create \
  --repo dasonshi/hylo \
  --base main \
  --head "$BRANCH" \
  --draft \
  --title "[auto-draft] fix: #${ISSUE_NUM} ${TOOL_NAME} ${ERROR_CLASS} ${ERROR_SLUG}" \
  --body "Closes #${ISSUE_NUM}

**Auto-drafted by hylo_monitor.** This PR is in DRAFT — review the diff, the test, and the fix before marking ready and merging.

## What this fixes
Signature: \`${SIGNATURE}\`
The issue body has 24h occurrence data and sample errors.

## What I did
1. Reproduced the failure in \`tests/test_auto_${ISSUE_NUM}_*.py\` — confirmed it fails on \`main\`
2. Made the minimal change in \`api/...\` to address the root cause
3. Confirmed the new test passes + the full test suite still passes

## Risk
<one paragraph: what could go wrong with this change, what assumptions you made, what you'd verify in staging>

## Post-deploy verification
After merge, \`hylo-post-deploy-verify\` will replay the original failing call against the live /mcp endpoint within 30 min and comment back here with the result." \
  --label "auto-draft,hylo-monitor" | grep -oE '[0-9]+$')

echo "Opened draft PR #$PR_NUM"
```

## Step 8 — Update memory

```bash
# Append updated row to known-issues.jsonl (status pr_drafted)
NOW=$(date -u +%FT%TZ)
echo "{\"issue_number\": $ISSUE_NUM, \"signature\": \"$SIGNATURE\", \"status\": \"pr_drafted\", \"pr_number\": $PR_NUM, \"last_seen\": \"$NOW\"}" >> /workspace/group/memory/known-issues.jsonl

# Append to delta-log
echo "$(date -u +%F)	pr_drafted	PR #$PR_NUM → issue #$ISSUE_NUM ($SIGNATURE)" >> /workspace/group/memory/delta-log.md
```

## Step 9 — Telegram FYI

Short message to Hylo Monitor group:

```
🛠 Drafted PR #<PR_NUM> for issue #<ISSUE_NUM>
   <tool_name> · <error_class> <slug>
   Tests pass locally. Review: https://github.com/dasonshi/hylo/pull/<PR_NUM>
```

Send via the `mcp__nanoclaw__send_message` MCP tool with `jid: "tg:-5292785894"`. (Note: `/usr/local/bin/bridge-call` is the **GHL API** wrapper, not a messaging tool — don't use it to post to Telegram.)

## Don't

- Don't open a non-draft PR. Ever. The flag is `--draft`.
- Don't push without running the full test suite.
- Don't touch files in `always_human` list (see auto-approve.json).
- Don't open more than 1 PR per run.
- Don't try to fix issues where you can't write a reproducing test. Comment and skip.
- Don't include `Co-authored-by` lines in the commit message.
- Don't `git push --force`. If your branch already exists from a prior failed run, delete it locally and start over with a fresh branch name (date-suffixed).
