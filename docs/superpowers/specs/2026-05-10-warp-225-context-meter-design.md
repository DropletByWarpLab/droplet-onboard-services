# WARP-225 — Dashboard context-meter (per-user)

**Status:** Design approved 2026-05-10 across 3 sections.

**Why this is investor-grade:** the `/context` page is a primary credibility-demonstration surface — it visualizes density of capabilities (multiple extractors, every source type), real-time-feeling updates, and a clear "look how much your AI knows" narrative. Polish bar is intentional, not gold-plating.

## Goals

1. Every user sees how much retrievable context their assistant has — file counts, chunk counts, queued/failed status, distribution by source.
2. **Compact home-widget** (always visible) gives passive awareness; deep-dive **`/context` page** gives the full analytics story.
3. Status callouts are actionable — "queued" and "failed" items are clickable with one-click "Run now" / "Retry" affordances.
4. Numbers are computed cheaply (DB aggregates + Redis cache) so the dashboard stays snappy.
5. Per-user RBAC strict — no cross-user leakage at SQL or app level.

## Locked decisions from brainstorm

| Q | Decision |
|---|---|
| Surface | **D** — combination: home-page widget + dedicated `/context` page |
| Depth | **C** — full analytics: stat cards + donut + bytes-by-source + sparkline + per-extractor pipeline health + drill-down lists |
| Visual treatment | Recharts + framer-motion. Animated counters, staggered reveals, skeleton loading, semantic 4-color palette |
| Polish bar | Investor-grade — this is the WoW factor |

## Non-goals

- Admin-wide cross-user view (separate ticket if needed).
- Storage breakdown in the abstract sense (we show "indexed text bytes", not "disk used"). Disk-usage UI is a different surface (devices/settings).
- Embedding-quality / retrieval-relevance metrics (Phase B activity graph in design doc — not WARP-225).
- Real-time push (SSE/WebSocket). 30s polling + animated counters is the visual experience target.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ apps/web-dashboard                                         │
│   /         <ContextWidget />     home-page tile           │
│   /context  full analytics page                            │
└────────────┬───────────────────────────────────────────────┘
             │ both call
             ▼
┌────────────────────────────────────────────────────────────┐
│ Orchestrator (Express)                                     │
│   GET  /api/me/context-stats             (compact summary) │
│   GET  /api/me/context-stats/full        (deep-dive page)  │
│   GET  /api/me/context-stats/queued      (drill-down)      │
│   GET  /api/me/context-stats/failed      (drill-down)      │
│   POST /api/me/context-stats/failed/:id/retry              │
│                                                            │
│   ├── auth: existing middleware, req.user.username         │
│   ├── RBAC: WHERE userId = $1 baked into every query       │
│   ├── Redis cache: per-user keys, 30s/60s/5min TTL         │
│   ├── MQTT cache invalidation on BrainMemoryItem changes   │
│   └── Postgres aggregates                                  │
└────────────┬───────────────────────────────────────────────┘
             │
             ▼
   Postgres: BrainMemoryItem + FileContentChunk
   New SQL function: mime_to_category(text) → enum
