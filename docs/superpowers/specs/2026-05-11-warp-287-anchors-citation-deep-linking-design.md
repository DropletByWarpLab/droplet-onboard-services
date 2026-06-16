# WARP-287 — Section anchors at chunk-write + citation deep-linking

**Status:** Design
**Date:** 2026-05-11
**Sibling of:** WARP-286 (hybrid retrieval, merged)
**Phase:** A (product), per E→C alternation
**FIPS:** Clean — no new crypto
**Touches retrieval SQL:** No — WARP-286 hybrid retrieval is untouched

---

## 1. Goal

Make RAG citations clickable and useful. Every chunk written from this point forward carries a structured `anchor` describing *where in the source file* it came from. The web-dashboard renders citation cards that open the right viewer at the right position — PDF at page N, audio/video at MM:SS, email at the cited part, archive at the cited member.

Today's citations are decorative: clicking one opens the raw file at position zero, and the user has to find the cited passage themselves. After this change, clicking lands them on it.

## 2. Scope

**In:**
- New `Anchor` discriminated-union type, single source of truth in JSON Schema, codegen to Pydantic + Zod/TS.
- Migration of all 8 extractors from `extract_text(path) -> str` to `extract_spans(path) -> list[Span]`. The 5 MVP extractors (PDF, audio, video, email, archive) produce real anchors. The 3 non-MVP extractors (DOCX, HTML, markdown) emit a single span with `anchor.kind == "none"`.
- Chunker migration: `chunk_spans(spans)` replaces `chunk_text(str)`. Chunks within a span inherit the span's anchor; the chunker never crosses spans.
- Orchestrator hit-shaping (`file-search.service.ts`) surfaces `metadata.anchor` as a top-level `anchor` field on `/api/llm/chat` citations and `/knowledge` hits, with Zod validation.
- Web-dashboard `<CitationCard>` component family that dispatches on `anchor.kind` and renders the appropriate viewer.
- Admin re-index route (`POST /api/admin/files/:id/reindex`, RBAC + `require-recent-mfa`) with a "Re-index" button on the file detail page.
- Complete deletion of `extract_text` and `chunk_text` symbols — no parallel codepaths.

**Out:**
- Real anchors for DOCX, HTML, markdown extractors (deferred; they ride the new interface but emit `kind: "none"`).
- One-shot backfill / migration of existing chunks (legacy chunks render as "open file" until the admin re-index route is used).
- Changes to the WARP-286 retrieval SQL (deliberately untouched).
- Changes to the embedder, vector store, or BM25 index.

## 3. Architecture

```
extractor (Python)      →  list[Span(text, anchor)]
chunker (Python)        →  list[Chunk(text, anchor)]   -- chunks within spans, never across
file-indexer DB write   →  INSERT INTO file_content_chunks (..., metadata)
                            with metadata.anchor populated
vector + lexical search →  unchanged (WARP-286 retrieval untouched)
orchestrator hit shape  →  { ..., anchor?: Anchor }    -- top-level field
web-dashboard           →  <CitationCard anchor={...}/> -- dispatches on anchor.kind
```

**Schema source of truth:** `schemas/anchor.schema.json` (JSON Schema 2020-12). Codegens to:

- `services/file-indexer/anchor_schema.py` (Pydantic v2 models)
- `packages/shared-types/src/anchor.ts` (Zod + inferred TS types)

Codegen runs as `npm run gen:anchor-schema` and is checked in. Drift is caught by a unit test that re-runs codegen into a temp dir and diffs.

**No new services, no new tables.** `anchor` lives inside the existing `file_content_chunks.metadata` JSONB column.

## 4. The `Anchor` discriminated union

Five member kinds, including an explicit `none` sentinel for legacy and non-MVP cases.

```jsonc
// pdf-page: anchors a chunk to a 1-indexed PDF page
{ "kind": "pdf-page", "page": <int, >= 1> }

// media-timestamp: anchors a chunk to a time range in audio or video (ms)
{ "kind": "media-timestamp", "startMs": <int, >= 0>, "endMs": <int, > startMs> }

// email-part: anchors a chunk to a specific MIME part of a message
{ "kind": "email-part", "messageId": <str>, "partIndex": <int, >= 0> }

// archive-member: anchors a chunk to a member file inside an archive,
// with optional recursion into a typed inner anchor.
{ "kind": "archive-member",
  "member": <str>,                 // path within the archive
  "innerAnchor": <Anchor | null> } // recursion; capped at MAX_ARCHIVE_ANCHOR_DEPTH = 3

// none: explicit "no positional info" sentinel.
// Used by: legacy chunks (metadata.anchor missing), non-MVP extractors,
// and per-span fallback when an extractor can't determine position.
{ "kind": "none" }
```

