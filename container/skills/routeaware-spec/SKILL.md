---
name: routeaware-spec
description: After David approves a proposal, drafts the PRD (what + why) and TRD (how — broad strokes only). Sends a Telegram summary with sign-off / change / abort prompt. The TRD intentionally stops short of file-level planning; that's the implementer's plan phase.
---

# RouteAware Spec

You are the spec writer. The proposal has been approved. Your job: take the one-paragraph proposal and turn it into a tight PRD + TRD pair that the implementer (running plan-mode first) can refine into a concrete change.

## Step 1 — Read inputs

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
cat $DIR/finalized-proposal.md  # what the user approved
cat $DIR/proposal.md             # full strategist output (for context on rejected candidates)
[ -f $DIR/user-notes.txt ] && cat $DIR/user-notes.txt  # any extra direction David sent with approve
cat $DIR/critic.md               # don't forget the critic's risks
cat $DIR/bigpicture.md           # and the big-picture defense
```

Also re-read `/workspace/project/container/skills/routeaware-strategist/CONTEXT.md` for product priorities.

## Step 2 — Write PRD

`/workspace/group/state/<today>/prd.md`. Shape:

```markdown
# PRD — <Title> — <YYYY-MM-DD>

## What
<2–4 sentences describing the user-facing or system change. Concrete.>

## Why
<2–4 sentences. Tie to the proposal's "why now" and a current CONTEXT priority. Should answer "what would be different in 7 days if we shipped this?">

## Success criteria
- <Observable thing that proves it shipped, not "looks better">
- <2–4 bullets max>

## Non-goals
- <Things this explicitly does NOT do. Useful for keeping the implementer scoped.>
- <2–4 bullets max>
```

## Step 3 — Write TRD

`/workspace/group/state/<today>/trd.md`. Shape:

```markdown
# TRD — <Title> — <YYYY-MM-DD>

## Approach
<3–6 sentences. The shape of the solution: what gets changed, where, what existing patterns to follow. NOT file-by-file. NOT a diff. The implementer's plan phase produces that.>

## Areas of code likely involved
- <directory or rough component>: <why>
- <another>: <why>

## Risks (from critic, re-stated concretely)
- <risk>: <how to mitigate during implementation>

## Out of scope for this sprint
<Anything you'd be tempted to fix along the way but shouldn't. Tied to PRD non-goals.>

## Test strategy
<One paragraph. What tests need to exist or pass. Existing test framework patterns to follow.>
```

## Step 3a — Auto-approve check (spec_to_plan gate)

Read `/workspace/group/auto-approve.json`, look at `spec_to_plan`. Same eval pattern as finalize-proposal:

- If disabled → proceed to Step 4 (ask David to sign off)
- If enabled, eval `require` (typically just `scope=small`) against the chosen candidate metadata in `finalized-proposal.md`. Eval `always_human` against the TRD's "Areas of code likely involved" list and the PRD's Success criteria — if any sensitive paths or strings appear, fail closed.

If auto-approved:
1. Schedule `routeaware-implementer-plan` via `mcp__nanoclaw__schedule_task` (once, now), targetJid `tg:-5257303857`.
2. Send Telegram: `🤖 Spec auto-approved. Implementer planning now. PRD + TRD in state. (Reply *cancel* to abort.)`
3. Append `<today>\tspec-signoff\t<title>\t(auto)\tapproved` to `memory/approvals.md`.
4. Update status.json `phase: awaiting-implementer-plan`, `outcome: auto-approved`.
5. Skip Step 4.

Otherwise fall through.

## Step 4 — Telegram summary + state

Compose a tight Telegram message (under 800 chars):

```
*Spec ready: <Title>*

*What:* <one line>
*Approach:* <one line>
*Success:* <one bullet>
*Risks:* <one line>

Full PRD + TRD in state. Reply: *sign off* / *change <note>* / *abort*
```

Send via `mcp__nanoclaw__send_message`, then update status.json:

```bash
cat > $DIR/status.json <<JSON
{
  "phase": "awaiting-user-spec-signoff",
  "outcome": null,
  "started_at": "$(date -u +%FT%TZ)",
  "updated_at": "$(date -u +%FT%TZ)"
}
JSON
```

## Step 5 — Append memory + exit

```bash
TODAY=$(date -u +%F)
echo -e "$TODAY\tspec-presented\t<title>\t(awaiting)\tpending" \
  >> /workspace/group/memory/approvals.md
```

Print `Spec done. PRD + TRD written, summary sent to David.` and exit.
