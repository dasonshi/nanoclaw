---
name: routeaware-implementer-followup
description: Extends an existing open agent/* PR with new asks instead of opening a new PR. Used when an external reviewer (David, his other Claude, or the audit skill) flags polish items that should land on the same branch rather than as a separate PR. Runs in the routeaware_implementer_exec synthetic group.
---

# RouteAware Implementer — Follow-up to existing PR

You are extending an open `agent/*` PR with new asks. Hard rules from the implementer-exec skill still apply — never push to main, never force-push, every commit prefixed `[agent]`. The difference: you check out an EXISTING branch instead of creating one, and you push to the SAME branch instead of opening a new PR.

## Step 0 — Read inputs

You're in the `routeaware_implementer_exec` synthetic group. Same cross-mounts as exec:

- `/workspace/extra/standup-state/<YYYY-MM-DD>/` — read-only access to standup state
- `/workspace/extra/standup-memory/` — read-write for memory/implementer.md + memory/last-exec.json

The scheduling prompt MUST carry two things: the PR number and the asks. Format:

```
Run skill routeaware-implementer-followup for PR <N>. Asks:
- <ask 1>
- <ask 2>
- ...
```

Parse `PR <N>` and the asks block from your prompt. If either is missing, abort with a Telegram to `tg:-5257303857`: `❌ Follow-up: prompt missing PR number or asks. Aborting.`

## Step 1 — Resolve the branch from PR number

```bash
set -euo pipefail
export GH_TOKEN=$(cat /workspace/extra/nanoclaw/routeaware-gh.token)
PR_NUM=<from prompt>

# Pull branch name from gh API
BRANCH=$(gh pr view "$PR_NUM" --repo dasonshi/route-aware --json headRefName -q .headRefName)
PR_STATE=$(gh pr view "$PR_NUM" --repo dasonshi/route-aware --json state -q .state)

if [ "$PR_STATE" != "OPEN" ]; then
  # Telegram abort: ❌ Follow-up: PR #$PR_NUM is $PR_STATE, not OPEN. Aborting.
  exit 1
fi

# Refuse if branch isn't agent/* — safety
case "$BRANCH" in
  agent/*) ;;
  *) # Telegram abort: ❌ Follow-up: PR #$PR_NUM is on '$BRANCH' (not agent/*). Refusing.
     exit 1 ;;
esac
```

## Step 2 — Set up clean working tree on the EXISTING branch

```bash
SCRATCH=/workspace/extra/routeaware-scratch
rm -rf $SCRATCH/work
mkdir -p $SCRATCH/work

mkdir -p ~/.ssh
cp /workspace/extra/routeaware_deploy ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null

cd $SCRATCH/work
git clone git@github.com:dasonshi/route-aware.git
cd route-aware
git config user.email "agent@nanoclaw.local"
git config user.name  "NanoClaw Agent"

# Check out the existing PR branch
git fetch origin "$BRANCH"
git checkout "$BRANCH"

# Sanity: assert we're not on main
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$HEAD_BRANCH" = "main" ] && { echo "REFUSING to work on main"; exit 1; }
```

## Step 3 — Apply the asks

Use Read, Write, Edit builtin tools. **Stay strictly within the scope of the asks** — don't expand. If you find an ask is ambiguous or would require touching things outside the obvious scope, comment in the PR (via `gh pr comment`) explaining your interpretation and ship the narrow version anyway. Don't refuse the followup over interpretation.

After implementing each ask, run tests + lint:

```bash
npm install --prefer-offline --no-audit 2>&1 | tail -5
npm test 2>&1 | tail -20 > /tmp/test-output.txt
TEST_EXIT=$?
npm run lint 2>&1 | tail -10 > /tmp/lint-output.txt
LINT_EXIT=$?
```

## Step 4 — Commit + push to same branch

```bash
git add -A
git status --porcelain  # log for debugging
git commit -m "[agent] follow-up on PR #$PR_NUM: $(echo "$ASKS_SUMMARY" | head -c 60)"
git push origin "$BRANCH"  # updates the existing PR
```

If there's nothing to commit (asks were all no-ops or you decided not to make changes), comment on the PR explaining and exit cleanly — don't fail.

## Step 5 — Comment on the PR with what changed

```bash
COMMENT=$(cat <<EOF
**Follow-up commit on this branch.**

Asks addressed:
- <ask 1 → what you did>
- <ask 2 → what you did>

Tests: <pass | fail (output below)>
Lint: <pass | fail (output below)>

\$([ "$TEST_EXIT" -ne 0 ] && echo -e "\n<details><summary>Test output</summary>\n\n\`\`\`\n$(cat /tmp/test-output.txt)\n\`\`\`\n</details>")

If anything needs another pass, comment on the PR or message the standup chat.
EOF
)
gh pr comment "$PR_NUM" --repo dasonshi/route-aware --body "$COMMENT"
```

## Step 6 — Notify standup chat

**chatJid MUST be `"tg:-5257303857"` (NOT `routeaware-exec@local`).**

```
mcp__nanoclaw__send_message:
  chatJid: "tg:-5257303857"
  text: |
    🔁 Follow-up pushed to PR #<N>: <URL>
    Asks: <one-line summary>
    Tests: <pass|fail>  ·  Lint: <pass|fail>  ·  Commit: <short sha>
```

## Step 7 — Append memory + exit

```bash
echo "$(date -u +%F) Followed up on PR #$PR_NUM: <one-line what you did>; tests <pass/fail>" \
  >> /workspace/extra/standup-memory/implementer.md
```

Print `Followup done. PR: #$PR_NUM, branch: $BRANCH.` and exit.
