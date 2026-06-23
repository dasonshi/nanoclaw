# HyloClaw Customer Onboarding

## What the Customer Provides

1. **GHL Location ID** — found in GHL: Sub-Account Settings > Business Info > "Location ID"
2. **PIT Token** — created in GHL: Settings > Integrations > Private Integrations > Create New
   - Name it "HyloClaw" or similar
   - Enable scopes: Contacts (read/write), Calendars (read), Opportunities (read/write), Conversations (read/write), plus any others they want
3. **Business context** — 2-3 sentences: what they sell, who their customers are, GHL workflows they use
4. **Telegram chat ID** — they message @SavvyClaw_Bot, send `/start`, bot returns their ID

## Automated Onboarding (Preferred)

```bash
cd ~/Projects/active/nanoclaw
./scripts/onboard.sh \
  --name "Acme Plumbing" \
  --slug "acme_plumbing" \
  --location-id "abc123def456" \
  --pit-token "pit-xxxx-yyyy-zzzz" \
  --chat-id "tg:12345" \
  --description "Local plumbing company. Lead tracking and appointment booking."
```

The script automatically:
1. Validates all inputs (format, conflicts)
2. Generates a unique bridge auth token for the customer
3. Adds profile to `~/.ghl/profiles.yaml` (with bridge_token)
4. Reloads the Hylo Bridge via `POST /admin/reload`
5. Generates `groups/telegram_{slug}/CLAUDE.md` from template (with auth token baked in)
6. Registers the Telegram group via IPC (picked up by NanoClaw within 1s)
7. Verifies registration in SQLite

### Verify

Ask the customer to message the bot. Confirm:
- [ ] Bot responds (not silently ignoring)
- [ ] Bot can fetch their contacts: ask "show me my recent contacts"
- [ ] Bot uses correct location_id (check bridge logs if unsure)
- [ ] Bot does NOT mention other accounts or expose any tokens

## Automated Offboarding

```bash
./scripts/offboard.sh --slug acme_plumbing          # archives group folder
./scripts/offboard.sh --slug acme_plumbing --delete  # permanently deletes
```

The script:
1. Unregisters from SQLite
2. Removes profile from profiles.yaml (including bridge_token)
3. Reloads bridge
4. Archives (or deletes) group folder and session data

Note: NanoClaw must be restarted after offboarding for the in-memory group map to update.

## Customer Self-Revocation

Customers can revoke HyloClaw's access at any time by deleting their PIT token in GHL:
1. Go to Settings > Integrations > Private Integrations
2. Find "HyloClaw" and click Delete

This immediately blocks all API access. HyloClaw will report auth errors on next use.

To request full account deletion, the customer contacts David. Offboarding removes all stored credentials and archived data.

## Security Architecture

- **Per-customer bridge tokens**: Each customer gets a unique auth token. The bridge validates it and restricts access to only that customer's GHL location_id. Cross-tenant access returns 403.
- **Admin token**: David's main session uses `BRIDGE_ADMIN_TOKEN` (env var in LaunchAgent) which can access all accounts.
- **Loopback binding**: Bridge listens on 127.0.0.1 only — not reachable from the network.
- **Container isolation**: Each message runs in a Docker container with only that customer's group folder mounted.
- **Credential proxy**: Anthropic API keys injected via proxy (port 3001) — containers never see real keys.
- **Error sanitization**: PIT tokens, API keys, and bearer tokens are redacted from all error responses.
- **File permissions**: `~/.ghl/profiles.yaml` is `chmod 600` (owner-only read/write).

## Customer-Facing Setup Guide

Send this to the customer:

---

**Setting up HyloClaw for your GHL account**

*Step 1: Create a Private Integration Token*

1. Log into your GHL sub-account
2. Go to Settings (gear icon) > Integrations
3. Click "Private Integrations" in the sidebar
4. Click "Create New"
5. Name it "HyloClaw"
6. Under Scopes, enable: Contacts, Calendars, Opportunities, Conversations (check both Read and Write for each)
7. Click Save
8. Copy the token that starts with `pit-...`

*Step 2: Find your Location ID*

1. In GHL, go to Settings > Business Info
2. Your Location ID is shown at the top — it's a string like `wHb7koqaUqw8x8KoYjOj`

*Step 3: Open Telegram*

1. Search for @SavvyClaw_Bot in Telegram
2. Send `/start`
3. Note the chat ID the bot shows you

*Step 4: Send us your details*

Send us:
- Your Location ID
- Your PIT token
- A brief description of your business (what you sell, who your customers are)
- Your Telegram chat ID from Step 3

We'll set everything up and let you know when it's ready (usually within a few hours).

*Revoking access:* You can revoke HyloClaw's access at any time by deleting the "HyloClaw" integration in your GHL settings. This immediately blocks all access.

---
