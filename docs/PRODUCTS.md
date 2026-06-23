# HyloClaw Products

## Product 1: HyloClaw — $79/mo

**Tagline:** Manage your GHL from Telegram.

**What it is:** Multi-tenant SaaS. Customer DMs the bot on Telegram, connects their GHL sub-account, and gets an AI assistant that can search contacts, manage pipelines, check calendars, run workflows — all from chat.

**How it works:**
- Shared infrastructure (single VPS, single Anthropic key, single Telegram bot)
- Each customer's GHL access is scoped to their sub-account via PIT token
- AI runs in isolated Docker containers per message
- No cross-tenant data leakage

**Onboarding flow:**
1. Customer signs up on claw.savvysales.ai, pays $79/mo via Stripe
2. DMs @SavvyClaw_Bot on Telegram, types `/start`
3. Bot walks them through: business name → GHL Location ID → PIT token → description → bot name
4. Account is live, bot responds with their business context

**Multi-location support:**
One customer can connect multiple GHL sub-accounts. Each location has its own PIT token and Location ID. The bot tracks which location is "active" and the customer switches between them.

**Bot commands (coded, not AI-handled):**
- `/start` — Begin onboarding (new customers only)
- `/locations` — Show connected locations as numbered list, customer taps/replies with number to switch
- `/connect` — Connect a new GHL location (Location ID → PIT token → description)
- `/reconnect` — Update PIT token for the active location (if expired/regenerated)
- `/disconnect` — Remove the active location
- `/pause` — Pause the account
- `/resume` — Resume a paused account
- `/help` — Show available commands

**How multi-location works:**
- Each location gets its own bridge token + profile entry in profiles.yaml
- `/locations` shows a numbered list — customer picks by number to switch:
  ```
  Your locations:
  1. Acme Plumbing ← active
  2. Joe's Auto
  3. Sunrise Dental

  Reply with a number to switch.
  ```
- Customer's CLAUDE.md is regenerated on switch with the active location's details
- AI always operates on one location at a time
- `/connect` adds a new location without disrupting the active one
- `/reconnect` just asks for the new PIT token, validates, swaps it in

**Target customer:** GHL sub-account owner or agency VA who wants quick access to their GHL data without logging into the dashboard. Agencies managing multiple sub-accounts are the sweet spot.

---

## Product 2: NanoClaw Private Instance — Custom pricing

**Tagline:** Your own private AI agent. Message me.

**What it is:** Dedicated, private NanoClaw deployment. Customer gets their own server, their own API key, their own bot — David can't see their data.

**How it works:**
- Dedicated VPS per customer
- Customer provides their own Anthropic API key
- Customer gets their own Telegram bot
- Full isolation — no shared infrastructure
- David manages the deployment, customer owns the data

**Onboarding flow:**
1. Customer fills out "Message me" form on landing page
2. David scopes the engagement (what integrations, what workflows, custom CLAUDE.md)
3. David provisions a dedicated server + bot
4. Handoff: customer has a private AI agent tailored to their business

**Target customer:** Agency owner, business with compliance requirements, anyone who wants full privacy and customization.

**Pricing:** TBD — likely $199-499/mo depending on scope, or project-based.

---

## Landing Page Structure

- **Hero:** "Manage your GHL from Telegram" with HyloClaw branding
- **Product 1 section:** Features, $79/mo CTA → Stripe checkout
- **Product 2 section:** "Need something custom?" → "Message me" form/CTA
- **How it works:** 3-step visual (Sign up → Connect GHL → Chat)
- **FAQ:** PIT tokens, security, what the bot can do
