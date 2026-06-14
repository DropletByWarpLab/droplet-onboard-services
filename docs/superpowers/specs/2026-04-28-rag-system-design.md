# Spec — RAG System (Phase 1: Files-as-Knowledge)

**Date:** 2026-04-28
**Status:** Draft for review
**Parent:** GTM M3.3 (Photo / file indexing); see `services/file-indexer/` (existing skeleton).
**Tickets:** [WARP-201](https://warp-lab.atlassian.net/browse/WARP-201) → [WARP-206](https://warp-lab.atlassian.net/browse/WARP-206) (Phase 1); [WARP-197](https://warp-lab.atlassian.net/browse/WARP-197) → [WARP-200](https://warp-lab.atlassian.net/browse/WARP-200) (Phase 2 deferred extractors).

---

## 1. Context

The Droplet appliance already runs `services/file-indexer/` — a Python service with a filesystem watcher, a token-window chunker, a gRPC client to ai-gateway's `EmbedText`, and pgvector inserts via the existing `FileContentChunk` Prisma model. The bones of a RAG system are in place.

The gaps:

- `services/file-indexer/extractors/__init__.py` is **empty**. The watcher runs but only plain-text files actually get parsed; PDFs, DOCX, images, etc. are silently skipped.
- `packages/tools-core/src/handlers/files/search-content.ts` (the LLM-side query tool) returns `EMBEDDING_UNAVAILABLE` because nothing wires `ctx.embedText` in the orchestrator's MCP child.
- There's no chat-attachment surface — users can drop files in Nextcloud, but there's no in-conversation "give my AI this file" flow.
- There's no dashboard surface for browsing what's been indexed or searching across it.

This spec lights up the existing skeleton, adds a separate "brain memory" tier for chat-attached content, surfaces both via the LLM (agentic retrieval through the existing MCP tool) and the dashboard, and ships an end-to-end live integration test that proves the full path works.

## 2. Goals

- Drop a file (PDF, DOCX, image with text, plain text/code/HTML) into Nextcloud → it gets indexed automatically and is retrievable by the LLM and the dashboard within ~minutes.
- Drop a file in a chat conversation → it lands in a separate per-user "brain memory" volume external to Nextcloud, gets indexed the same way, and is exportable as a zip on demand.
- The LLM, when asked something file-related, retrieves relevant chunks via the existing MCP `search_content` tool and answers with citations (`{source, path, score, snippet, pageNumber?}`).
- Dashboard `/knowledge` view: recently-indexed list, search box, brain-memory tab with delete + export affordances.
- Per-user RBAC throughout — user A never sees user B's chunks or brain-memory items.
- Every new HTTP endpoint lands with both a unit test AND a **live integration test** that boots the relevant compose services and asserts end-to-end behavior.

## 3. Non-goals (Phase 1)

- **Audio transcription** (voice memos, podcasts) — deferred to [WARP-197](https://warp-lab.atlassian.net/browse/WARP-197). Whisper has real CPU/GPU trade-offs that warrant their own scoping.
- **Video extractors** (frame OCR + transcription) — [WARP-198](https://warp-lab.atlassian.net/browse/WARP-198). Depends on audio.
- **Email parsing** (`.eml`/`.msg`) — [WARP-199](https://warp-lab.atlassian.net/browse/WARP-199). Multipart/threading/encoding chaos warrants its own focused implementation.
- **Archive recursion** (`.zip`/`.tar`/`.7z`) — [WARP-200](https://warp-lab.atlassian.net/browse/WARP-200). Bomb-proofing + nested citation paths warrants its own scoping.
- **Auto-inject classifier** (RAG mode C) — Phase 2. v1 is purely agentic via the MCP tool; we ship the auto-inject "boost" only after we've measured how reliably small models call the tool on their own.
- **Cross-encoder reranker** — Phase 2 if retrieval quality on real-user data is poor.
- **Per-conversation retrieval scoping** — Phase 2.
- **Synthetic-eval harness, retrieval-quality benchmarks, latency P50/P95** — Phase 2.

## 4. Architecture

```
                              ┌─────────────────────────────────────────────┐
                              │           Dashboard (Next.js)               │
                              │   ┌──────────┐    ┌──────────────────────┐  │
                              │   │ /chat    │    │ /knowledge           │  │
                              │   │ + drop-  │    │ recently / search /  │  │
                              │   │   zone   │    │ brain memory         │  │
                              │   └────┬─────┘    └──────────┬───────────┘  │
                              └────────┼─────────────────────┼──────────────┘
                                       │                     │
            POST /api/files/brain/upload│                     │ GET /api/files/knowledge/recent
                                       ▼                     ▼ GET /api/files/knowledge/search
                              ┌────────────────────────────────────────┐
                              │         Orchestrator (Express)          │
                              │   files-brain.routes  files-knowledge   │
                              │   .routes      file-search.service      │
                              │     │                │                  │
                              │     ▼                ▼                  │
                              │  /data/brain-       pgvector cosine     │
                              │  memory/<userId>/   over FileContentChunk│
                              │  + BrainMemoryItem  (existing)          │
                              │  Prisma manifest                        │
                              └────────────┬───────────────────────────┘
                                           │
                                           │ embedText() — gRPC to ai-gateway
                                           ▼
                              ┌────────────────────────────────────────┐
                              │        ai-gateway (FastAPI)            │
                              │   InferenceServiceStub.EmbedText (gRPC)│
                              └────────────────────────────────────────┘

       ┌──────────────────────┐                                ┌──────────────────────┐
       │ Nextcloud watcher    │                                │ Brain ingest pipeline│
       │ (existing service —  │                                │ (NEW — same shape)   │
       │  empty extractors    │                                │                      │
       │  filled in by RAG-1) │                                │ Triggered by upload  │
       │                      │                                │ → MQTT subscribe →   │
       │ inotify on /data/nc  │  ←  shared extract+chunk+embed →  → extract           │
       │  → extract           │                                │  → chunk             │
       │  → chunk             │                                │  → embed (gRPC)      │
       │  → embed (gRPC)      │                                │  → upsert pgvector   │
       │  → upsert pgvector   │                                │    (source=brain)    │
       │    (source=nextcloud)│                                └──────────────────────┘
       └──────────────────────┘

LLM-side retrieval (agentic, v1):
  Dashboard chat → /api/llm/chat → orchestrator agent loop
  → MCP tools (search_content, list_recent_files) call back into orchestrator
  → file-search.service runs cosine on FileContentChunk filtered by userId
  → returns {source, path, chunkIdx, score, snippet, pageNumber?} per hit
  → agent formats answer with citation chips
```

**Three new components, three reused.**
- New: brain ingest pipeline (mirrors existing watcher), `BrainMemoryItem` Prisma model + per-user volume + manifest, dashboard `/knowledge` view, brain-upload + export + delete routes, embedding TS gRPC client + ToolContext wiring.
- Reused: `services/file-indexer/chunker.py`, `services/file-indexer/embedder.py`, pgvector store, ai-gateway `EmbedText` RPC, existing `search_content` + `list_recent_files` MCP tools (which become live once `embedText` is wired).

## 5. Extractor architecture

```
services/file-indexer/extractors/
  __init__.py
  registry.py           # MIME → extractor dispatch; size + char caps
  text.py               # txt, md, csv, code, html (readability-lxml)
  pdf.py                # pypdf
  docx.py               # python-docx
  image.py              # pytesseract + Pillow
```

**`ExtractedDoc` shape (returned by every extractor):**

```python
class ExtractedDoc(TypedDict):
    text: str                      # canonical UTF-8 text fed to chunker
    page_breaks: list[int]         # offsets where source pages break (PDF, DOCX) — for citation precision
    language: str | None           # detected via langdetect; optional
    metadata: dict                 # title, author, page_count, word_count, extractor_name, extractor_version
    warnings: list[str]            # e.g. ["low_confidence_ocr_page_3"]
```

**Dispatch rules:**
- **Skip if too big.** Files over `MAX_INDEX_BYTES` (default `50_000_000`) skip with `reason="oversized"` recorded in indexer logs (no DB write). Avoids OOM on the inference host.
- **Truncate-and-warn if too long.** Texts over `MAX_INDEX_CHARS` (default `5_000_000`) truncate with a warning. A 1000-page PDF still indexes the first ~700 pages.
- **Image OCR escape hatch.** Tesseract gets `confidence_threshold` (default 50). Pages where mean confidence falls below this attach a `low_confidence_ocr` warning to the chunk metadata so retrieval can de-prioritize. We don't drop them — junk OCR is sometimes the only signal we have.
- **Code files** (`.py`, `.ts`, etc.) treated as plain text in v1. Syntax-aware chunking is a follow-up.
- **HTML** uses `readability-lxml` to strip nav/ads/boilerplate before chunking. Falls back to plain text on parse error.

**Dependencies added:**
- `pypdf>=4.0` — pure Python.
- `python-docx>=1.0` — pure Python.
- `pytesseract>=0.3.10` + `Pillow>=10.0`.
- `tesseract-ocr` + `tesseract-ocr-eng` system packages in the Dockerfile (~80MB). English only; multi-lang flag is a follow-up.
- `readability-lxml>=0.8`.

**Phase-1 scope tracked in [WARP-201](https://warp-lab.atlassian.net/browse/WARP-201).** Phase-2 deferred extractors:

| Capability | Ticket | Why deferred |
|---|---|---|
| Audio (Whisper) | [WARP-197](https://warp-lab.atlassian.net/browse/WARP-197) | CPU/GPU model-size decision wants the inference-host GPU path settled first. |
| Video (frame OCR + audio) | [WARP-198](https://warp-lab.atlassian.net/browse/WARP-198) | Depends on audio. |
| Email (`.eml`/`.msg`) | [WARP-199](https://warp-lab.atlassian.net/browse/WARP-199) | Multipart/threading/encoding warrants focused implementation. |
| Archives (`.zip`/`.tar`/`.7z`) | [WARP-200](https://warp-lab.atlassian.net/browse/WARP-200) | Bomb-proofing + nested-citation contract warrants own scope. |

## 6. Brain memory data model

### 6.1 Prisma additions

```prisma
model BrainMemoryItem {
  id                String    @id @default(cuid())
  userId            String                              // owner — per-user isolation
  filename          String                              // original filename, displayed in UI
  mimeType          String?                             // detected at upload
  bytes             BigInt                              // original byte count
  storagePath       String                              // /data/brain-memory/<userId>/<id>/<filename>
  source            BrainMemorySource                   // chat_attachment | other (extensible enum)
  originatingChatId String?                             // ai-gateway session id, when applicable
  uploadedAt        DateTime  @default(now())
  indexedAt         DateTime?                           // null until extractor finishes
  extractorWarnings String[]                            // e.g. ["low_confidence_ocr_page_3"]
  hasOriginalBytes  Boolean   @default(true)            // toggled false if user opts into bytes-purge

  @@index([userId, uploadedAt])
  @@index([userId, originatingChatId])
}

enum BrainMemorySource {
  chat_attachment
}

model FileContentChunk {                                // EXISTING — additions only
  // ... existing fields preserved ...
  source       FileContentSource @default(nextcloud)
  brainItemId  String?                                  // FK to BrainMemoryItem when source=brain
  pageNumber   Int?                                     // PDF/DOCX page for citation precision
  warnings     String[]                                 // per-chunk extractor warnings (low-conf OCR, etc.)

  @@index([userId, source, indexedAt])                  // recency dashboard query
}

enum FileContentSource {
  nextcloud
  brain
}
```

Migration name: `20260428000000_brain_memory`. Idempotent (re-running adds no rows / changes no enums).

### 6.2 Storage layout on disk

```
/data/brain-memory/
  <userId>/
    <itemId>/
      original.<ext>          # original bytes (PDF, JPG, etc.)
      extracted.txt           # canonical extracted text — cached after extraction so re-index doesn't re-extract
      manifest.json           # mirrors the BrainMemoryItem row + extractor warnings
                              #   so bind-mounted backups are restorable without DB access
```

Bind-mounted into orchestrator + file-indexer containers via a new Compose volume. Per-item directory (not flat) so we can later put multiple files per item (unzipped archive members) without name collisions, and so "delete this item" is one `rm -rf`.

### 6.3 Lifecycle

- **Upload.** Dashboard `POST /api/files/brain/upload` (multipart) → orchestrator writes original to disk → inserts `BrainMemoryItem` (`indexedAt: null`) → publishes MQTT `droplet/files/brain/uploaded` → returns 202 `{itemId, status: "indexing"}`.
- **Index.** file-indexer subscribes, runs the extractor → chunker → embedder pipeline (same as Nextcloud watcher), upserts `FileContentChunk` with `source: brain` and `brainItemId`, sets `BrainMemoryItem.indexedAt`, writes `extracted.txt` + `manifest.json`, publishes per-user `droplet/files/<userId>/brain/indexed {itemId, status: "ready"|"failed", reason?}`. *(Implementation note (WARP-203): publishes on the per-user topic to leverage the existing dashboard WebSocket bridge subscription. The `<userId>` segment makes the dashboard live-update automatic with zero extra wiring.)*
- **Search.** `search_content` MCP tool runs cosine across BOTH sources by default. Optional `source` filter for "search only my Nextcloud" / "search only my brain memory."
- **Export.** Dashboard `GET /api/files/brain/export?chatId=<id>` streams a zip of the user's brain-memory items scoped to that chat session, plus a top-level `manifest.json`. Or `?all=1` for everything.
- **Delete.** `DELETE /api/files/brain/:itemId` removes the row, the on-disk directory, and cascades chunk deletion.
- **Cascade on user deletion.** Removing a Nextcloud user purges `/data/brain-memory/<userId>/` plus all their rows in one transaction.

## 7. Chat attachment UX flow

```
[user drops file on chat input]
        │
        ▼
Dashboard: useChat.attach(file)
   - shows pending attachment chip ("budget.pdf • indexing…")
   - POST /api/files/brain/upload (multipart)
        │
        ▼
Orchestrator: files-brain.routes.ts
   - validates: max 50MB, MIME allow-list matching the v1 extractor set
   - resolves authed userId (existing auth middleware)
   - writes original bytes → /data/brain-memory/<userId>/<cuid>/original.<ext>
   - inserts BrainMemoryItem (indexedAt: null)
   - publishes MQTT: droplet/files/brain/uploaded {itemId, userId, path}
   - returns 202 {itemId, status: "indexing"}
        │
        ▼
file-indexer (subscribed to droplet/files/brain/uploaded)
   - dispatches via extractors.registry by MIME
   - chunks → embeds (existing gRPC) → upserts FileContentChunk(source=brain, brainItemId)
   - updates BrainMemoryItem.indexedAt + writes extracted.txt + manifest.json
   - publishes MQTT: droplet/files/<userId>/brain/indexed {itemId, status: "ready"|"failed"}
        │
        ▼
Dashboard subscribes via per-user MQTT bridge
   - flips chip from "indexing…" → "ready" (✓) or "failed" (⚠ retry button)
   - on ready: the next user message in this chat sees the new item via search_content
```

**UX details:**
- **Async by design.** The user keeps chatting while indexing happens in the background. They don't wait for OCR.
- **Failure path.** If extraction fails (corrupt PDF, unsupported MIME), the chip shows ⚠ with the reason and a "remove" button. Original bytes stay on disk so the user can re-download via export — failed extraction doesn't lose the file.
- **No per-conversation retrieval scoping in v1.** All of a user's brain memory is searchable from any chat. (A "scope to this conversation" filter is a Phase-2 follow-up.)
- **Drop-zone affordance.** The existing `ChatInput.tsx` gets a `<input type="file" multiple>` plus drag-over highlighting on the whole chat panel. Multi-file drop = N upload calls, N chips.

## 8. Retrieval + ranking

- **Embedding model.** Inherit whatever the ai-gateway's `EmbedText` already uses (per `EMBEDDING_MODEL` config). No change in v1.
- **Top-k.** Default 10. The `search_content` tool's `limit` argument allows the caller to override (already in the schema). 50 max.
- **Filtering.** Always by `userId`. Optional `source` filter (`nextcloud` | `brain`). Optional `since` filter (ISO timestamp) for "what did I add recently."
- **Ranking.** Pure cosine similarity from pgvector for v1. No reranker. Cross-encoder reranker (`bge-reranker-v2-m3` or similar) is a tracked Phase-2 follow-up if real-user retrieval quality is mediocre.
- **Deduplication.** When N adjacent chunks from the same file all hit, collapse to the highest-scoring one and surface "+N more chunks in this file" as metadata. Avoids 10 hits all from page 1 of the same PDF crowding out other documents.
- **Score threshold.** Drop chunks below `MIN_SIMILARITY` (default 0.25). Pure-noise hits should not show up as citations.
- **Tool result shape.** Each hit returns `{source, path, brainItemId?, pageNumber?, score, snippet}` so the dashboard renders the right citation chip — Nextcloud hits link to the dashboard's Files page; brain hits link to the export download.

## 9. `/knowledge` dashboard view

Lives at `apps/web-dashboard/src/app/knowledge/`. New top-level tab in the dashboard nav alongside Network, Files, Chat.

> **Path namespace note (WARP-204):** routes are mounted under `/api/files/knowledge/*` — NOT `/api/files/*` — to avoid colliding with the long-standing `/files/recents` (Nextcloud filename Recents tab) and `/files/search` (global filename search bar) routes that pre-date the RAG work. The `/knowledge/` prefix keeps both surfaces alive without breaking the existing dashboard.

Three sub-sections:

1. **Recently indexed** — chunked-by-day list grouped under "Today / Yesterday / This week / This month / Earlier". Cards show filename, source badge (`Nextcloud` / `Brain`), preview snippet (first chunk's text truncated), file-type icon. Backed by `GET /api/files/knowledge/recent?limit=50&before=<cursor>` (cursor pagination).
2. **Search** — full-text search box. Submitting hits `GET /api/files/knowledge/search?q=<query>&limit=20` → returns the same `{source, path, score, snippet}` shape the LLM tool returns. **Shared service module** (`apps/orchestrator/src/services/file-search.service.ts`) so the LLM-tool path and the dashboard path can't drift.
3. **Brain memory** — list of all `BrainMemoryItem` rows for the user with per-item delete + "Download original" + "Export all as zip" affordances.

**Empty states.** "No files indexed yet. Drop a file in chat or upload to your Droplet's Nextcloud at `/files`." Friendly, persona-on-tone.

**Filters.** Source, file type, date range. Wire these to the same query params as the LLM tool's `source` / `since` filters so behavior is consistent across surfaces.

## 10. Phasing — six tickets

```
WARP-201   Foundation extractors                                 (large)
           - extractors/{text,pdf,docx,image,registry}.py
           - dispatcher + per-MIME tests + 6 fixtures committed
           - tesseract-ocr in Dockerfile
           - Existing watcher unblocked end-to-end
                            │
                            ├──────────────┬──────────────┐
                            ▼              ▼              ▼
WARP-202  embedText      WARP-203        WARP-204         (parallel after WARP-201)
          wiring +       BrainMemoryItem /knowledge
          search_content schema +        dashboard +
          live (orch     brain-upload    recency / search
          ToolContext +  route +         routes
          file-search    MQTT pipeline +
          .service)      drop-zone UX
                            │              │              │
                            └──────────────┼──────────────┘
                                           ▼
WARP-205  Brain memory export + delete + cascade-on-user-deletion
                                           ▼
WARP-206  End-to-end retrieval-quality smoke
          + dashboard live test against full compose stack
          + new rag-tests.yml CI workflow
```

Execution order:
1. **WARP-201** ships first (everything depends on extractors actually working).
2. **WARP-202, WARP-203, WARP-204** can be implemented in parallel after WARP-201 merges — distinct workspaces, no shared files (WARP-202 = orchestrator services + mcp-server context; WARP-203 = orchestrator routes + Prisma + file-indexer subscriber + dashboard ChatInput; WARP-204 = orchestrator routes + new dashboard view).
3. **WARP-205** lands after WARP-203 (depends on the schema/storage from it).
4. **WARP-206** is last — exercises everything end-to-end via the LLM.

## 11. Testing strategy

The user-stated requirement: **every new HTTP endpoint must be tested locally to make sure the API works.**

- **Per-ticket AC.** Every new endpoint lands with both:
  - A **unit test** (supertest / vitest against the route handler with mocked deps).
  - A **live integration test** that boots the relevant Compose services (`docker compose up -d orchestrator file-indexer ai-gateway db cache broker`), exercises the API for real, asserts side effects on disk + Postgres + MQTT, and tears down. Mirrors the existing `tests/api.integration.test.ts` pattern.
- **CI workflow.** New `.github/workflows/rag-tests.yml` (path-filtered to `services/file-indexer/**`, `apps/orchestrator/src/{routes/files*,services/file-search*,services/brain-memory*}`, `apps/orchestrator/prisma/schema.prisma`, `apps/web-dashboard/src/app/knowledge/**`, `tests/rag-*`). Full Compose stack runs in CI — same pattern as `setup-script` and `build all images`.
- **Local fast loop.** `scripts/test-rag.sh` runs only the new integration tests against an existing local Compose stack — feedback in <30s versus the full CI run.
- **Smoke fixtures.** Each extractor ticket commits 1-2 representative real-world public-domain files under `services/file-indexer/tests/fixtures/`. The integration tests upload these, wait for indexing, query, and assert specific content shows up. So a regression in any extractor breaks an integration test, not just a unit test.
- **End-to-end LLM smoke.** WARP-206 boots the full stack, uploads a known PDF and a known image, asks the LLM about each, and asserts the response cites the right source with a non-empty snippet. Determinism: assert structural properties of the response, not exact text. Must pass 5 runs in a row to avoid flake.
- **Phase-2 extractor coverage.** WARP-197/198/199/200 each carry their own integration-test AC for the same reason.

## 12. RBAC

- Per-user filtering on every retrieval path. `userId` (from JWT or auth middleware) is mandatory in:
  - `FileContentChunk` queries (cosine, recency, by-source).
  - `BrainMemoryItem` queries (list, get, delete, export).
  - File-indexer's MQTT subscriber's chunk inserts (the `userId` comes from the upload request, not the file's location).
- Cross-user search disabled in v1. Family/guest only see their own. Admin/owner see only their own (no admin "search everyone's stuff" affordance — privacy surface).
- Brain-upload route validates the authed user can write only to their own `/data/brain-memory/<userId>/` path.
- Brain-export and brain-delete routes validate `BrainMemoryItem.userId === authed userId` before the operation.

## 13. Open questions

None. All design decisions resolved during brainstorming on 2026-04-28. Section-level approvals captured in the conversation transcript. Ticket creation completed before spec write.

## 14. Execution model

This work follows the agent harness defined in [`docs/superpowers/agent-harness.md`](../agent-harness.md). Per-ticket gates: Dev → QA → UI/UX (only on WARP-204 since it adds dashboard UI; chip-rendering changes in WARP-203's drop-zone may also trigger UX) → Manager → PR → CI → Code Reviewer → human merge.

WARP-201 is the foundation; once it merges, WARP-202/203/204 dispatch in parallel as separate Dev agents on separate branches (same pattern as WARP-83/84/85/86 in the device-intelligence Phase 1).
