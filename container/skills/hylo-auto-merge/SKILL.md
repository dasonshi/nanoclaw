---
name: hylo-auto-merge
description: Runs once daily (07:00 UTC, after hylo-pr-drafts). For each open auto-draft PR in dasonshi/hylo, applies strict mechanical gates (green CI, clean-mergeable, safe paths only, not large/deletion-heavy, auto-draft label), then does an independent review pass AND an adversarial self-audit pass. Merges ONLY when every gate and both passes agree. Anything else is left open and escalated to David via Telegram. Ships DISABLED (report-only) — set pr_to_merge.enabled=true in auto-approve.json to arm live merges.
---

# Hylo Auto-Merge

You close the loop that `hylo-pr-drafts` opens: merging the auto-drafted fix PRs that are genuinely safe, so David isn't the bottleneck — without ever shipping something risky to production unreviewed.

**`dasonshi/hylo` auto-deploys to Render on merge to `main`.** A merge is a production deploy. Treat every gate as load-bearing. When in doubt, DO NOT merge — leave it open and escalate. A held PR costs a day; a bad merge costs an incident.

## Arming (report-only vs live)

Read `/workspace/group/auto-approve.json` → `pr_to_merge`. If `enabled` is `false` (the default), run in **REPORT-ONLY** mode: do every gate + both review passes and post what you *would* have merged, but **never actually merge**. Only when `enabled` is `true` do you perform real merges. Everything else in this skill is identical between the two modes.

```bash
export GH_TOKEN="$HYLO_GH_PAT"
command -v jq >/dev/null || { echo "FATAL: jq missing in container"; exit 1; }
AP=/workspace/group/auto-approve.json
LIVE=$(jq -r '.pr_to_merge.enabled // false' "$AP")
echo "mode: $([ "$LIVE" = true ] && echo LIVE || echo REPORT-ONLY)"
MAX_MERGES=$(jq -r '.pr_to_merge.max_per_run // 2' "$AP")
MAX_TOTAL_LINES=$(jq -r '.pr_to_merge.max_total_lines // 200' "$AP")
MAX_DELETIONS=$(jq -r '.pr_to_merge.max_deletions // 40' "$AP")
```

## Step 1 — Enumerate candidate PRs

Only open PRs carrying the `auto-draft` label are in scope. **Never** touch a PR without that label (e.g. the weekly OpenAPI-refresh PRs, or any human PR).

```bash
gh pr list --repo dasonshi/hylo --state open --label auto-draft \
  --json number,title,headRefName,isDraft,labels \
  > /workspace/scratch/candidates.json
COUNT=$(jq length /workspace/scratch/candidates.json)
echo "$COUNT open auto-draft PR(s)"
[ "$COUNT" = 0 ] && {
  echo "$(date -u +%F)	auto_merge	no open auto-draft PRs" >> /workspace/group/memory/delta-log.md
  exit 0
}
```

Process PRs lowest-number-first. Track a running `MERGED=0` counter; stop merging once `MERGED == MAX_MERGES` (still *report* on the rest). For each PR, run Steps 2–5. Set:

```bash
PR=<number>   # from candidates.json
```

## Step 2 — Mechanical gates (cheap, no LLM). ANY failure → escalate + skip.

Gather the PR's state in one shot:

```bash
gh pr view "$PR" --repo dasonshi/hylo \
  --json number,mergeable,mergeStateStatus,isDraft,additions,deletions,changedFiles,files,labels,title,url \
  > /workspace/scratch/pr-$PR.json
```

Evaluate each gate. Record the FIRST failing gate as `$HOLD_REASON` and skip to Step 6 (escalate). Only if all pass do you proceed to Step 3.

1. **CI must be fully green.** Every check must have concluded `pass`/`success` — no pending, no failure, no absent required check. This needs the PAT's **Checks: Read** permission; if the call errors (403), treat it as NOT green and escalate with reason "cannot read CI status (PAT missing Checks:Read)".
   ```bash
   CHECKS=$(gh pr checks "$PR" --repo dasonshi/hylo 2>&1) || true
   # A 403/permission error, any 'fail'/'pending', or zero checks => not green.
   if echo "$CHECKS" | grep -qiE 'HTTP 403|not accessible|Resource not accessible'; then
     HOLD_REASON="cannot read CI status (PAT missing Checks:Read)"
   elif echo "$CHECKS" | grep -qiE '\b(fail|failure|error|pending|queued|in_progress|cancelled)\b'; then
     HOLD_REASON="CI not green"
   elif ! echo "$CHECKS" | grep -qiE '\b(pass|success)\b'; then
     HOLD_REASON="no CI checks reported (cannot confirm tested)"
   fi
   ```
