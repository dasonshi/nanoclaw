# HyloClaw Landing Page — Bootstrap Prompt

Use this prompt with `/frontend-design` or any AI to generate a complete, deployable landing page.

---

## Prompt

Build a single-page marketing website for **HyloClaw** — an AI assistant that manages GoHighLevel (GHL) sub-accounts via Telegram chat. The page needs to sell the product AND explain how it works technically to build trust with GHL power users.

### Product Summary

HyloClaw is a Telegram bot powered by Claude AI (Haiku 4.5) that connects to a user's GoHighLevel sub-account and lets them manage it through natural language conversation. Instead of clicking through GHL dashboards, users message the bot: "show me contacts from this week", "send John a follow-up SMS", "what's on my calendar tomorrow?" — and it executes against their GHL account with their permission.

**Target audience:** GHL agency owners, sub-account operators, and solopreneurs who want AI-powered CRM management without learning APIs, building automations, or hiring a developer.

### Architecture (for the "How It Works" technical section)

The page should have a technical credibility section that shows the stack visually. Here's the real architecture:

**The Stack:**
- **Telegram Bot** (@HyloClawBot) — the user-facing interface. One bot serves all customers, routes messages by chat ID.
- **NanoClaw** — open-source Node.js agent framework that runs Claude Haiku 4.5. Each message spawns an isolated Docker container. Containers are destroyed after responding.
- **Hylo Bridge** — lightweight REST server that proxies authenticated requests between the AI agent and the GHL knowledge layer.
- **Hylo API** (api.hylo.pro) — the intelligence layer. Contains 494 GHL API endpoint schemas, 129 workflow actions, 85 triggers, 9 navigation protocols, help articles, and workflow planning. The AI uses this to understand what GHL can do and how to do it.
- **GoHighLevel API** — the actual GHL platform. HyloClaw reads and writes data here via the user's Private Integration Token (PIT).

**The Flow (for a diagram):**
```
User sends message in Telegram
    ↓
NanoClaw routes to customer's isolated container
    ↓
Claude Haiku 4.5 reads customer's CLAUDE.md (business context + auth)
    ↓
Agent queries Hylo API for schema/help (which GHL endpoint to use?)
    ↓
Agent builds GHL API call, asks user for permission if it writes data
    ↓
Hylo Bridge authenticates + proxies the call to GHL
    ↓
Response sent back to user in Telegram
    ↓
Container destroyed — no state leaks between sessions
```

### Security Architecture (for a trust/safety section)

This is critical for GHL users who are handing over CRM access. Show these as visual cards or a security diagram:

1. **Container Isolation** — Every single message runs in a fresh Docker container. Containers can't see other customers' data, can't access the host filesystem, and are destroyed after responding. There's no shared state.

2. **Per-Customer Auth Tokens** — Each customer gets a unique bridge token that's cryptographically generated during onboarding. This token is scoped to exactly one GHL location ID. Even if a container were compromised, it can only access that one customer's account.

3. **Credential Proxy** — The AI agent never sees real API keys. Anthropic credentials are injected via a credential proxy at runtime. The `.env` file is shadowed with `/dev/null` inside containers.

4. **Loopback-Only Bridge** — The Hylo Bridge (which holds GHL tokens) only listens on localhost (127.0.0.1). It's not reachable from the network. Even on a VPS, it's invisible to port scanners.

5. **Error Sanitization** — All error responses are scrubbed for tokens, API keys, and bearer credentials before being returned. No credential can leak through error messages.

6. **Customer Self-Revocation** — Users can instantly revoke access by deleting their Private Integration Token in GHL settings. No need to contact us. Access is blocked immediately.

7. **Confirm Before Acting** — Read-only operations (viewing contacts, checking calendars) run instantly. Any write operation (sending SMS, creating contacts, modifying pipelines) requires explicit user approval in the chat first.

### Setup Process (for a "Getting Started" section)

Show this as a simple 3-step visual:

**Step 1: Connect your GHL account (5 minutes)**
Create a Private Integration Token in your GHL sub-account. Go to Settings > Integrations > Private Integrations > Create New. You control the scopes — enable what you want the AI to access (contacts, calendars, pipelines, etc.).

**Step 2: Message the bot on Telegram**
Search for @HyloClawBot. Send `/start`. You'll get a chat ID. Send that plus your Location ID and PIT token to us (or paste into the signup form). We provision your instance — usually within minutes.

**Step 3: Just ask**
"Show me my pipeline." "Send Sarah a reminder." "What contacts came in this week?" The AI looks up the right GHL endpoint, shows you what it plans to do, and executes with your OK.

### Content Structure