```

**Polling cadence:** client polls `/api/me/context-stats` every 30s on home page (lightweight); `/api/me/context-stats/full` every 60s on the deep-dive page. `Last-Modified`-style conditional response so unchanged data returns 304.

**Cache invalidation:** file-indexer publishes `droplet/context-stats/invalidate` MQTT message on every `BrainMemoryItem` insert/update with the affected `userId`. Orchestrator subscribes and `DEL`s `context-stats:<userId>:*` keys.

## Widgets + visual treatment

### Home page — `<ContextWidget />`

```
┌─────────────────────────────────────────────┐
│  YOUR AI's CONTEXT                       ▸  │
│  ┌──────────────┐                           │
│  │              │  847 files indexed        │
│  │  ◐ donut     │  142,309 chunks searchable│
│  │              │  ✓ All ready              │
│  └──────────────┘  (or ⚠ 2 queued · 1 failed) │
│                                             │
│  📷 Photos · 🎙 Audio · 📄 Docs · ✉ Email     │
└─────────────────────────────────────────────┘
```

- Animated counter ticks (300ms ease-out) when polled data updates.
- Pulsing green "live" dot when polling is active.
- Click anywhere → `/context`.
- Source icons reuse the WARP-214 MIME icon set (Headphones / Film / Mail / FileArchive / FileText / Image), brightness-graded by chunk-share-of-total.
- Compact donut sized for a 320×140 tile.

### `/context` page

**Hero band:**
```
┌──────────────────────────────────────────────────────────────┐
│  YOUR AI KNOWS ABOUT YOU                                     │
│                                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                 │
│  │  847   │ │142,309 │ │   2    │ │   1    │                 │
│  │ FILES  │ │ CHUNKS │ │ QUEUED │ │ FAILED │                 │
│  └────────┘ └────────┘ └────────┘ └────────┘                 │
│                                                              │
│  ▁▂▃▅▆▇█▇▆▅▃▂▁  Indexing throughput · last 7 days            │
└──────────────────────────────────────────────────────────────┘
```

Stat cards stagger-reveal on mount (80ms each). Sparkline is a smooth area chart with gradient fill.

**Middle row (two columns):**
- **Coverage donut** (left): source-type breakdown. Hover/tap a slice → highlight + count + bytes.
- **Bytes-by-source horizontal bar chart** (right): same data, indexed-text-bytes lens.

**Pipeline health grid:**
```
┌──────────────────────────────────────────────────────────┐
│  PIPELINE HEALTH                                         │
│  Audio (faster-whisper)    │  ✓ 22 files · avg 2.3s     │
│  Video (subs/frame OCR)    │  ✓ 8 files  · avg 14s      │
│  PDF                       │  ✓ 312 files · avg 0.8s    │
│  Image (Tesseract OCR)     │  ✓ 87 files · avg 1.1s     │
│  Email + nested            │  ✓ 1,247 messages          │
│  Archive                   │  ⚠ 1 failed · retry        │
│  HTML/Markdown/Text        │  ✓ 156 files · avg 0.2s    │
└──────────────────────────────────────────────────────────┘
```

Each row clickable → expands to a list of files for that extractor.

**Bottom — actionable callouts:**
- **Queued list** (only when count > 0): card with each queued item + reason ("audio file, scheduled for nightly transcription") + per-item "Run now" button → POST `/api/files/brain/:id/transcribe-now`.
- **Failed list** (only when count > 0): card with each failure + `failureReason` + "Retry" button → POST `/api/me/context-stats/failed/:id/retry`. Rate-limited to 3 per item per hour.
- **Recently indexed** (always shown): last 10 files added with relative timestamps ("3 minutes ago"), source icons, chunk counts.

### Visual choices

- **Charts:** `recharts` — Tailwind-friendly, low effort, good defaults.
- **Animations:** `framer-motion` for counter ticks, stagger reveals, hover micro-interactions.
- **Loading:** skeleton screens, never spinners.
- **Colors:** semantic 4-color palette — green (ready), amber (queued), red (failed), indigo (CTAs).
- **Typography:** big stat numbers in display weight; descriptive text in regular. Generous spacing.
- **Empty states:** zero files → renders an onboarding card ("Upload your first file to start building your context"), not empty cards.

## Data layer

### SQL queries

All `WHERE "userId" = $1` baked in. All indexed-friendly.

```sql
-- Stat cards
SELECT count(*) FROM "BrainMemoryItem"     WHERE "userId" = $1;
SELECT count(*) FROM "FileContentChunk"    WHERE "userId" = $1;
SELECT count(*) FROM "BrainMemoryItem"
       WHERE "userId" = $1 AND "status" = 'queued_for_transcription';
SELECT count(*) FROM "BrainMemoryItem"     WHERE "userId" = $1 AND "status" = 'failed';

-- 7-day sparkline
SELECT date_trunc('day', "indexedAt")::date AS day, count(*)
  FROM "BrainMemoryItem"
 WHERE "userId" = $1 AND "indexedAt" > NOW() - INTERVAL '7 days'
 GROUP BY day ORDER BY day;

-- Source-type donut + bytes breakdown — uses new SQL function mime_to_category(text)
SELECT mime_to_category("mimeType") AS category, count(*), sum("bytes")::bigint
  FROM "BrainMemoryItem" WHERE "userId" = $1 GROUP BY category;

-- Per-extractor pipeline health
SELECT metadata->>'extractor_name' AS extractor,
       count(DISTINCT "brainItemId") AS files,
       count(*) AS chunks
  FROM "FileContentChunk" WHERE "userId" = $1 GROUP BY extractor;

-- Per-extractor avg time-to-ready
SELECT mime_to_category("mimeType") AS category,
       avg(EXTRACT(EPOCH FROM ("indexedAt" - "createdAt"))) AS avg_seconds,
       count(*) AS files
  FROM "BrainMemoryItem"
 WHERE "userId" = $1 AND "indexedAt" IS NOT NULL
 GROUP BY category;

-- Drill-down: queued list
SELECT "id", "filename", "mimeType", "createdAt"
  FROM "BrainMemoryItem"
 WHERE "userId" = $1 AND "status" = 'queued_for_transcription'
 ORDER BY "createdAt" ASC;

-- Drill-down: failed list
SELECT "id", "filename", "mimeType", "failureReason", "lastAttemptedAt"
  FROM "BrainMemoryItem"
 WHERE "userId" = $1 AND "status" = 'failed'
 ORDER BY "lastAttemptedAt" DESC;

