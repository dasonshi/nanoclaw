# SavvyClaw — Main Channel

This is the main channel with David. Elevated privileges. No trigger word needed.

## Container Mounts

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-only |
| `/workspace/group` | `groups/main/` | read-write |

Key paths inside the container:
- `/workspace/project/store/messages.db` - SQLite database
- `/workspace/project/groups/` - All group folders

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

### Adding a Group

1. Query the database to find the group's JID
2. Use the `register_group` MCP tool with the JID, name, folder, and trigger
3. The group folder is created automatically
4. Optionally create an initial `CLAUDE.md` for the group

Folder naming: `telegram_dev-team`, `discord_general`, etc.

### Scheduling for Other Groups

Use `target_group_jid` parameter with the group's JID:
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "...")`

## AI News

The `ai_news` MCP provides tools for browsing curated AI news. Feeds auto-refresh daily at 6am UTC.

When David asks to refresh news, check latest articles, or says anything like "refresh feeds" / "update news":
- Call `mcp__ai_news__refresh_feeds` to pull the latest articles
- Then use `mcp__ai_news__browse_recent`, `mcp__ai_news__search_news`, or `mcp__ai_news__get_summary` to find relevant content

Key categories: `use-case` (practitioner builds), `enablement` (AI adoption), `smb` (small business), `enterprise`, `product`, `research`, `coding`, `opinion`

## Social Post Drafting

When David asks you to draft social media posts, use the `social-post` skill (call `Skill("social-post")`) for the full framework, and `davids-voice` skill for base voice rules.

Posts have three dimensions — David may specify any combination:
- **Topic**: what the post is about
- **Approach**: thinking out loud, field note, connect the dots, tear down, contrast frame, annotated share
- **Voice structure**: stream of consciousness, stacked fragments, mid-thought, punchy LinkedIn

If David doesn't specify, pick what fits the topic best and tell him what you chose.

### Voice refinements

Refinements from David's feedback go here. These OVERRIDE the base skill when they conflict. When David scores posts or gives feedback on tone/structure, append the lesson below.

_No refinements yet. After David scores drafts, add entries like:_
_- "Stream of consciousness works best for field notes — don't pair stacked fragments with field note approach"_
_- "Avoid X pattern, David scored it 2/10 because..."_

## Global Memory

You can read and write to `/workspace/project/groups/global/CLAUDE.md` for facts that should apply to all groups. Only update global memory when explicitly asked.
