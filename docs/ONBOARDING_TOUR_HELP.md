# Onboarding — Tour, Help search, Health

> **Status: IMPLEMENTED (PR #382, stacked on #372).** The tour, the Help
> search UI, and the Health page ship in this PR. Two contract points
> diverged from the draft below and are flagged in **§ Implementation notes**.
> The original draft contract is retained underneath for reference.

## Purpose

The post-setup **product tour**, the persistent **Help** panel/search, and the
aggregated **/health** the help footer reads. Mostly client-side anchors + three
small backends. UI source: `onboarding-handoff/src/OnbTourHelp.jsx`.

## Backend contract

### Tour
- `POST /me/tour { completed: true }` → per-user flag so the tour shows once and
  is **replayable from Help**. Spotlight targets are client-side anchors (no API).
- Add `User.tourCompletedAt` (explicit column, not `IS NULL`).

### Help search
- `GET /help/search?q=` → semantic search over **locally shipped** help articles,
  indexed in the same embedding store used by Files/chat (reuse the file-indexer +
  ai-gateway `EmbedText`; `nomic-embed-text`/sentence-transformers). Articles ship
  on the box. "Ask Droplet AI" routes the query into on-device chat.

### Health
- `GET /health` aggregated across services (routing, ai-gateway, file-indexer,
  camera-discovery, …) → green only when **all** report up. Extend the per-service
  `/health` pattern (`services/pm/main.py`, `services/routing/main.py`).

## Architecture rules

- Reuse the existing embedding index — do not stand up a second vector store.
- No `while True` for any poller; use the schedulers.
- Tour state is an explicit timestamp column.

## Dependencies

Tour blocked by setup state machine (`user_tour_completed` in `/setup/state`).
Help search depends on the existing file-indexer/embeddings. Health is standalone.

## Acceptance criteria

- Tour shows once, replayable from Help; flag persists per user.
- `/help/search` returns ranked local articles; offline-only.
- `/health` reflects real per-service status; footer turns green only when all up.

## References

`onboarding-handoff/src/OnbTourHelp.jsx`; `apps/web-dashboard/src/components/help/`
(`WizardReplay.tsx`, `/help` page); `services/file-indexer/`, `services/ai-gateway/`;
`services/pm/main.py`; `FEATURES.md §10`.

---

## Implementation notes (PR #382, stacked on #372)

### What shipped

**Tour** — `apps/web-dashboard/src/app/tour/page.tsx` +
`src/components/tour/ProductTour.tsx`. A five-step full-screen post-setup
walkthrough (welcome + the four privacy-positioning beats, same offline-first
copy as `WizardReplay`). Skippable; the active step is persisted to
`localStorage` (`droplet-tour-step`) so a refresh mid-tour resumes. Completion
(finish **or** skip) calls `completeTour()` on the auth context →
`patchTourCompleted()` → `PATCH /api/setup/state { user_tour_completed: true }`
(orchestrator `markTourCompleted`, shipped in #372). `AuthGate`'s
`ready + tour pending → /tour` branch (the unwired NOTE from #372) is now live;
once the flag persists, the owner passes through to the dashboard. Replay is
the existing "How Droplet works" trigger on `/help`.

**Help search** — a search box on `/help` over a local, offline, in-repo index
(`src/lib/help-index.ts`) with a deterministic ranked token search
(title-weighted > keywords > body, AND semantics). Empty query keeps the
existing browse view; a query swaps to results that deep-link to the full
prose via `#anchor`. Every search offers **Ask Droplet AI**, which routes the
query into on-device chat via the existing `sessionStorage`
`droplet.pendingPrompt` handoff — no new endpoint.

**Health** — `apps/web-dashboard/src/app/health/page.tsx` +
`src/components/health/HealthStatusView.tsx`, reading the existing WARP-43
aggregate `GET /api/orchestrator/health` (`fetchSystemHealth`). Overall banner
is green **only** when the aggregate `status === "ok"`; per-service rows show
friendly labels, latency, up/down; uptime + version footer. Polls on the
orchestrator's 15s cadence. Linked from the sidebar (support/reference zone).

### ⚠ Flags — contract divergences from the draft above

1. **Tour state model — singleton, not per-user.** The draft specifies
   `POST /me/tour { completed: true }` + a per-user `User.tourCompletedAt`
   column. #372 already shipped the tour flag as
   `ApplianceSetup.userTourCompleted` (the singleton setup-state row) with the
   `PATCH /api/setup/state { user_tour_completed: true }` endpoint, and the
   AuthGate branch routes off `setupState.userTourCompleted`. This PR follows
   the shipped #372 mechanism rather than adding a parallel `/me/tour`
   per-user surface. **Consequence:** the tour is once-per-appliance, not
   once-per-user — fine for the single-owner first-run flow, but if "each
   family member sees the tour once" is required, that's a follow-up
   (per-user column + endpoint + AuthGate keyed on the user).

2. **Help search is a LOCAL index, not embedding-backed.** The draft wants
   `GET /help/search?q=` running semantic search over the Files/chat embedding
   store (file-indexer + ai-gateway `EmbedText`). That backend index does not
   exist for help content, and the draft's own architecture rules forbid
   standing up a second vector store. This PR ships the local index described
   above (searchable today, offline, zero new infra). The entry shape
   (`id`/`title`/`summary`/`keywords`) is the seed corpus + contract for the
   embedding-backed endpoint when it lands; the UI swaps `searchHelp` for the
   API call at that point. **Confirm the intended source** before building the
   `/help/search` backend.

3. **Health data source — reused, not invented.** The draft sketches a new
   aggregated `/health`. The existing WARP-43 `GET /api/orchestrator/health`
   already aggregates per-service status into `{ status, components[], uptime,
   version }` and is green only when every hard dependency is up — exactly the
   contract. Reused as-is; no new endpoint, no client-side re-derivation.
