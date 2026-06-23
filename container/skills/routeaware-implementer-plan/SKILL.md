---
name: routeaware-implementer-plan
description: First half of the implementer. Reads the approved PRD/TRD and produces an implementation plan (files to touch, approach, test strategy) WITHOUT touching any code. Repo is intentionally not mounted in this phase — plan-mode is enforced structurally. Spawns plan-critic + plan-bigpicture, then finalize-plan.
---

# RouteAware Implementer — Plan phase

You are the implementer in plan-mode. Repo is NOT mounted here — you physically cannot edit code. Your only output is a plan that the exec phase will execute (after review and approval). This is structural plan-mode, not promise-based.

## Step 1 — Read inputs

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
```

- `$DIR/prd.md` — what + why
- `$DIR/trd.md` — approach
- `$DIR/finalized-proposal.md` — the user-approved framing
- `/workspace/group/memory/implementer.md` last 30 lines — your own past lessons
- `/workspace/group/memory/delta-log.md` last 14 lines — past drift signal: where past plans diverged from execution

Also gather repo signal via the GitHub API (token at `/workspace/extra/nanoclaw/routeaware-gh.token`):

```bash
TOK=$(cat /workspace/extra/nanoclaw/routeaware-gh.token)
H="Authorization: Bearer $TOK"; A="Accept: application/vnd.github+json"
# Repo tree (limit to areas mentioned in TRD)
curl -sS -H "$H" -H "$A" "https://api.github.com/repos/dasonshi/route-aware/git/trees/main?recursive=1" \
  | python3 -c "import sys,json; [print(t['path']) for t in json.load(sys.stdin).get('tree',[]) if t['type']=='blob']" \
  | head -200
# Read individual files when the TRD names them — use the contents API
```

## Step 2 — Produce plan.md

Write `$DIR/plan.md` in this shape:

```markdown
# Implementation Plan — <Title> — <YYYY-MM-DD>

## Files to modify
- `path/to/file.tsx` — <what change, one line>
- `path/to/other.ts` — <what change>

## Files to add
- `path/to/new.ts` — <purpose>

## Approach (step-by-step, what the exec phase will do)
1. <Step 1: concrete>
2. <Step 2>
3. <Step 3>
...

## Test strategy
- <How will we know it works? Which existing tests cover, which new tests need writing.>

## Risks captured from spec critic
- <risk>: <mitigation in the plan>

## Out of scope
- <Anything you'd touch if you weren't disciplined. Tied to PRD non-goals.>

## Touched paths summary (for auto-approve gate)
sensitive_paths: <none | list>
new_deps: <none | list of package names>
schema_changes: <yes | no>
```

The `Touched paths summary` block is the structured signal `finalize-plan` reads to evaluate the `plan_to_exec` auto-approve gate's `always_human` floor and `no_sensitive_paths` / `no_new_deps` conditions. **Don't bullshit this section** — if you're touching `package.json` to add a dep, list it honestly. The point of the gate is that David sees risky things, not that you sneak past it.

## Step 3 — Schedule plan reviewers + finalize-plan

Three sub-tasks. **`context_mode: 'isolated'` is REQUIRED** (see router CLAUDE.md for why — cross-session tool-call replay against Codex backend with `store:false` fails). `targetJid` is the standup chat (`tg:-5257303857`).

Use `mcp__nanoclaw__schedule_task` three times:

1. `routeaware-plan-critic` — `schedule_type: 'once'`, `schedule_value` = now ISO, `context_mode: 'isolated'`, prompt = "Run skill routeaware-plan-critic for today."
2. `routeaware-plan-bigpicture` — same shape, prompt = "Run skill routeaware-plan-bigpicture for today."
3. `routeaware-implementer-finalize-plan` — `schedule_value` = now + 5min ISO, `context_mode: 'isolated'`, prompt = "Run skill routeaware-implementer-finalize-plan for today."

Update status.json:

```bash
cat > $DIR/status.json <<JSON
{
  "phase": "awaiting-plan-reviewers",
  "outcome": null,
  "started_at": "$(date -u +%FT%TZ)",
  "updated_at": "$(date -u +%FT%TZ)",
  "title": "<title from plan.md or carried from spec>"
}
JSON
```

Send a one-line Telegram FYI to `tg:-5257303857`:
`📐 Implementer plan written (N files to modify, M to add). Plan critic + big-picture reviewing now. Finalize in ~5 min.`

## Step 4 — Append memory + exit

```bash
echo "$TODAY <one-line: what makes this plan tricky OR why it's straightforward; any pattern from delta-log informing scope>" \
  >> /workspace/group/memory/implementer.md
```

Print `Implementer-plan done. Plan written, N files to modify, M to add. Reviewers + finalize scheduled.` and exit.
