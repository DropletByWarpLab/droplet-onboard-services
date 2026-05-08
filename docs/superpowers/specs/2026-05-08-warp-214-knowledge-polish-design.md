# WARP-214 — `/knowledge` dashboard polish (Phase 2 follow-up)

**Status:** Design — pending user review
**Owner:** Brain memory team
**Date:** 2026-05-08
**Phase 2 reference:** [`docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md`](./2026-05-07-rag-phase-2-extractors-design.md)
**Ticket:** WARP-214
**Depends on:** WARP-218 (deferred ASR + daily transcription window) — for the `queued_for_transcription` state path to ever fire in a live stack
**Filed alongside:** WARP-218 (deferred-ASR plumbing), WARP-219 (adaptive scheduler, Phase 3 follow-up)

## 1. Goals

Polish the `/knowledge` dashboard surface so it renders the new MIME classes (audio/video/email/zip), the new ingestion states (`queued_for_transcription` / `indexing` / `ready` / `failed`), the source-channel provenance, and recursion breadcrumbs — without changing any extractor or backend logic.

This is intentionally a **frontend-only** scope. One narrow backend change: `apps/orchestrator/src/routes/files-knowledge.ts` includes `metadata.subtitle_source` and `metadata.chain` in the JSON response (the extractors already write these to `FileContentChunk.metadata`; the route just wasn't surfacing them).

## 2. Non-goals

- **No layout overhaul.** Tab structure, headers, empty states stay exactly as they are. Drop-in component swaps only.
- **No new MIME classes.** WARP-214 renders what Phase 2 ships. Adding new types belongs in their own tickets.
- **No "open the original file" inline preview.** Bigger feature; tracked separately if it ever comes up.
- **No analytics events.** Add later if we ship usage metrics.
- **No mobile-specific affordances.** Breadcrumb wraps, kebab works on touch — anything fancier is YAGNI.
- **No backend ingestion changes.** That's WARP-218's scope, not this one.

## 3. Architecture

```
┌─────────────────────────── /knowledge dashboard ───────────────────────────┐
│                                                                              │
│  RecentlyIndexedTab        SearchTab              BrainMemoryTab             │
│        │                       │                       │                     │
│        ▼                       ▼                       ▼                     │
│   each card / hit ────────────────────────► useBrainStatus(items)            │
│        │                                            │                        │
│   ┌────┴────┐                                       │  WS: droplet/files/   │
│   │  MIME   │                                       │   <userId>/brain/     │
│   │  icon   │   ◄── lib/mime-icons.ts               │   indexed             │
│   │         │                                       │                        │
│   │ Citation│                                       │  initial: GET         │
│   │ Chip    │   ◄── components/CitationChip.tsx     │   /api/files/brain    │
│   │         │                                       │                        │
│   │ Bread-  │   ◄── components/Breadcrumbs.tsx      ▼                        │
│   │ crumbs  │                                StatusChip.tsx                  │
│   │         │                                (queued/indexing/ready/failed) │
│   │ snippet │                                                                │
│   │         │                                                                │
│   │ size·dt │                                                                │
│   │ ASR pill│   ◄── components/SourceChannelBadge.tsx                       │
│   └─────────┘                                                                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**No new services, no new routes** (beyond the 1-line addition to `files-knowledge.ts`). All changes are in `apps/web-dashboard/src/`.

## 4. File structure

| Path | Status | Responsibility |
|---|---|---|
| `apps/web-dashboard/src/lib/mime-icons.ts` | **new** | Centralized MIME → `LucideIcon` mapping (Object-icon set: `Headphones`, `Film`, `Mail`, `FileArchive`, plus existing PDF/DOCX/image). One exported function `iconForMime(mime: string): LucideIcon`. |
| `apps/web-dashboard/src/components/CitationChip.tsx` | modify | Use `mime-icons.ts`. Add optional `metadata` prop carrying `subtitle_source`, `chain`, `status`. |
| `apps/web-dashboard/src/components/SourceChannelBadge.tsx` | **new** | Renders the "ASR" / "OCR" / "OCR · low confidence" / "frame OCR" pill from `metadata.subtitle_source` + extractor `warnings`. Returns `null` for native channels. |
| `apps/web-dashboard/src/components/Breadcrumbs.tsx` | **new** | Renders the chevron breadcrumb from `metadata.chain[]`. Each segment is a `<Link>` to the parent item. Returns `null` at depth 0. |
| `apps/web-dashboard/src/components/StatusChip.tsx` | **new** | Renders the `queued_for_transcription` / `indexing` / `ready` / `failed` pill on `BrainMemoryItemInfo`. Includes the discreet "Transcribe now" overflow action when status is queued (probes the WARP-218 route once at mount). |
| `apps/web-dashboard/src/lib/api.ts` | modify | Extend `BrainMemoryItemInfo` with `status`, `metadata`. Extend chunk responses with `metadata.subtitle_source`, `metadata.chain`. Add `transcribeNow(itemId)` helper. |
| `apps/web-dashboard/src/lib/hooks/useBrainStatus.ts` | **new** | Hybrid GET + WS hook. Initial state from `GET /api/files/brain`; flips on `droplet/files/<userId>/brain/indexed` MQTT events forwarded by the per-user WS bridge. 5-second poll fallback if WS is down. |
| `apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx` | modify | Slot `useBrainStatus` + `StatusChip` + `mime-icons`. No layout overhaul. |
| `apps/web-dashboard/src/app/knowledge/RecentlyIndexedTab.tsx` | modify | Slot `mime-icons` + `Breadcrumbs` + `SourceChannelBadge`. |
| `apps/web-dashboard/src/app/knowledge/SearchTab.tsx` | modify | Slot `mime-icons` + `Breadcrumbs` + `SourceChannelBadge`. |
| `apps/orchestrator/src/routes/files-knowledge.ts` | modify | Include `metadata.subtitle_source` and `metadata.chain` in `/recent` and `/search` JSON responses (extractors already write these to `FileContentChunk.metadata`; the route was filtering them out). |

**Test files** mirror the new components:
- `apps/web-dashboard/src/__tests__/lib/mime-icons.test.ts`
- `apps/web-dashboard/src/__tests__/components/SourceChannelBadge.test.tsx`
- `apps/web-dashboard/src/__tests__/components/Breadcrumbs.test.tsx`
- `apps/web-dashboard/src/__tests__/components/StatusChip.test.tsx`
- `apps/web-dashboard/src/__tests__/components/CitationChip.test.tsx` (extend existing)
- `apps/web-dashboard/src/__tests__/lib/hooks/useBrainStatus.test.ts`
- `apps/orchestrator/src/__tests__/files-knowledge.test.ts` (extend — assert metadata fields surface in response)

## 5. Visual decisions (locked via brainstorm)

### 5.1 MIME icons (Q1 — option A locked)

Object-icon set, distinct silhouettes that read at any size:

| MIME class | Lucide icon | Color (suggestion) |
|---|---|---|
| `audio/*` | `Headphones` | violet |
| `video/*` | `Film` | red |
| `message/rfc822`, `application/vnd.ms-outlook`, `application/x-msmail` | `Mail` | blue |
| `application/zip`, `application/x-tar`, `application/gzip`, `application/x-bzip2` | `FileArchive` | amber |
| Phase 1 (unchanged) | `FileText` (text/pdf/docx), image variant for `image/*` | inherit |
| Unknown | `FileText` (fallback) | inherit |

`mime-icons.ts` is the single source — every consumer imports `iconForMime(mime)`.

### 5.2 Status chip (Q2 — option C locked, with WARP-218 deferral)

Hybrid GET + WS for the per-item state. Four states:

| Status | Pill | Action |
|---|---|---|
| `queued_for_transcription` | "Queued for transcription · runs nightly" (subtle, gray) | overflow kebab → "Transcribe now" |
| `indexing` | "Indexing…" (animated dot, gray) | none |
| `ready` | no pill (the chip vanishes once ready — clean state) | open / search / delete |
| `failed` | "Failed" (red) + tooltip with `metadata.failureReason` | overflow → "Retry" |

The "Transcribe now" overflow is **discreet** — kebab menu, secondary action, not a primary affordance. Users are here for storage + AI first.

Forward-compat: unknown enum value renders a generic "Processing" pill so server-side enum changes can land before the dashboard knows about them.

### 5.3 Source-channel badge (Q3 — option B locked)

Bottom metadata row alongside size + date:

```
proposal.pdf
  "…the budget for q4 is one hundred thousand…"
  2.4 MB · Today, 2:30 PM · transcribed by ASR
```

Lower visual weight than a primary pill. Reads as additional context. Always visible when `subtitle_source` is present and "interesting":

| `metadata.subtitle_source` | Badge text |
|---|---|
| `"asr_transcript"` | `transcribed by ASR` |
| `"embedded"` (video subtitle stream) | `embedded subtitles` |
| `"frame_ocr"` (Phase 3) | `text from video frames` |
| Phase 1 image OCR with low-confidence warning | `OCR · low confidence` |
| Phase 1 image OCR (high confidence) | `OCR` |
| anything else / missing | nothing |

`SourceChannelBadge` returns `null` when nothing applies — no noise on PDF text / email body / plain text / DOCX.

### 5.4 Recursion breadcrumbs (Q4 — option A locked)

Chevron-joined segments showing the dispatch chain. Max 3 segments (depth-2 cap from the spec):

```
[archive icon] q1-stuff.zip › [mail icon] march.eml › [pdf icon] proposal.pdf
  "…the budget for q4 is one hundred thousand…"
  2.4 MB · Today · transcribed by ASR
```

Each segment is a `<Link>` to that item in `/knowledge` (clickable on touch — no hover-only). Wraps to a second line on narrow screens.

**Edge cases:**
- Depth-1 (just an email attachment, no zip): `[mail icon] march.eml › [pdf icon] proposal.pdf`
- Depth-0 (no recursion): no breadcrumb at all — just the icon + filename. 95% of files don't recurse, so this stays clean.

The breadcrumb data lives in `FileContentChunk.metadata.chain` as `{filename, mime, parentItemId?}[]`. Email + archive extractors already write parent metadata; this PR just makes sure the orchestrator response includes the field.

## 6. Data flow

### 6.1 Initial render

```
GET /api/files/brain                 ────────────────►  BrainMemoryTab
   ↓ orchestrator + Prisma                                  │
   { id, filename, mimeType, status, metadata, ... }[]      ▼
                                                       useBrainStatus
                                                       (seed state)
```

`useBrainStatus` keeps a `Map<itemId, BrainMemoryItemInfo>` keyed by `id`. Initial seed = the GET response.

### 6.2 Live updates

```
file-indexer publishes:
  droplet/files/<userId>/brain/indexed { itemId, status, reason? }
                          ↓ via existing per-user WS bridge
                          ▼
                     useBrainStatus
                     (merge by id; trigger re-render)
```

The MQTT topic + WS bridge already exist (WARP-203). The hook subscribes through whatever per-user WS abstraction the dashboard already uses (matches the pattern in `ChatMessage.tsx`). On reconnect, the hook re-fires the GET to reconcile any messages it missed.

### 6.3 Search hits + recently-indexed cards

```
GET /api/files/knowledge/{recent,search}
   ↓ orchestrator (1-line change to include metadata.{subtitle_source, chain})
   { hits: [{ path, score, snippet, source, metadata: {...} }] }
                          ↓
                  RecentlyIndexedTab / SearchTab
                          ↓
              MIME icon · CitationChip(filename) · Breadcrumbs(chain) · snippet
              ────────────────────────────────────────────────────────────────
              size · date · SourceChannelBadge(subtitle_source, warnings)
```

`metadata` flows from the extractor → `FileContentChunk.metadata` (jsonb, already exists) → orchestrator response → dashboard. No schema changes needed.

## 7. Error handling

| Failure | Behavior |
|---|---|
| `GET /api/files/brain` returns 500 | `BrainMemoryTab` shows the existing empty-state with a one-line retry CTA. Same as today. |
| WS bridge disconnects | `useBrainStatus` falls back to a 5-second poll on `GET /api/files/brain` until WS reconnects. Logs once at info level. |
| `metadata.chain` is malformed | `Breadcrumbs` returns `null`. Card still renders with just the leaf icon + filename. Logged once via the existing dashboard error reporter. |
| `subtitle_source` is an unrecognized string | `SourceChannelBadge` returns `null`. Same graceful degrade. |
| `status` is an unrecognized enum value | `StatusChip` renders generic "Processing" pill. Logs once. Server-side enum changes can land before the dashboard knows about them. |
| `POST /api/files/brain/:itemId/transcribe-now` returns 404 (WARP-218 not merged) | Overflow action grays out with tooltip "Manual transcription not available yet". Feature-detected via a probe at mount; cached for the session. |

**Optimistic UI:** none. Every state change comes from the server. WS bridge is fast enough that optimistic updates would just complicate reconciliation.

## 8. Testing

### 8.1 Unit tests in `apps/web-dashboard/src/__tests__/`

- `lib/mime-icons.test.ts` — every MIME class returns the correct lucide icon. Unknown MIME falls back to `FileText`. ~15 cases via `it.each`.
- `components/SourceChannelBadge.test.tsx` — `subtitle_source = "asr_transcript"` → "transcribed by ASR" badge; `"embedded"` → "embedded subtitles" badge; OCR-with-low-confidence warning → "OCR · low confidence"; missing metadata → null. 6 cases.
- `components/Breadcrumbs.test.tsx` — depth-0 → null; depth-1 → 2 segments + 1 chevron; depth-2 → 3 segments + 2 chevrons. Each segment is a `Link`. Malformed `chain` → null + console.warn fired once. 5 cases.
- `components/StatusChip.test.tsx` — each enum value renders the right pill + the "Transcribe now" overflow only on `queued_for_transcription`. Forward-compat unknown enum → "Processing" pill. 6 cases.
- `lib/hooks/useBrainStatus.test.ts` — initial seed from GET; WS message merges by id; WS disconnect triggers 5-sec poll; reconnect cancels poll. 4 cases. Mock the WS using the same pattern as the existing `useChat` tests.
- `components/CitationChip.test.tsx` — extend with `metadata.chain` rendering. 2 new cases.

### 8.2 Orchestrator test (one)

- `apps/orchestrator/src/__tests__/files-knowledge.test.ts` — extend to assert that `metadata.subtitle_source` and `metadata.chain` survive the route's serialization. 1-2 cases.

### 8.3 Integration tests

None new. Existing dashboard test stack (vitest + jsdom + msw) covers everything.

### 8.4 Manual smoke (post-build)

Per option A from the brainstorm — final smoke runs at the END of WARP-214, not before:

1. `./scripts/test-rag.sh` — boots Compose with the test override (no auth).
2. Drop a `.zip` containing `march.eml` containing `proposal.pdf`.
3. Hit `/knowledge`. Verify the search hit on the inner PDF shows the chevron breadcrumb `q1-stuff.zip › march.eml › proposal.pdf`.
4. Upload an audio file. Verify the chip renders the right state given whether WARP-218 is merged (queued or indexing).
5. (If WARP-218 is merged) click kebab → "Transcribe now". Verify chip flips through `indexing` → `ready`.

Document the result in the PR body, not in a separate test file.

## 9. Phasing & dependencies

**Single PR.** ~9 files touched, ~600 LoC including tests. Estimated 4-6 hours of agent time end-to-end.

**Blocks on:** WARP-218 (deferred ASR + daily transcription window) — for the `queued_for_transcription` state path to actually fire in a live stack. The rendering is independent and can land first; WARP-218 just makes it visible.

**Does NOT block:** anything in Phase 3. WARP-207..213 can land in any order after this.

## 10. Open questions

None. All four design questions resolved via the brainstorm:

- Q1 MIME icons → Option A (Headphones / Film / Mail / FileArchive)
- Q2 status chip → Option C (hybrid GET + WS), with deferred ASR scope split into WARP-218 + WARP-219
- Q3 source-channel badge → Option B (bottom metadata row)
- Q4 recursion breadcrumbs → Option A (chevron breadcrumbs, depth-2 max)