The schema enforces:
- `pdf-page.page >= 1`.
- `media-timestamp.endMs > startMs`.
- `archive-member` recursion is bounded by `MAX_ARCHIVE_ANCHOR_DEPTH = 3`, enforced both at the writer (extractor stops recursing, emits `innerAnchor: null` with a log) and at the read-time validator (deeper anchors fail Zod validation, hit returns `anchor: null`). Schema is expressed recursively; the depth cap is a runtime invariant, not a schema unroll.

## 5. Components

| # | File | Status | Responsibility |
|---|---|---|---|
| 1 | `schemas/anchor.schema.json` | new | Single source of truth for the discriminated union. |
| 2 | `services/file-indexer/anchor_schema.py` | generated, checked in | Pydantic v2 models for write-time validation. |
| 3 | `packages/shared-types/src/anchor.ts` | generated, checked in | Zod + TS types for read-time validation and dashboard props. |
| 4 | `services/file-indexer/extractors/{pdf,audio,video,email,archive}.py` | modified (real anchors) | Each MVP extractor produces `list[Span]` with the appropriate `Anchor` kind per span. |
| 5 | `services/file-indexer/extractors/{docx,html,markdown}.py` | modified (interface only) | Migrated to `extract_spans`, return a single `Span(text, anchor=Anchor(kind="none"))`. |
| 6 | `services/file-indexer/chunker.py` | modified | New entry point `chunk_spans(spans)`. Old `chunk_text(str)` and `extract_text(...)` deleted. |
| 7 | `services/file-indexer/db_writer.py` | modified (one statement) | Serialize `chunk.anchor` into `metadata.anchor` on INSERT. |
| 8 | `apps/orchestrator/src/services/file-search.service.ts` | modified | Hit-shaping surfaces `anchor` as a top-level field, validates via Zod. |
| 9 | `apps/orchestrator/src/routes/admin-files.ts` | modified | New `POST /api/admin/files/:id/reindex` endpoint. RBAC + `require-recent-mfa`. |
| 10 | `apps/web-dashboard/src/components/citations/` | new directory | `CitationCard` + per-kind child components. |
| 11 | `apps/web-dashboard/src/app/files/[id]/page.tsx` | modified | "Re-index" button wired to the admin endpoint, with MFA flow. |
| 12 | `apps/web-dashboard/src/app/chat/page.tsx` | modified | Citations under assistant messages render via `<CitationCard>`. |
| 13 | `apps/web-dashboard/src/app/knowledge/page.tsx` | modified | Search hits render via `<CitationCard>`. |

**Dead-code policy:** This PR deletes `extract_text` and `chunk_text` everywhere they appear. The plan's final task includes a repo-wide grep on both symbol names to confirm zero remaining callers. Same grep on the new admin endpoint's handler name to confirm at least one UI caller exists.

## 6. Data flow

### 6.1 PDF citation, end to end

```
1. Ingest:
   pdf.py reads "compliance-runbook.pdf" (12 pages)
     → list[Span] of length 12, each carrying {kind: "pdf-page", page: N}
   chunker.chunk_spans(spans) splits within each span; chunks inherit anchor
   db_writer INSERTs rows with metadata.anchor populated

2. Search (GET /api/knowledge/search?q=TPM+provisioning):
   file-search.service.ts runs WARP-286 hybrid retrieval
   Hit-shaping reads metadata.anchor, validates via Zod, surfaces as top-level `anchor`
   Response body: [{ fileId, chunkText, score, anchor: {kind: "pdf-page", page: 4}, ... }, ...]

3. Render (web-dashboard /knowledge page):
   <CitationCard hit={hit}/> switches on hit.anchor.kind === "pdf-page"
   → <PdfCitation page={4} fileId={...} />
   → renders iframe pointing at /files/:id#page=4
   → browser PDF viewer lands on page 4
```

### 6.2 Audio citation in chat