**Hero Section**
- Headline: "Manage your GHL sub-account from Telegram. Just ask."
- Sub-headline: "Stop clicking through dashboards. HyloClaw is an AI assistant that knows your contacts, pipelines, calendars, and workflows — accessible from a chat message."
- CTA button: "Get Started — $79/mo"
- Secondary: "See how it works ↓"
- Visual: Telegram chat mockup with realistic GHL queries and responses

**What You Can Say (Feature showcase as chat bubbles)**
- "Show me all contacts who booked this week"
- "Send a follow-up SMS to anyone who missed their appointment yesterday"
- "Create a new opportunity in my sales pipeline for John Smith"
- "What's my calendar look like tomorrow?"
- "How many new leads came in this month?"
- "Every morning at 9am, check for stale leads and send me a summary"

Caption: "Understands 494 GHL API endpoints, 129 workflow actions, and 85 triggers. If you can do it in GHL, you can ask HyloClaw."

**How It Works (Technical credibility section)**
- Architecture diagram showing the flow above
- Highlight: "Each message runs in an isolated container. Your data never touches another customer's environment."
- Callouts for each component (Telegram → NanoClaw → Hylo API → GHL)

**Security & Trust (Visual cards)**
- Container isolation, per-customer auth, credential proxy, loopback binding, error sanitization, self-revocation, confirm-before-acting
- Visual: shield/lock icons, maybe a simplified security diagram

**Pricing**

| | Starter | Agency |
|---|---|---|
| Price | $79/mo | $199/mo |
| GHL sub-accounts | 1 | Up to 5 |
| AI interactions | Unlimited | Unlimited |
| Scheduled tasks | ✓ | ✓ |
| Priority support | — | ✓ |

"Cancel anytime. No contracts. Revoke access instantly from GHL."

**FAQ (collapsible accordion)**

Q: Is my GHL data safe?
A: Your API token is stored encrypted and never shared. Each conversation runs in an isolated Docker container that's destroyed after responding. The AI never sees other customers' data. You can revoke access instantly from GHL settings.

Q: Does it change things without asking?
A: No. Read-only operations (viewing contacts, checking calendars) run immediately. Anything that modifies data (sending SMS, creating contacts, updating pipelines) gets described to you first and only executes with your explicit OK.

Q: What can it actually do in GHL?
A: Almost everything you can do in the dashboard: contacts, conversations, calendars, opportunities, pipelines, workflows, forms, invoices — 494 API endpoints across all GHL features.

Q: Do I need to be technical?
A: No. Plain English via Telegram. "Show me contacts from last week" works just as well as knowing the API endpoint name.

Q: Can it run things automatically?
A: Yes. Set up scheduled tasks: "Every morning at 9am, check for stale leads and send me a summary." It runs in the background and messages you with results.

Q: How do I revoke access?
A: Delete the "HyloClaw" integration in your GHL settings (Settings > Integrations > Private Integrations). Access is blocked immediately. No need to contact us.

Q: What AI model does it use?
A: Claude Haiku 4.5 by Anthropic — fast, accurate, and designed for tool use. It's the same AI that powers enterprise-grade automation tools.

**Footer**
- "HyloClaw — AI-powered GHL management"
- Links: Get Started | Pricing | FAQ | Security
- "Built by Savvy Sales"
- Contact email placeholder

### Design Direction

- Clean, modern, professional — think Linear or Vercel marketing style
- Dark mode preferred (fits the "developer credibility" angle)
- Primary accent: a vibrant teal/cyan
- Secondary: Telegram blue (#0088cc)
- GHL's palette is blue — complement it, don't copy
- Show the Telegram chat interface as a styled recreation (not a screenshot)
- Architecture diagram should be clean SVG-style, not a messy flowchart
- Security section should feel solid — shield icons, card layout, maybe a subtle gradient
- Mobile-first responsive
- Subtle scroll animations (fade-in, not flashy)
- No stock photos. Icons, illustrated elements, chat UI mockups

### Technical Requirements

- **Single HTML file** — all CSS and JS inline (or Tailwind via CDN)
- **No framework** — vanilla HTML/CSS/JS
- **Deployable to Cloudflare Pages** as static
- **Domain:** `claw.savvysales.ai`
- **Stripe Checkout:** "Get Started" buttons should have `data-stripe-link` attributes as placeholders
- **Fast loading** — no heavy assets
- **SEO** — meta title, description, OG tags
- **Accessible** — proper heading hierarchy, alt text, keyboard navigation

### Tone

Confident but not hype-y. Technical credibility through real numbers (494 endpoints, Docker isolation, per-customer auth tokens) without being intimidating. The user should feel "these people actually understand GHL and security" not "this is another AI wrapper with a landing page."
