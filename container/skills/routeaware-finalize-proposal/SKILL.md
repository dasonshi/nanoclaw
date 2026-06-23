---
name: routeaware-finalize-proposal
description: Reads proposal.md + critic.md + bigpicture.md and posts the single user-facing morning message to David. Sets phase=awaiting-user-plan-approval. This is the ONLY skill that sends Telegram during the morning chain.
---

# RouteAware Finalize Proposal

You are the synthesis step. The strategist, critic, and big-picture have each written their piece. Your job: turn three files into one short message for David with a clear ask.

## Step 1 — Read the three artifacts

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
for f in proposal.md critic.md bigpicture.md; do
  [ -f "$DIR/$f" ] || { echo "Missing $f — sending degraded message"; }
done
```

If any are missing (e.g. strategist hit backpressure and exited early, or a reviewer failed):
- If `status.json` says `phase: done, outcome: backpressure` or `outcome: skipped` — exit silently. Do not message David; the morning is already over.
- If proposal exists but a reviewer file is missing — proceed with what you have. Note in the message which review is missing.

## Step 2 — Pick the candidate

Default: the top-ranked candidate from `proposal.md` (Candidate 1).

Override conditions:
- If the critic says `Verdict: skip` for Candidate 1 AND big-picture agrees (Moves the needle? = No) → bump to Candidate 2.
- If both reviewers reject all candidates → set `outcome: no-good-options`, send David a one-liner explaining why, exit.

## Step 3 — Compose the message

Telegram-formatted (single asterisks for bold, no markdown headings). Keep under 1200 characters. Shape:

```
*Today's proposal: <Title>*

<Why now — one or two sentences from the strategist>

*Risks (per critic):*
• <#1>
• <#2>

*Why still worth it (per big-picture):*
<one line>

Confidence: <H/M/L>  ·  Scope: <small/medium/large>

Reply: *approve* / *revise <note>* / *skip*
```

Edit aggressively. Don't include filler. If the critic produced 4 risks, take the 2 sharpest. If the big-picture review was lukewarm ("sort of moves the needle"), say so — don't sand it down.

If you chose Candidate 2 instead of 1, briefly note: "(Candidate 1 dropped — critic + big-picture both flagged it as bikeshedding.)"

## Step 3a — Auto-approve check (the permissions gate)

Read `/workspace/group/auto-approve.json`. Look at the `proposal_to_spec` block.

If `enabled` is false (default) → skip this step, proceed to Step 4 (ask David).

If `enabled` is true, evaluate each condition in `require[]` against the chosen candidate + critic + bigpicture outputs. Conditions parse as `key=value`:

- `scope=small` — chosen candidate's `Scope:` field == "small"
- `critic.verdict=ship-it` — critic.md's per-candidate Verdict for the chosen candidate == "ship-it"
- `bigpicture.movesNeedle=yes` — bigpicture.md's per-candidate "Moves the needle?" == "Yes"

Also evaluate `always_human[]` against the candidate's proposed scope language — if the candidate mentions any of those paths/strings (e.g. "supabase/migrations" or "package.json" or "new dependency"), the gate **fails closed** regardless of `require`.

If all `require` pass AND `always_human` triggers nothing:
1. Schedule `routeaware-spec` via `mcp__nanoclaw__schedule_task` with `schedule_type='once'`, `schedule_value=<now ISO>`, prompt = "Run skill routeaware-spec for today.", targetJid = `tg:-5257303857`.
2. Send a one-line Telegram FYI: `🤖 Auto-approved: <Title>. Spec drafting now. (Reply *cancel* to abort.)`
3. Append to `/workspace/group/memory/approvals.md`: `<today>\tproposal-approval\t<candidate>\t(auto)\tapproved`
4. Update status.json with `phase: awaiting-spec`, `outcome: auto-approved`.
5. Append memory line + exit. Skip Step 4.

If any condition fails or `always_human` triggers, fall through to Step 4 (David's gate). Note in the composed message which auto-approve condition failed if you had it enabled — useful debugging signal for David.

## Step 4 — Send + update state

```bash
# Send via the MCP tool, not bash curl
# Use mcp__nanoclaw__send_message with text=<the composed message>
```

Then write `/workspace/group/state/<today>/finalized-proposal.md` (verbatim copy of the sent message) and update status.json:

```bash
cat > $DIR/status.json <<JSON
{
  "phase": "awaiting-user-plan-approval",
  "outcome": null,
  "started_at": "$(jq -r .started_at $DIR/status.json 2>/dev/null || date -u +%FT%TZ)",
  "updated_at": "$(date -u +%FT%TZ)",
  "chosen_candidate": "<candidate-1 or candidate-2>"
}
JSON
```

(If `jq` isn't available, just use `$(date -u +%FT%TZ)` for both timestamps. The router doesn't depend on `started_at`.)

## Step 5 — Append memory + exit

Append one line to `/workspace/group/memory/bigpicture.md`-style synthesis log — but for the finalize role, log to `/workspace/group/memory/strategist.md` since this skill is the strategist's voice talking to David:

Actually no — keep finalize's observation in its own line in `approvals.md` (the shared signal file). The skill writes:

```bash
TODAY=$(date -u +%F)
echo -e "$TODAY\tproposal-presented\t<chosen-candidate>\t(awaiting)\tpending" \
  >> /workspace/group/memory/approvals.md
```

When David replies, the router CLAUDE.md updates that pending line to the actual outcome (`approved` / `revised` / `skipped`).

Print `Finalize-proposal done. Sent <chosen> to David.` and exit.