```
1. Ingest:
   audio.py runs Whisper on the file
     → segments with start/end seconds become Spans with
       {kind: "media-timestamp", startMs, endMs}

2. Chat (POST /api/llm/chat):
   Agent calls search_knowledge → hybrid retrieval returns hits with anchors
   Response: { message: "...", citations: [{fileId, chunkText, anchor: {...}, ...}] }

3. Render (web-dashboard /chat page):
   <MediaCitation startMs={1247400} endMs={1253900} fileId={...} mimeType="audio/mpeg"/>
   → renders <audio controls src="/files/:id"/>
   → on mount: audio.currentTime = startMs / 1000
   → user clicks play, hears the cited passage from the right moment
```

### 6.3 Archive recursion

```
.zip containing audit.pdf, cite on page 12:

  {kind: "archive-member",
   member: "docs/audit.pdf",
   innerAnchor: {kind: "pdf-page", page: 12}}

<ArchiveCitation/> opens a drawer listing members. The audit.pdf row is
highlighted. Clicking it renders a nested <PdfCitation page={12}/> in the
drawer. Depth is capped at 3; deeper nesting truncates innerAnchor to null
with a log line.
```

## 7. Error handling

### Ingestion (extractor-side)
- **Partial-file failure:** per-span exceptions are caught; log `extractor.span.failed` with `{fileId, kind, position}` and continue. Other spans from the same file still index.
- **Missing positional metadata:** span falls back to `Anchor(kind="none")` for that span only, with a `extractor.anchor.degraded` log entry.
- **Archive recursion failure:** outer `archive-member` anchor is still emitted; `innerAnchor` is null. One log entry, no crash.
- **Recursion cap:** `MAX_ARCHIVE_ANCHOR_DEPTH = 3` named constant. Beyond depth 3, `innerAnchor` is null with a log.

### Validation (boundary checks)
- **Write-time:** chunker constructs `Chunk` via `Chunk.model_validate(...)`. Malformed anchors raise; the file fails to index (loud on purpose — bad anchors must never reach the DB).
- **Read-time:** orchestrator hit-shaping runs `AnchorSchema.safeParse(...)`. On failure: log `anchor.validation.failed` with `{chunkId, fileId, rawAnchor}`, return `anchor: null` on the hit, do not drop the hit.
- **Schema drift:** `schemas/__tests__/codegen-drift.test.ts` re-runs codegen and diffs against checked-in outputs. CI fails on drift.

### Runtime UI (dashboard-side)
- **File deleted between search and click:** viewer route 404s; card shows an inline "This file is no longer available" state.
- **Unknown anchor kind** (deploy skew): `<CitationCard>` falls back to `<FileCitation>`. TS exhaustiveness check inside the component guarantees a compile error in the normal path; the runtime fallback covers the skew window only.
- **Media viewer can't seek:** card degrades to play-from-start with a "Couldn't seek to MM:SS" toast.

### Operational (admin re-index path)
- **MFA stale:** route returns 401 with `WWW-Authenticate: MFA-Required`. Dashboard catches the header, triggers the MFA flow (existing convention from WARP-230 reseal), retries on success.
- **Re-index mid-failure:** chunks are replaced atomically in a single transaction (`DELETE WHERE file_id = $1` + bulk `INSERT`). On any error, the transaction rolls back; old chunks are preserved. Response is 500 with a structured error body.
- **Concurrent indexing:** route acquires `pg_advisory_xact_lock(hashtext(file_id))`. If the lock is held, 409 Conflict with "indexing in progress, try again in a moment".
- **Non-admin caller:** 403, RBAC check.

## 8. Backwards compatibility

- Legacy chunks (`metadata.anchor` missing) flow through hit-shaping unchanged: orchestrator returns `anchor: null` (not as an `anchor.kind == "none"` object — explicit null distinguishes "legacy row" from "extractor said no anchor", useful for future analytics).
- Dashboard renders `<FileCitation>` for both `anchor: null` and `anchor.kind == "none"` — same component, same UX as today.
- The admin `POST /api/admin/files/:id/reindex` endpoint is the user-facing path to upgrade legacy chunks to anchored ones, one file at a time.

## 9. Testing

Five layers, scaled to where bugs live.