2. **Clean-mergeable.** Require `mergeable == "MERGEABLE"` and `mergeStateStatus == "CLEAN"`. Any conflict/`DIRTY`/`BLOCKED`/`BEHIND`/`UNSTABLE` → hold.
   **GitHub computes mergeability asynchronously** — the FIRST read of a PR almost always returns `mergeable: "UNKNOWN"` and kicks off a background computation, and a read a second or two later returns the real value. So you MUST poll, not read once, or every PR falsely holds as "unknown":
   ```bash
   MERG=UNKNOWN; STATE=UNKNOWN
   for i in 1 2 3 4 5; do
     read -r MERG STATE < <(gh pr view "$PR" --repo dasonshi/hylo --json mergeable,mergeStateStatus -q '.mergeable+" "+.mergeStateStatus')
     [ "$MERG" != UNKNOWN ] && break
     sleep 3
   done
   if [ "$MERG" != MERGEABLE ] || [ "$STATE" != CLEAN ]; then
     HOLD_REASON="${HOLD_REASON:-not clean-mergeable ($MERG/$STATE)}"
   fi
   ```
   If it's still `UNKNOWN` after the retries, hold (`not clean-mergeable (UNKNOWN)`) — never merge on an undetermined state.
3. **Label present.** `auto-draft` must be in `.labels[].name`. (Enumerated with the label filter already, but re-check — belt and suspenders.)
4. **Safe paths only.** EVERY changed file must match `^(api/|tests/)` AND NONE may match an `always_human` path from `auto-approve.json`. In practice: only `api/**/*.py` (never `api/core/config.py`) and `tests/**/*.py`. Anything else (migrations, `pyproject.toml`, `package*.json`, `.env`, `Dockerfile`, `.github/`, workflows, `api/core/config.py`) → `HOLD_REASON="touches out-of-scope/always_human path: <file>"`.
   ```bash
   ALWAYS_HUMAN=$(jq -r '.always_human[]' "$AP")
   BADFILE=""
   for f in $(jq -r '.files[].path' /workspace/scratch/pr-$PR.json); do
     case "$f" in api/*|tests/*) : ;; *) BADFILE="$f (outside api/,tests/)"; break ;; esac
     for h in $ALWAYS_HUMAN; do case "$f" in *"$h"*) BADFILE="$f (always_human)"; break 2;; esac; done
   done
   [ -n "$BADFILE" ] && HOLD_REASON="${HOLD_REASON:-touches out-of-scope path: $BADFILE}"
   ```
5. **Not large or deletion-heavy** (your explicit gate). Escalate if `additions+deletions > MAX_TOTAL_LINES`, OR `deletions > MAX_DELETIONS`, OR any file has status `removed` (a deleted file).
   ```bash
   ADD=$(jq '.additions' /workspace/scratch/pr-$PR.json); DEL=$(jq '.deletions' /workspace/scratch/pr-$PR.json)
   REMOVED=$(gh pr view "$PR" --repo dasonshi/hylo --json files -q '[.files[]|select(.additions==0 and .deletions>0)]|length')
   if [ $((ADD+DEL)) -gt "$MAX_TOTAL_LINES" ]; then HOLD_REASON="${HOLD_REASON:-large diff ($((ADD+DEL)) lines > $MAX_TOTAL_LINES)}"; fi
   if [ "$DEL" -gt "$MAX_DELETIONS" ]; then HOLD_REASON="${HOLD_REASON:-deletion-heavy ($DEL deletions > $MAX_DELETIONS)}"; fi
   ```

If `$HOLD_REASON` is set, go to Step 6. Otherwise continue.

## Step 3 — Independent review pass (LLM)

Read the full diff and the issue it closes:

```bash
gh pr diff "$PR" --repo dasonshi/hylo > /workspace/scratch/pr-$PR.diff
gh pr view "$PR" --repo dasonshi/hylo --json body -q .body > /workspace/scratch/pr-$PR-body.md
```

Review the diff as if you were a senior engineer approving a teammate's PR. Judge, concretely:
- **Does the change actually address the linked issue's failure signature?** Trace the code path.
- **Is the regression test meaningful?** It must assert *post-fix* behavior and would fail on `main` (the PR body claims this — sanity-check it from the diff: the test exercises the real handler, not a tautology/mock-only assertion).
- **Correctness:** off-by-one, wrong field, changed behavior for inputs *other* than the failing one, error-handling that now swallows a real error.
- **Blast radius:** does the edited function serve other tools/paths that this could regress?

Write a 2–4 sentence verdict to `/workspace/scratch/pr-$PR-review.md` ending with `REVIEW: PASS` or `REVIEW: HOLD — <reason>`.

