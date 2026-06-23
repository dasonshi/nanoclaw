---
name: routeaware-implementer-finalize-plan
description: Synthesizes implementer plan + plan-critic + plan-bigpicture, checks the plan_to_exec auto-approve gate, either auto-schedules exec OR asks David. Hard floor: any always_human path/dep/branch trigger escalates regardless of gate state.
---

# RouteAware Finalize Plan

You synthesize the plan + its reviews into either an auto-advance OR a David-facing message. This is the most dangerous gate — exec phase will actually push code.

## Step 1 — Read inputs

```bash
TODAY=$(date -u +%F)
DIR=/workspace/group/state/$TODAY
test -f $DIR/plan.md             || { echo "No plan.md — abort"; exit 1; }
test -f $DIR/plan-critic.md      || echo "Plan critic missing — proceeding with degraded review"
test -f $DIR/plan-bigpicture.md  || echo "Plan big-picture missing — proceeding with degraded review"
```

## Step 2 — Auto-approve gate eval

Read `/workspace/group/auto-approve.json`, the `plan_to_exec` block.

Parse the plan's `Touched paths summary`:
- `sensitive_paths` — list (or "none")
- `new_deps` — list (or "none")
- `schema_changes` — yes/no

Eval `require[]`:
- `scope=small`: chosen candidate's scope from earlier (read finalized-proposal.md) == "small"
- `no_sensitive_paths`: `sensitive_paths` == "none"
- `no_new_deps`: `new_deps` == "none"
- `plan-critic.verdict=ship-it`: parse from plan-critic.md
- `plan-bigpicture.bullshit-test=passes`: parse from plan-bigpicture.md

Eval `always_human[]` against the plan's `Files to modify` + `Files to add` lists:
- For each entry in always_human (e.g., `supabase/migrations/`, `package.json`, `branch=main`, `force_push`, `new_dependency`, `schema_change`), check if any planned file path contains the pattern OR the summary indicates the action. **Hard fail on any match.**

**Both `require` (all true) AND `always_human` (no matches) must pass.** Otherwise fall through to David's gate.

## Step 3a — Auto-advance path

If both checks pass:

1. **Schedule the exec task using these EXACT parameters** to `mcp__nanoclaw__schedule_task`. The `targetJid` MUST be the literal string `routeaware-exec@local` — NOT the standup chat JID, NOT a Telegram JID. The synthetic group `routeaware_implementer_exec` is registered under this exact synthetic JID because it holds the GitHub deploy key (the standup group does not). If you schedule against the standup JID, the task will fire in the wrong group, the exec will fail silently for lack of a writable repo mount, and David will get nothing.

   ```json
   {
     "type": "schedule_task",
     "targetJid": "routeaware-exec@local",
     "schedule_type": "once",
     "schedule_value": "<current ISO timestamp, e.g. 2026-05-21T22:30:00.000Z>",
     "context_mode": "isolated",
     "prompt": "Run skill routeaware-implementer-exec for today."
   }
   ```

   Verify after scheduling: the IPC handler logs `Task created via IPC` with a `targetFolder` field. If `targetFolder` shows `telegram_routeaware_standup` instead of `routeaware_implementer_exec`, you set the wrong targetJid — retry with the correct value.

2. Send Telegram FYI to the standup chat (use `mcp__nanoclaw__send_message` with `chatJid: "tg:-5257303857"`): `🤖 Plan auto-approved. Exec starting in the synthetic group. Files: N, scope: small. (Reply *cancel* to abort.)`
3. Append `<today>\tplan-go\t<title>\t(auto)\tapproved` to `memory/approvals.md`.
4. Update status.json: `phase: awaiting-implementer-exec`, `outcome: auto-approved`.
5. Append memory line, exit.

## Step 3b — David's gate path

Compose a Telegram message (under 1000 chars):

```
*Plan ready: <Title>*

*Files:* N to modify, M to add  ·  *Scope:* small/medium/large
*Approach:* <2-line summary>

*Critic verdict:* <ship-it/needs-rework/skip> — <one-line>
*Big-picture verdict:* <ship-it/trim/rework> — <one-line>
*Tests:* <what'll be added/changed>

⚠️ <if auto-approve was enabled but a condition failed: state which condition + why escalating>

Reply: *go* / *revise <note>* / *cancel*
```

Send via `mcp__nanoclaw__send_message`. Update status.json to `phase: awaiting-user-plan-go`. Append `<today>\tplan-presented\t<title>\t(awaiting)\tpending` to approvals.md.

## Step 4 — Exit

Print `Finalize-plan done. Path: auto-approved | asked-david.` and exit.