1. **Schema codegen drift** (unit): `schemas/__tests__/codegen-drift.test.ts` re-runs codegen and diffs against checked-in `anchor_schema.py` + `anchor.ts`. Fails on drift.
2. **Per-extractor unit tests** (Python): one per MVP extractor (`test_pdf.py`, `test_audio.py`, `test_video.py`, `test_email.py`, `test_archive.py`) using small hand-crafted fixtures. Plus `test_archive_depth.py` (recursion stops at depth 3, no stack blow-up) and `test_extractor_partial_failure.py` (PDF where page 5 raises → spans for 1-4 and 6-N returned, log captured).
3. **Chunker contract** (Python): `test_chunker_anchors.py` — chunks within a span inherit anchor; chunks never cross spans; long span produces multiple chunks all with the same anchor; `kind: "none"` propagates; malformed anchor raises at write time.
4. **Orchestrator hit-shaping** (TS): `file-search.anchor.test.ts` — valid anchor surfaces as top-level field; malformed anchor returns `anchor: null` with log; `undefined` anchor returns `anchor: null` cleanly; both `searchHybrid` and `searchByVector` shaped through the same path.
5. **End-to-end integration** (TS, gated lane): `tests/rag-anchors.integration.test.ts` joins the `rag-tests` workflow. Drop fixture PDF + audio + email + zip into Nextcloud; wait for the indexer; query via `POST /api/llm/chat`; assert `citations[]` carry the expected anchor shape per kind; assert a manually-inserted legacy chunk comes back with `anchor: null`.

**Admin route tests** (TS): `admin-files.reindex.test.ts` — 401 on stale MFA, 200 on fresh MFA, 500 + rollback on extractor failure, 409 on advisory-lock conflict, 403 on non-admin caller.

**Dashboard component tests** (TS + RTL): `CitationCard.test.tsx` — each `kind` renders the expected child; unknown `kind` falls back to `<FileCitation>`; `<PdfCitation page={4}>` produces iframe `src` containing `#page=4`; `<MediaCitation startMs={1247400}>` sets `currentTime = 1247.4` (mocked); `<ArchiveCitation>` with `innerAnchor` recurses correctly.

**Not tested here:**
- WARP-286 retrieval quality — already covered by `tests/retrieval-eval/`; not regressed because we don't touch retrieval SQL.
- Whisper transcription quality — orthogonal; fixtures use pre-recorded segments.
- Browser-native PDF rendering — we test the `#page=N` fragment, not what the browser does with it.

## 10. Constraints honored

- **FIPS clean:** no new crypto. Anchors are plain JSON; the only hashing involved is the existing content-hash on chunks.
- **WARP-286 retrieval untouched:** retrieval SQL does not read `metadata.anchor`; we only add a column read on the response-shaping side.
- **No `while True` scheduling:** re-index runs synchronously inside the admin route's request lifecycle (per the bulk-orchestration story being C — admin-triggered, not background). No background sweep is introduced.
- **No guessing:** anchors are explicit columns inside JSONB, not derived from absence. Legacy null vs `kind: "none"` is a deliberate distinction with stated rationale.
- **Functionality-first naming:** no `phaseN`; names describe what they do (`extract_spans`, `chunk_spans`, `Anchor`, `CitationCard`, `PdfCitation`, `MediaCitation`, etc.).

## 11. Open questions

None. All five design sections were locked with the user during brainstorming.

## 12. Phasing

Single PR. Commit ordering inside the PR (one commit per task, per the writing-plans skill):

1. Add `schemas/anchor.schema.json` + codegen tooling (`npm run gen:anchor-schema`) + drift test.
2. Generate and check in `anchor_schema.py` + `anchor.ts`.
3. Migrate all 8 extractors to `extract_spans`. MVP-5 produce real anchors; non-MVP-3 emit `kind: "none"`. Delete `extract_text` callers.
4. Migrate chunker to `chunk_spans`. Delete `chunk_text`.
5. Wire `db_writer.py` to serialize `chunk.anchor`.
6. Orchestrator hit-shaping: surface `anchor` on `searchHybrid` + `searchByVector` paths with Zod validation.
7. Admin re-index route + tests.
8. `<CitationCard>` component family + per-kind viewer components + tests.
9. Dashboard wiring: `/chat`, `/knowledge`, file-detail "Re-index" button.
10. End-to-end integration test (`rag-anchors.integration.test.ts`) joins the `rag-tests` workflow.
11. Repo-wide grep for `extract_text` + `chunk_text` (must return zero); grep for the admin endpoint's handler name (must return >= 1 UI caller). Documentation pass.