## Step 4 — Adversarial self-audit pass (LLM)

Now switch stance: **try to reject this PR.** Assume it's subtly wrong and look for the reason. This is a distinct pass from Step 3 — do not just restate it. Ask:
- What input would make this change misbehave in production that the test doesn't cover?
- Does it weaken any validation, auth, or input-sanitization?
- Could it mask/relabel an upstream error so real failures look "ok" (the exact anti-pattern the digest hunts)?
- Is the test green for the wrong reason (over-mocked, asserts the mock not the behavior)?
- Would a Hylo end-user notice a behavior change beyond the bug being fixed?

Default to rejection under uncertainty. Write to `/workspace/scratch/pr-$PR-audit.md` ending with `AUDIT: CLEAR` or `AUDIT: HOLD — <reason>`.

**Merge decision:** proceed to Step 5 (merge) ONLY if Step 2 all-passed AND `REVIEW: PASS` AND `AUDIT: CLEAR`. Any HOLD → set `$HOLD_REASON` from the failing pass and go to Step 6.

## Step 5 — Merge (LIVE mode only) or report (REPORT-ONLY)

If `LIVE` != `true`: **do not merge.** Record what would happen and continue to the next PR:
```bash
echo "$(date -u +%F)	auto_merge	REPORT-ONLY would merge PR #$PR (all gates + review + audit passed)" >> /workspace/group/memory/delta-log.md
```
Post one Telegram line (Step 7) noting the report-only pass. Do NOT increment `MERGED`.

If `LIVE` == `true` and `MERGED < MAX_MERGES`:
```bash
# Mark ready if still draft (gh won't merge a draft), then squash-merge + delete branch.
gh pr ready "$PR" --repo dasonshi/hylo 2>/dev/null || true
if gh pr merge "$PR" --repo dasonshi/hylo --squash --delete-branch 2>/workspace/scratch/merge-$PR.err; then
  MERGED=$((MERGED+1))
  ISSUE=$(grep -oiE 'Closes #[0-9]+' /workspace/scratch/pr-$PR-body.md | grep -oE '[0-9]+' | head -1)
  NOW=$(date -u +%FT%TZ)
  echo "{\"issue_number\": ${ISSUE:-null}, \"pr_number\": $PR, \"status\": \"merged\", \"merged_at\": \"$NOW\", \"by\": \"hylo-auto-merge\"}" >> /workspace/group/memory/known-issues.jsonl
  echo "$(date -u +%F)	auto_merged	PR #$PR${ISSUE:+ (issue #$ISSUE)} — CI green, reviewed, self-audited" >> /workspace/group/memory/delta-log.md
else
  # Merge itself failed (branch protection / permissions / race). Escalate, don't retry-loop.
  HOLD_REASON="merge API failed: $(tail -1 /workspace/scratch/merge-$PR.err)"
fi
```
After a real merge, the host-side `hylo-post-deploy-gate` timer detects the merged auto-draft PR within 30 min and enqueues `hylo-post-deploy-verify`, which replays the original failing call and records `closed-fixed`. You do **not** verify here — just merge and let the pipeline close it.

## Step 6 — Escalate a held PR

For any PR with `$HOLD_REASON`, leave it open and post ONE concise Telegram line (Step 7) so David can act. Do not comment on the PR every run (avoid noise) — the delta-log + Telegram are enough. Log it:
```bash
echo "$(date -u +%F)	auto_merge_hold	PR #$PR held: $HOLD_REASON" >> /workspace/group/memory/delta-log.md
```

## Step 7 — Telegram (via mcp__nanoclaw__send_message, jid tg:-5292785894)

Send ONE message summarizing the run (batch all PRs into a single message, don't spam per-PR):

```
🤖 hylo-auto-merge (<LIVE|REPORT-ONLY>)
✅ merged: #<n> (issue #<m>) …   ← only in LIVE
🧪 would-merge: #<n> …           ← only in REPORT-ONLY
⏸ held for you:
   • #<n> — <reason>
```
Omit empty sections. If nothing happened (no candidates), stay silent (the delta-log line is enough).

## Don't

- Don't merge anything without the `auto-draft` label. Human PRs are never in scope.
- Don't merge on anything less than fully-green CI. No CI visible = HOLD, never merge.
- Don't merge a PR touching `always_human` paths or anything outside `api/`,`tests/` — escalate.
- Don't merge in REPORT-ONLY mode (`pr_to_merge.enabled=false`). Report only.
- Don't exceed `max_per_run` merges in one run.
- Don't `--admin`-override branch protection or force anything. A blocked merge is an escalation.
- Don't retry a failed merge in a loop — escalate once and move on.
- Don't include `Co-authored-by` lines anywhere.
