# RouteAware — Strategist Context

> *Stack/health/structure auto-seeded from the repo; priorities/off-limits/decisions are human-curated via local Claude Code planning sessions in the `RouteAware` repo (see `roadmap.md` + `manual-tasks.md` for the macro plan). `[auto]` sections get refreshed when commits drift; everything else is preserved.*

## What it is

RouteAware is a **GoHighLevel marketplace app** that makes a GHL location's booking widget route-aware — customers self-book slots that fit existing technician routes, unlocking ~1 extra job per day per truck. **Built for 2-5 truck home-service operators (HVAC, plumbing, cleaning, pest control) already running on GHL.** The wedge is "your booking widget gets smart without you switching tools."

Strategic shape: see `/workspace/group/roadmap.md` (3-layer plan, 6-week MVP target ending 2026-07-02). Manual prerequisites David must complete: see `/workspace/group/manual-tasks.md`.

## Stack `[auto]`

- **Repo:** `github.com/dasonshi/route-aware`, default branch `main`
- **Frontend:** Vite, React 18, TypeScript, shadcn/ui, Tailwind, React Hook Form, Sonner toasts, TanStack Query, React Router
- **Backend:** Supabase (auth, Postgres with row-level migrations, Edge Functions for geocoding / available-slots / google-maps-key / push-notifications)
- **Build:** `npm run build` (vite) · **Dev:** `npm run dev` · **Lint:** `npm run lint` · **Tests:** `npm test` (vitest run)
- **Lockfiles present:** both `bun.lockb` and `package-lock.json` — historic; npm is the active toolchain per scripts

## Repo health snapshot `[auto]`

- **Created:** 2026-01-17
- **Last meaningful commit:** "Polished lockfile and deps" 2026-03-08; before that mostly Lovable AI scaffolding
- **First agent PR:** #1 (Dispatch Board Next-Best-Action UX), 2026-05-21 — landed draft pending lint cleanup
- **Open issues:** read live via the API; strategist fetches fresh each morning
- **Test coverage:** minimal — vitest infra exists, real tests just starting (PR #1 added the first non-placeholder ones)

## Current priorities (top 3)

1. **Ship GHL marketplace app v1 by 2026-07-02** — OAuth install + webhook sync + scored-slot endpoint + iframe booking widget + billing.
2. **Convert one GHL agency mastermind/community relationship into a real pilot commitment** (one agency installing on one real home-service sub-account) before week 4.
3. **Get the routing math working end-to-end against real GHL data** — including a paid geocoder fallback under a strict monthly cap, since Nominatim's rate limit will break the pilot.

## Off-limits

- Standalone signup / non-GHL onboarding wizard (path retired)
- Solo operator (1 truck) features, marketing, or pricing tier
- Native iOS / Android apps (PWA is sufficient)
- Direct integrations with Jobber, Housecall Pro, or ServiceTitan
- Routing math improvements beyond what the pilot requires
- Custom analytics or report builder beyond "minutes saved" tile
- i18n / non-English
- SOC2, enterprise SSO, white-label
- New features requested by agencies who haven't committed to install
- New OAuth scope requests to GHL beyond the minimum required for scoring

## Notable areas `[auto]`

For grounding proposals, the source tree includes these named feature areas:

| Area | Files |
|---|---|
| Dispatch | `src/components/dashboard/DispatchBoard.tsx`, `RouteMapView.tsx`, `RouteOptimizer.tsx`, `MultiTechOptimizer.tsx`, `CapacityPlanning.tsx`, `TravelTimeEstimates.tsx`, `src/lib/dispatchHealth.ts` (added by PR #1) |
| Live tracking | `LiveLocationMarker.tsx`, `LiveTrackingPanel.tsx`, `CustomerETAPanel.tsx`, `useGpsTracking.ts`, `useTechnicianLocations.ts`, `useCustomerETA.ts` |
| Technician view | `src/components/technician/*`, `src/pages/technician/TechnicianView.tsx` |
| Customer-facing | `src/pages/BookingWidget.tsx`, `CustomerPortal.tsx`, `src/components/ui/address-autocomplete.tsx` |
| Onboarding (retired) | `src/components/onboarding/*` (will be removed / redirected to GHL listing per off-limits) |
| Backend | `supabase/functions/{geocode-address,get-available-slots,get-google-maps-key,send-push-notification}/`, 9 migration files |

## Recent decisions

- 2026-05-21: Distribution path = **GHL marketplace first**; standalone retired. Standalone signup routes will be removed or redirected.
- 2026-05-21: ICP = home-service operators with 2-5 trucks (HVAC, plumbing, cleaning, pest control) already on GoHighLevel. Solo operators explicitly excluded.
- 2026-05-21: Pricing instinct = $39/mo per GHL sub-account location, single tier in v1.
- 2026-05-21: System of record = Supabase mirrors GHL via webhooks; revisit if sync drift dominates Layer 2 bug load.
- 2026-05-21: Default PMF bar pending David+partner confirmation = 5 paying agencies / 20 active installs / $1-3K MRR by 2026-11-21.