-- Recently indexed
SELECT "id", "filename", "mimeType", "indexedAt"
  FROM "BrainMemoryItem"
 WHERE "userId" = $1 AND "indexedAt" IS NOT NULL
 ORDER BY "indexedAt" DESC LIMIT 10;
```

Total cost on a 100k-chunk corpus per user: <300ms cold, <30ms cached.

### `mime_to_category()` SQL function

Maps MIME types to 8 categories: `audio | video | pdf | image | email | archive | text | other`. Created via Prisma migration. Unit-tested on the full WARP-201..208 MIME spectrum.

### Caching

| Key | TTL | Source |
|---|---|---|
| `context-stats:<userId>:summary` | 30s | stat cards + recently indexed |
| `context-stats:<userId>:full` | 60s | deep-dive aggregates |
| `context-stats:<userId>:queued` | 5min | queued drill-down |
| `context-stats:<userId>:failed` | 5min | failed drill-down |

Invalidation: file-indexer publishes `droplet/context-stats/invalidate` over MQTT on `BrainMemoryItem` insert/update with `{userId}`. Orchestrator subscribes and DELs `context-stats:<userId>:*`.

### Retry / "Run now" actions

- **Queued item → "Run now":** POST to existing `/api/files/brain/:id/transcribe-now` (already in WARP-218). No new endpoint.
- **Failed item → "Retry":** new endpoint `POST /api/me/context-stats/failed/:id/retry`. Flips status to `queued_for_transcription` + invokes transcribe-now. Inherits the 3-retries-per-hour cap from WARP-218 (`429 Retry-After` on cap exceeded).

## Phasing — single PR, ~8 commits

1. SQL: `mime_to_category()` function + Prisma migration. Unit tests on category mapping across all WARP-201..208 MIME types.
2. Service layer: `apps/orchestrator/src/services/context-stats.service.ts` with all aggregates + Redis cache wrapper. Unit tests against seeded DB.
3. Orchestrator routes: 5 endpoints (summary, full, queued, failed, retry). Auth + RBAC tests including cross-user isolation.
4. MQTT cache invalidation: file-indexer publishes `droplet/context-stats/invalidate`; orchestrator subscribes + DEL keys.
5. Web-dashboard deps: add `recharts` + `framer-motion`. Implement `<ContextWidget />` for the home page (compact tile + animated counters + click-through).
6. `/context` page + sub-components: StatCards, Donut, BytesBar, PipelineHealth, QueuedList, FailedList, RecentlyIndexed, Sparkline. With framer-motion animations + skeleton loading.
7. Empty states + nav link + relative timestamp helper.
8. Smoke tests (vitest) + visual snapshot baseline + RBAC isolation integration test.

Estimated: ~4 days of focused subagent work. Single PR.

## Error handling

| Failure | Behavior |
|---|---|
| Redis down | Aggregate queries run live (no cache). Warn-log on cache miss. |
| Postgres slow query | Query timeout 5s; UI falls to skeleton/error tile, never blocks page |
| MQTT broker down | Cache TTL still applies (60s); we eat 60s of staleness on writes |
| User has zero files | Empty-state card; no broken chart renders |
| Retry cap hit (429) | UI surfaces "Retry available in <X minutes>" inline |
| User's session expired | 401 from middleware → client redirects to login |

## RBAC + cross-user isolation test

Mandatory integration test:
- Seed 2 users, A and B. Each has 5 files.
- As user A, hit every endpoint.
- Assert: response counts only A's 5 files. No B file appears anywhere — not in the donut, not in pipeline health, not in queued/failed, not in recently indexed.
- As user A, attempt `POST /api/me/context-stats/failed/<B's-item-id>/retry` → 404 (no existence leak).

## Acceptance criteria

- Home-page `<ContextWidget />` renders for any user with ≥1 file. Compact (≤160px height), animated counter, click-through to `/context`.
- `/context` page renders all 8 visual elements (stat cards / sparkline / donut / bytes bar / pipeline health / queued / failed / recently indexed).
- Page load <500ms on warm cache, <1s on cold (single user, ~10k chunks).
- All 5 endpoints have RBAC tests including the cross-user isolation case above.
- `recharts` + `framer-motion` added as `apps/web-dashboard` deps.
- New `mime_to_category()` SQL function + Prisma migration applied.
- Cache invalidation works end-to-end: upload a file → MQTT fires → orchestrator drops cache → next poll shows fresh data within 30s.
- Failed-item retry path works: click retry → status flips to queued → transcribe-now triggers → status flips through indexing → ready.
- Empty state for users with zero files renders an onboarding card.
- All four PR-required CI lanes green.

## Out of scope (future tickets)

- Admin-wide cross-user view.
- Disk-usage breakdown (different surface).
- Retrieval-relevance / embedding-quality metrics (Phase B activity graph in design doc).
- SSE / WebSocket real-time push.
- Mobile-responsive layout (LAN browser is desktop).
- Per-user retention controls (covered by WARP-271).
