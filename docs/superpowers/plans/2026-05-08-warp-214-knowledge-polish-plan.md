# WARP-214 — `/knowledge` dashboard polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the `/knowledge` dashboard to render the new MIME classes (audio/video/email/zip), the new ingestion states (`queued_for_transcription` / `indexing` / `ready` / `failed`), the source-channel provenance ("transcribed by ASR" / "embedded subtitles" / "OCR"), and recursion breadcrumbs (depth-2 chevrons) — while wiring the metadata persistence the components consume.

**Architecture:** Pure frontend extension across 5 new components + 4 modified callsites, plus the persistence path the spec was missing: a `metadata Json?` column on `FileContentChunk`, extractor metadata writes (email `chain[]`, archive `chain[]`, video `subtitle_source`), chunker propagation, and orchestrator route surfacing. No new services, no new orchestrator routes (just one field-extension to `files-knowledge.ts`).

**Tech Stack:** TypeScript, React, Next.js 14, Lucide icons, Tailwind, vitest + jsdom + @testing-library/react (frontend) · Python 3.12, watchdog, pgvector, Prisma 5 (backend).

**Spec:** [`docs/superpowers/specs/2026-05-08-warp-214-knowledge-polish-design.md`](../specs/2026-05-08-warp-214-knowledge-polish-design.md)

---

## Pre-flight finding & scope adjustment

The spec at §4 says the orchestrator route "was filtering out" `metadata.subtitle_source` and `metadata.chain` — implying those fields already live on `FileContentChunk`. They don't. The schema currently has individual columns (`pageNumber`, `brainItemId`, `warnings: String[]`) and **no general-purpose `metadata` JSON column**. Email + archive extractors don't write a `chain[]` field anywhere; video's `subtitle_source` lives on the in-process `ExtractedDoc` and isn't persisted.

**The plan therefore wires the persistence path** — a small Prisma migration (`metadata Json?`), three extractor updates, and a chunker propagation. Each step stays bite-sized; the plan grows from the spec's ~9 files to ~14 files, ~750 LoC including tests (vs. spec's estimated 600).

The frontend rendering is unchanged from the spec's intent. Manual smoke at the end (per the brainstorm's option A) confirms a real text → email → zip upload roundtrips end-to-end.

---

## Branching & dispatch

Single branch: `WARP-214` off `main`. Single Dev dispatch (~20 tasks). One PR.

**Local-validation gate (per spec §8):** `./scripts/test-rag.sh` end-to-end smoke at the end of the implementation, before opening the PR. Drop a `.zip` containing `march.eml` containing `proposal.pdf`. Verify the chevron breadcrumb renders. Document the result in the PR body.

---

## Task 0: Pre-flight — branch + spec verification

### Task 0.1: Branch state

- [ ] **Step 1: Confirm clean state on the WARP-214 branch**

```bash
git status
git rev-parse --abbrev-ref HEAD
git log -1 --format="%h %s"
```

Expected: branch `WARP-214`, clean tree, last commit on `main` is the spec merge.

- [ ] **Step 2: Confirm WARP-218 status (blocker awareness)**

```bash
gh issue view WARP-218 --json status --jq .status 2>&1 || echo "Use the Jira browser at https://warp-lab.atlassian.net/browse/WARP-218"
```

WARP-218 (deferred ASR) gates the live `queued_for_transcription` path. WARP-214 ships the rendering regardless — the Dev should NOT block on WARP-218 merging. Document in the final PR body whether WARP-218 was merged when this lands.

### Task 0.2: Verify the existing tests pass

- [ ] **Step 1: Run the orchestrator unit suite**

```bash
cd apps/orchestrator
npm test 2>&1 | tail -10
```

Expected: green. If anything is red on `main`, surface it before continuing.

- [ ] **Step 2: Run the file-indexer unit suite**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -10
```

Expected: green (some tests skip without RUN_RAG_INTEGRATION; that's fine).

- [ ] **Step 3: Run the dashboard unit suite**

```bash
cd apps/web-dashboard
npm test 2>&1 | tail -10
```

Expected: green.

---

## Phase 1 — Persistence path (backend)

### Task 1.1: Prisma migration — add `metadata Json?` to FileContentChunk

**Files:**
- Modify: `apps/orchestrator/prisma/schema.prisma`
- Create: `apps/orchestrator/prisma/migrations/20260508000000_chunk_metadata/migration.sql`

- [ ] **Step 1: Edit the schema**

Open `apps/orchestrator/prisma/schema.prisma`. Find the `model FileContentChunk` block (~line 240). Add a `metadata` line after `warnings`:

```prisma
model FileContentChunk {
  id          BigInt                     @id @default(autoincrement())
  userId      String
  ncFileId    Int
  path        String
  chunkIdx    Int
  text        String
  embedding   Unsupported("vector(384)")
  indexedAt   DateTime                   @default(now())
  source      FileContentSource          @default(nextcloud)
  brainItemId String?
  pageNumber  Int?
  warnings    String[]                   @default([])
  // WARP-214: free-form per-chunk metadata. Today carries:
  //   - chain[]            { filename, mime, parentItemId? }[] for email/archive recursion
  //   - subtitle_source    "asr_transcript" | "embedded" | "frame_ocr"
  // The orchestrator surfaces this verbatim on the /api/files/knowledge
  // routes; the dashboard renders breadcrumbs + source-channel badge from it.
  // Keep loose-typed Json so future extractors can add fields without
  // requiring a migration (e.g. WARP-208 frame OCR, WARP-207 diarization).
  metadata    Json?

  @@unique([ncFileId, chunkIdx])
  @@index([userId])
  @@index([userId, source, indexedAt])
}
```

- [ ] **Step 2: Generate the migration SQL**

```bash
cd apps/orchestrator
npx prisma migrate dev --name chunk_metadata --create-only
```

Expected: creates `prisma/migrations/20260508_<timestamp>_chunk_metadata/migration.sql`. The `--create-only` keeps the migration unapplied so we can inspect it.

- [ ] **Step 3: Inspect + harden the SQL**

Open the generated `migration.sql`. It should be:

```sql
-- AlterTable
ALTER TABLE "FileContentChunk" ADD COLUMN "metadata" JSONB;
```

Idempotent guard (matches WARP-203's migration pattern). Replace with:

```sql
-- WARP-214: free-form per-chunk metadata for breadcrumbs + source-channel badge.
ALTER TABLE "FileContentChunk"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;
```

Rename the directory to `apps/orchestrator/prisma/migrations/20260508000000_chunk_metadata/` so the timestamp matches the user-friendly `2026-05-08` ordering convention used by WARP-203/204/205 (`20260428000000_*`, etc.).

- [ ] **Step 4: Apply the migration locally**

```bash
cd apps/orchestrator
npx prisma migrate dev
```

Expected: "All migrations have been successfully applied" + Prisma client regenerates.

- [ ] **Step 5: Confirm the column exists**

```bash
docker compose -f docker/docker-compose.yml exec -T db psql -U droplet -d droplet \
  -c "\d \"FileContentChunk\"" 2>&1 | grep metadata
```

Expected: `metadata | jsonb` row in the column listing.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/prisma/schema.prisma \
        apps/orchestrator/prisma/migrations/20260508000000_chunk_metadata/migration.sql
git commit -m "feat(rag): metadata Json? column on FileContentChunk (WARP-214)"
```

### Task 1.2: file-indexer db.upsert_chunk writes metadata

**Files:**
- Modify: `services/file-indexer/db.py`
- Test: `services/file-indexer/tests/test_db_metadata.py` (new)

- [ ] **Step 1: Read the existing db.py to find upsert_chunk**

```bash
grep -n "def upsert_chunk\|INSERT INTO" services/file-indexer/db.py | head -5
```

Find the `upsert_chunk` function (currently around line 70-100). Note its current signature.

- [ ] **Step 2: Write the failing test**

Create `services/file-indexer/tests/test_db_metadata.py`:

```python
"""WARP-214: db.upsert_chunk persists the optional metadata jsonb column."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

from db import upsert_chunk


def test_upsert_chunk_writes_metadata_when_provided():
    """When metadata is a dict, it's serialized as JSON and bound to the INSERT."""
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    upsert_chunk(
        fake_conn,
        user_id="alice",
        nc_file_id=42,
        path="/foo/bar.zip",
        chunk_idx=0,
        text="hello",
        embedding=[0.0] * 384,
        source="brain",
        brain_item_id="bmi-abc",
        page_number=None,
        warnings=[],
        metadata={"chain": [{"filename": "bar.zip", "mime": "application/zip"}]},
    )

    # Inspect the SQL execute call. The SQL must include 'metadata',
    # and the bound value at the metadata position is the JSON string.
    sql = fake_cursor.execute.call_args[0][0]
    binds = fake_cursor.execute.call_args[0][1]
    assert "\"metadata\"" in sql
    # The metadata value is bound either directly as dict (psycopg adapts) or
    # as a JSON-serialized string. Both are acceptable.
    metadata_in_binds = any(
        b == {"chain": [{"filename": "bar.zip", "mime": "application/zip"}]}
        or (isinstance(b, str) and b == json.dumps({"chain": [{"filename": "bar.zip", "mime": "application/zip"}]}))
        for b in binds
    )
    assert metadata_in_binds, f"metadata not bound: binds={binds}"


def test_upsert_chunk_writes_null_metadata_when_omitted():
    """When metadata is None, the column is set to NULL (or simply not bound)."""
    fake_conn = MagicMock()
    fake_cursor = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor

    upsert_chunk(
        fake_conn,
        user_id="alice",
        nc_file_id=42,
        path="/foo/bar.txt",
        chunk_idx=0,
        text="hello",
        embedding=[0.0] * 384,
        source="nextcloud",
        brain_item_id=None,
        page_number=None,
        warnings=[],
        metadata=None,
    )

    sql = fake_cursor.execute.call_args[0][0]
    # SQL still references the column (so existing rows can be updated),
    # but the bound value is None.
    assert "\"metadata\"" in sql
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_db_metadata.py -v 2>&1 | tail -10
```

Expected: TypeError or AssertionError because `upsert_chunk` doesn't accept `metadata` yet.

- [ ] **Step 4: Modify upsert_chunk**

Open `services/file-indexer/db.py`. Find the existing `upsert_chunk` function. Add `metadata` to its signature and to the SQL INSERT:

```python
def upsert_chunk(
    conn,
    *,
    user_id: str,
    nc_file_id: int,
    path: str,
    chunk_idx: int,
    text: str,
    embedding: list[float],
    source: str = "nextcloud",
    brain_item_id: str | None = None,
    page_number: int | None = None,
    warnings: list[str] | None = None,
    metadata: dict | None = None,
) -> None:
    """Upsert a single chunk row.

    `metadata` is a free-form dict serialized to JSONB via psycopg's
    automatic adaptation. None → NULL in the column. WARP-214 introduces
    this for breadcrumb chains + source-channel badges; future extractors
    (frame OCR, speaker diarization) extend the dict without needing a
    schema change.
    """
    import json
    metadata_value = json.dumps(metadata) if metadata is not None else None
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "FileContentChunk"
              ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding",
               "indexedAt", "source", "brainItemId", "pageNumber", "warnings",
               "metadata")
            VALUES (%s, %s, %s, %s, %s, %s::vector,
                    NOW(), %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT ("ncFileId", "chunkIdx") DO UPDATE
              SET "text"      = EXCLUDED."text",
                  "embedding" = EXCLUDED."embedding",
                  "indexedAt" = EXCLUDED."indexedAt",
                  "warnings"  = EXCLUDED."warnings",
                  "metadata"  = EXCLUDED."metadata"
            """,
            (
                user_id,
                nc_file_id,
                path,
                chunk_idx,
                text,
                embedding,
                source,
                brain_item_id,
                page_number,
                warnings or [],
                metadata_value,
            ),
        )
    conn.commit()
```

(Preserve the existing `embedding` casting / `source` enum handling already in the file — this snippet shows the additive shape; merge with what's there.)

- [ ] **Step 5: Run the test to confirm 2/2 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_db_metadata.py -v 2>&1 | tail -10
```

Expected: 2 passed.

- [ ] **Step 6: Run the FULL file-indexer suite to confirm no regression**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -10
```

Expected: All previously-passing tests still pass. Phase 1 callers passing `metadata=None` (default) keep working.

- [ ] **Step 7: Commit**

```bash
git add services/file-indexer/db.py services/file-indexer/tests/test_db_metadata.py
git commit -m "feat(file-indexer): persist metadata jsonb on FileContentChunk (WARP-214)"
```

### Task 1.3: Chunker propagates ExtractedDoc.metadata to upsert_chunk

**Files:**
- Modify: `services/file-indexer/watcher.py` (the chunker→db wiring)
- Modify: `services/file-indexer/brain_ingest.py` (same wiring on the brain path)

- [ ] **Step 1: Find the existing call sites**

```bash
grep -nE "upsert_chunk\(" services/file-indexer/watcher.py services/file-indexer/brain_ingest.py
```

Expected: 2 call sites — one in `watcher.py` (Nextcloud watch path) and one in `brain_ingest.py` (MQTT brain-upload path).

- [ ] **Step 2: Modify watcher.py to forward metadata**

Find the `upsert_chunk(...)` call inside `watcher.py`'s `IndexHandler`. Pass `metadata=doc.get("metadata")`:

```python
# Before:
upsert_chunk(
    conn,
    user_id=user,
    nc_file_id=file_id,
    path=relpath,
    chunk_idx=i,
    text=chunk,
    embedding=embedding,
    source="nextcloud",
    brain_item_id=None,
    page_number=page_for_chunk(doc, i),
    warnings=doc.get("warnings", []),
)

# After:
upsert_chunk(
    conn,
    user_id=user,
    nc_file_id=file_id,
    path=relpath,
    chunk_idx=i,
    text=chunk,
    embedding=embedding,
    source="nextcloud",
    brain_item_id=None,
    page_number=page_for_chunk(doc, i),
    warnings=doc.get("warnings", []),
    metadata=doc.get("metadata"),
)
```

- [ ] **Step 3: Modify brain_ingest.py same way**

Same one-line addition at the brain-ingest call site:

```python
upsert_chunk(
    conn,
    user_id=user_id,
    nc_file_id=synthetic_nc_file_id,
    path=path,
    chunk_idx=i,
    text=chunk,
    embedding=embedding,
    source="brain",
    brain_item_id=item_id,
    page_number=page_for_chunk(doc, i),
    warnings=doc.get("warnings", []),
    metadata=doc.get("metadata"),
)
```

- [ ] **Step 4: Run the full file-indexer suite**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -10
```

Expected: green. brain_ingest + watcher tests still pass; the metadata-passing change is additive.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/watcher.py services/file-indexer/brain_ingest.py
git commit -m "feat(file-indexer): propagate ExtractedDoc.metadata to chunk rows (WARP-214)"
```

### Task 1.4: Video extractor writes subtitle_source under metadata

**Files:**
- Modify: `services/file-indexer/extractors/video.py`
- Test: `services/file-indexer/tests/test_video.py` (extend)

WARP-198 already writes `metadata.subtitle_source` on the in-process `ExtractedDoc`. Verify it's there, and add a test asserting persistence-shape stability.

- [ ] **Step 1: Inspect current video.py output**

```bash
grep -n "subtitle_source" services/file-indexer/extractors/video.py
```

Expected: existing assignments to `metadata.subtitle_source` in both the embedded-subs path and the audio-fallback path. If the field isn't there, add it per the spec §4.2.

- [ ] **Step 2: Add a test asserting metadata shape**

In `services/file-indexer/tests/test_video.py`, add:

```python
def test_video_metadata_includes_subtitle_source_for_chain_consumers():
    """WARP-214: subtitle_source must be reachable as ExtractedDoc.metadata['subtitle_source']
    so the chunker can propagate it to FileContentChunk.metadata.subtitle_source.
    """
    result_with = video.extract(FIXTURES / "with-srt.mp4", mime="video/mp4")
    assert result_with is not None
    assert result_with["metadata"]["subtitle_source"] == "embedded"

    result_without = video.extract(FIXTURES / "no-srt.mp4", mime="video/mp4")
    assert result_without is not None
    assert result_without["metadata"]["subtitle_source"] == "asr_transcript"
```

- [ ] **Step 3: Run the test**

```bash
cd services/file-indexer
python -m pytest tests/test_video.py::test_video_metadata_includes_subtitle_source_for_chain_consumers -v 2>&1 | tail -5
```

Expected: 1 passed (assuming WARP-198 already writes the field).

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/tests/test_video.py
git commit -m "test(rag): assert video.subtitle_source is reachable for WARP-214 chunker"
```

### Task 1.5: Email extractor writes chain[] when recursing attachments

**Files:**
- Modify: `services/file-indexer/extractors/email.py`
- Test: `services/file-indexer/tests/test_email.py` (extend)

- [ ] **Step 1: Read the current attachment-walk loop**

```bash
grep -nE "_dispatch_attachment|_walk_attachments|_ATTACHMENT_SEPARATOR" services/file-indexer/extractors/email.py | head
```

Find the loop that calls `registry.dispatch(tmp, mime, depth=depth+1)` for each attachment.

- [ ] **Step 2: Write the failing test**

In `services/file-indexer/tests/test_email.py`, add:

```python
def test_eml_with_attachment_writes_chain_metadata():
    """WARP-214: when an .eml has a PDF attachment, the resulting ExtractedDoc
    has a metadata.chain that traces email → attachment.
    """
    result = email_ext.extract(FIXTURES / "with-pdf-attachment.eml", mime="message/rfc822")
    assert result is not None
    metadata = result.get("metadata", {})
    chain = metadata.get("chain")
    assert chain is not None, f"chain missing; metadata keys={list(metadata)}"
    # The chain should include the PDF attachment as the last segment, with the
    # email itself as the parent — so a downstream chunker stamps each chunk
    # with this trail.
    last = chain[-1]
    assert last["filename"] == "proposal.pdf"
    assert last["mime"] == "application/pdf"
    # The chain entry just before should be the email (the parent dispatcher).
    assert any(c.get("mime") == "message/rfc822" for c in chain)
```

- [ ] **Step 3: Run to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_email.py::test_eml_with_attachment_writes_chain_metadata -v 2>&1 | tail -10
```

Expected: AssertionError that `chain missing` (today email writes `parent_email_id` but not a structured `chain[]`).

- [ ] **Step 4: Implement the chain construction**

In `email.py`, modify the attachment-walk loop to build a chain. The simplest shape is: each recursive `dispatch` call includes the parent's filename + mime in the inner extractor's input metadata. Since `dispatch()` doesn't accept arbitrary input metadata today, we build the chain server-side after the recursion returns and merge it into the parent's metadata before returning.

Replace the existing attachment-walk logic (the loop that builds `attachments_text`) with:

```python
def _walk_attachments_with_chain(msg, depth: int, parent_filename: str, parent_mime: str):
    """WARP-214: same as the existing walk, but also returns a chain[] mapping
    each successfully-indexed attachment to its lineage.

    chain[] entries: [{filename, mime, parentItemId? — set by the orchestrator
    when persisting]. The chunker propagates each chunk's chain into
    FileContentChunk.metadata.chain.
    """
    text_parts: list[str] = []
    warnings: list[str] = []
    chain_entries: list[list[dict]] = []  # one chain[] per attachment

    for part in msg.walk():
        if part.is_multipart():
            continue
        cd = part.get("Content-Disposition", "")
        if "attachment" not in cd.lower() and not part.get_filename():
            continue
        filename = part.get_filename() or "unnamed"
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        mime = magic.from_buffer(payload, mime=True)
        fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or "")
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        try:
            sub = registry.dispatch(Path(tmp), mime, depth=depth + 1)
            if sub is None:
                warnings.append(f"unsupported_attachment:{filename}:{mime}")
                continue
            text_parts.append(_ATTACHMENT_SEPARATOR.format(name=filename))
            text_parts.append(sub["text"])
            warnings.extend(sub.get("warnings") or [])
            # Build the chain: parent (this email) → child (the attachment).
            # If the attachment itself has a chain (e.g. it was a nested .eml),
            # prepend our parent and append the child's chain.
            sub_chain = sub.get("metadata", {}).get("chain", [])
            chain_entries.append(
                [
                    {"filename": parent_filename, "mime": parent_mime},
                    *sub_chain,
                    {"filename": filename, "mime": mime},
                ]
                if sub_chain
                else [
                    {"filename": parent_filename, "mime": parent_mime},
                    {"filename": filename, "mime": mime},
                ]
            )
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return "\n".join(text_parts), warnings, chain_entries
```

Then update the top-level `_extract_eml` and `_extract_msg` to call the new walker and merge the chain into the returned `ExtractedDoc`:

```python
# In _extract_eml, around the existing _walk_attachments call:
attachments_text, attachment_warnings, attachment_chains = _walk_attachments_with_chain(
    msg,
    depth=depth,
    parent_filename=parent_filename or "(email)",
    parent_mime="message/rfc822",
)
full_text = "\n\n".join(p for p in [headers, body, attachments_text] if p)
metadata = {
    "from": msg.get("From"),
    "subject": msg.get("Subject"),
    "date": msg.get("Date"),
}
# Pick the first non-empty chain to attach to the doc-level metadata. If multiple
# attachments produced their own chains, the chunker writes one chain per chunk
# (downstream task, not here). For the doc-level metadata, expose any chain so
# tests + downstream consumers can verify shape.
if attachment_chains:
    metadata["chain"] = attachment_chains[0]
return ExtractedDoc(
    text=full_text,
    page_breaks=...,
    language=None,
    metadata=metadata,
    warnings=attachment_warnings,
)
```

Note: the `parent_filename` for `_extract_eml` should come from the input — pass it through from the public `extract` entry point. If the call site doesn't have a filename (e.g. the email is a top-level upload), use `(email)` as a placeholder.

(Implementation freedom: if the existing `_walk_attachments` is straightforward, you may extend it in place rather than creating a new function. The key requirement: ExtractedDoc.metadata.chain has the right shape, asserted by the test in Step 2.)

- [ ] **Step 5: Run the test to confirm green**

```bash
cd services/file-indexer
python -m pytest tests/test_email.py::test_eml_with_attachment_writes_chain_metadata -v 2>&1 | tail -10
```

Expected: 1 passed.

- [ ] **Step 6: Run the full email test suite to confirm no regression**

```bash
cd services/file-indexer
python -m pytest tests/test_email.py -v 2>&1 | tail -10
```

Expected: all previously-passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add services/file-indexer/extractors/email.py services/file-indexer/tests/test_email.py
git commit -m "feat(rag): email extractor writes chain[] in metadata (WARP-214)"
```

### Task 1.6: Archive extractor writes chain[] when recursing members

**Files:**
- Modify: `services/file-indexer/extractors/archive.py`
- Test: `services/file-indexer/tests/test_archive.py` (extend)

Mirror Task 1.5 for the archive extractor. The archive's `_extract_zip` and `_extract_tar` need to add chain entries to each member's recursive dispatch result.

- [ ] **Step 1: Write the failing test**

In `services/file-indexer/tests/test_archive.py`, add:

```python
def test_archive_with_member_writes_chain_metadata():
    """WARP-214: nested.zip (zip-in-zip) produces a chain[] reflecting the
    archive lineage. The chunker propagates this to chunk metadata.
    """
    result = archive.extract(FIXTURES / "nested.zip", mime="application/zip")
    assert result is not None
    metadata = result.get("metadata", {})
    chain = metadata.get("chain")
    assert chain is not None, f"chain missing; metadata keys={list(metadata)}"
    # The outermost archive (.zip) is the parent; the inner archive's content
    # is the leaf.
    assert any(c.get("mime") == "application/zip" for c in chain), (
        f"chain {chain} should include the outer zip"
    )
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_archive.py::test_archive_with_member_writes_chain_metadata -v 2>&1 | tail -5
```

Expected: AssertionError.

- [ ] **Step 3: Implement chain construction in archive.py**

In `_extract_zip` and `_extract_tar`, after the existing per-member loop that builds `text_parts`, also build `chain_entries[]` and attach the first one to `metadata.chain`:

```python
# Inside _extract_zip's per-member loop, replace the existing
# `_process_member_bytes` call with a wrapped version that returns the chain too.
def _process_member_bytes_with_chain(
    member_name: str,
    member_bytes: bytes,
    depth: int,
    parent_filename: str,
    parent_mime: str,
) -> tuple[str, list[str], list[dict]]:
    """Same as _process_member_bytes, plus a chain[] for the dispatched member."""
    mime = magic.from_buffer(member_bytes, mime=True)
    fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(member_name)[1] or "")
    try:
        os.write(fd, member_bytes)
    finally:
        os.close(fd)
    try:
        sub = registry.dispatch(Path(tmp), mime, depth=depth + 1)
        if sub is None:
            return "", [f"unsupported_member:{member_name}:{mime}"], []
        sub_chain = sub.get("metadata", {}).get("chain", [])
        chain = (
            [
                {"filename": parent_filename, "mime": parent_mime},
                *sub_chain,
                {"filename": member_name, "mime": mime},
            ]
            if sub_chain
            else [
                {"filename": parent_filename, "mime": parent_mime},
                {"filename": member_name, "mime": mime},
            ]
        )
        return sub.get("text", ""), sub.get("warnings") or [], chain
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
```

Update the loops in `_extract_zip` and `_extract_tar` to capture `chain` from the new helper and merge the first one into `metadata.chain` on the returned ExtractedDoc:

```python
# Aggregate per-member chains.
member_chains: list[list[dict]] = []
# ... in the per-member loop:
t, w, chain = _process_member_bytes_with_chain(
    member_name=info.filename,
    member_bytes=member_bytes,
    depth=depth,
    parent_filename=parent_filename or "(archive)",
    parent_mime=parent_mime or "application/zip",
)
if t:
    text_parts.append(f"--- Member: {info.filename} ---\n{t}")
if chain:
    member_chains.append(chain)
warnings.extend(w)
# ... after the loop, attach the first chain to metadata:
metadata = {"format": "zip"}
if member_chains:
    metadata["chain"] = member_chains[0]
return ExtractedDoc(
    text="\n".join(text_parts),
    page_breaks=[],
    language=None,
    metadata=metadata,
    warnings=warnings,
)
```

(Same caveat as Task 1.5: extend in place rather than introduce new functions if cleaner. Test in Step 1 is the contract.)

- [ ] **Step 4: Run the test**

```bash
cd services/file-indexer
python -m pytest tests/test_archive.py::test_archive_with_member_writes_chain_metadata -v 2>&1 | tail -5
```

Expected: 1 passed.

- [ ] **Step 5: Run full archive suite**

```bash
cd services/file-indexer
python -m pytest tests/test_archive.py -v 2>&1 | tail -10
```

Expected: all previously-passing tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/archive.py services/file-indexer/tests/test_archive.py
git commit -m "feat(rag): archive extractor writes chain[] in metadata (WARP-214)"
```

### Task 1.7: Orchestrator route surfaces metadata field

**Files:**
- Modify: `apps/orchestrator/src/routes/files-knowledge.ts`
- Test: `apps/orchestrator/src/__tests__/files-knowledge.test.ts` (extend)

- [ ] **Step 1: Read current route serialization**

```bash
grep -nE "serializeChunk|select:|metadata" apps/orchestrator/src/routes/files-knowledge.ts | head -10
```

Find the function that turns `FileContentChunk` rows into the response shape. There may be a Prisma `select` or a manual `pick`.

- [ ] **Step 2: Write the failing test**

In `apps/orchestrator/src/__tests__/files-knowledge.test.ts`, add:

```typescript
describe("WARP-214: metadata serialization", () => {
  it("includes metadata.chain on /recent responses when present on chunks", async () => {
    // Mock the Prisma response to include a chunk with metadata.
    const fakeRow = {
      id: 99n,
      userId: "dev",
      ncFileId: 0,
      path: "/Brain/q1-stuff.zip/march.eml/proposal.pdf",
      chunkIdx: 0,
      text: "the budget for q4 is one hundred thousand",
      indexedAt: new Date("2026-05-01"),
      source: "brain",
      brainItemId: "bmi-99",
      pageNumber: null,
      warnings: [],
      metadata: {
        chain: [
          { filename: "q1-stuff.zip", mime: "application/zip" },
          { filename: "march.eml", mime: "message/rfc822" },
          { filename: "proposal.pdf", mime: "application/pdf" },
        ],
        subtitle_source: null,
      },
    };
    findManyMock.mockResolvedValue([fakeRow]);

    const res = await request(app).get("/api/files/knowledge/recent");
    expect(res.status).toBe(200);
    expect(res.body.items[0].metadata).toBeDefined();
    expect(res.body.items[0].metadata.chain).toHaveLength(3);
    expect(res.body.items[0].metadata.chain[0].filename).toBe("q1-stuff.zip");
  });

  it("includes metadata.subtitle_source on /search hits when present", async () => {
    // Stub the searchByVector response with a metadata-bearing row.
    embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    searchByVectorSpy.mockResolvedValueOnce([
      {
        path: "/Brain/meeting.mp4",
        score: 0.95,
        text: "transcript text",
        source: "brain",
        chunkIdx: 0,
        metadata: { subtitle_source: "asr_transcript" },
      },
    ]);

    const res = await request(app).get("/api/files/knowledge/search?q=meeting");
    expect(res.status).toBe(200);
    expect(res.body.hits[0].metadata).toBeDefined();
    expect(res.body.hits[0].metadata.subtitle_source).toBe("asr_transcript");
  });
});
```

(The `findManyMock`, `embedSpy`, and `searchByVectorSpy` already exist in the test file — see the existing files-knowledge tests.)

- [ ] **Step 3: Run to confirm failure**

```bash
cd apps/orchestrator
npm test -- files-knowledge 2>&1 | tail -10
```

Expected: 2 new failures — `metadata` is `undefined` in the response.

- [ ] **Step 4: Modify the route to include metadata**

In `apps/orchestrator/src/routes/files-knowledge.ts`, find the `serializeChunk` function (or the equivalent inline serialization). Add `metadata`:

```typescript
function serializeChunk(row: any) {
  return {
    id: typeof row.id === "bigint" ? row.id.toString() : String(row.id),
    userId: row.userId,
    ncFileId: row.ncFileId,
    path: row.path,
    chunkIdx: row.chunkIdx,
    snippet: snippet(row.text),
    indexedAt:
      row.indexedAt instanceof Date ? row.indexedAt.toISOString() : row.indexedAt,
    source: row.source ?? "nextcloud",
    brainItemId: row.brainItemId ?? null,
    pageNumber: row.pageNumber ?? null,
    // WARP-214: surface free-form metadata for breadcrumbs + source-channel
    // badge. Returns null when the row doesn't have any (Phase 1 chunks).
    metadata: row.metadata ?? null,
  };
}
```

For the search route, do the same in the `hits` map:

```typescript
res.json({
  hits: hits.map((h) => ({
    source: h.source ?? "brain",
    path: h.path,
    score: h.score,
    snippet: snippet(h.text),
    chunkIdx: h.chunkIdx ?? null,
    metadata: h.metadata ?? null, // WARP-214
  })),
});
```

- [ ] **Step 5: Run the test**

```bash
cd apps/orchestrator
npm test -- files-knowledge 2>&1 | tail -10
```

Expected: green; 2 new tests pass + existing ones unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/routes/files-knowledge.ts \
        apps/orchestrator/src/__tests__/files-knowledge.test.ts
git commit -m "feat(orchestrator): surface FileContentChunk.metadata on knowledge routes (WARP-214)"
```

---

## Phase 2 — Frontend (dashboard polish)

### Task 2.1: lib/api.ts type extensions

**Files:**
- Modify: `apps/web-dashboard/src/lib/api.ts`

- [ ] **Step 1: Extend BrainMemoryItemInfo + KnowledgeChunkItem + KnowledgeSearchHit**

Open `apps/web-dashboard/src/lib/api.ts`. Find the three interfaces and extend them:

```typescript
/** Source-channel signal — what extractor produced the text. */
export type SubtitleSource =
  | "asr_transcript"
  | "embedded"
  | "frame_ocr";

/** One step in the recursion chain for an attachment / archive member. */
export interface ChainStep {
  filename: string;
  mime: string;
  parentItemId?: string | null;
}

/** Free-form per-chunk metadata. Loose-typed so future extractors can extend. */
export interface ChunkMetadata {
  chain?: ChainStep[];
  subtitle_source?: SubtitleSource;
}

/** Brain-memory item status — drives the StatusChip rendering. */
export type BrainMemoryItemStatus =
  | "queued_for_transcription"
  | "indexing"
  | "ready"
  | "failed";

/** A brain-memory item — extended for WARP-214 with status + metadata. */
export interface BrainMemoryItemInfo {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  originatingChatId?: string | null;
  // WARP-214: status drives the StatusChip; failureReason surfaces in tooltip.
  status?: BrainMemoryItemStatus;
  failureReason?: string | null;
}

// Existing KnowledgeChunkItem — extend with metadata
export interface KnowledgeChunkItem {
  id: string;
  ncFileId: number;
  path: string;
  chunkIdx: number;
  snippet: string;
  indexedAt: string;
  source: "nextcloud" | "brain";
  brainItemId: string | null;
  pageNumber: number | null;
  // WARP-214
  metadata?: ChunkMetadata | null;
}

// Existing KnowledgeSearchHit — extend with metadata
export interface KnowledgeSearchHit {
  source: "nextcloud" | "brain";
  path: string;
  brainItemId?: string | null;
  pageNumber?: number | null;
  score: number;
  snippet: string;
  // WARP-214
  metadata?: ChunkMetadata | null;
}
```

- [ ] **Step 2: Add the transcribeNow API helper**

Append to `lib/api.ts`:

```typescript
/**
 * WARP-214 + WARP-218: promote a queued brain memory item to immediate
 * transcription. Discreet "Transcribe now" overflow action on the StatusChip.
 *
 * Returns 404 when WARP-218 isn't merged yet — the caller probes once and
 * caches the absence so the UI hides the action gracefully.
 */
export async function transcribeNow(itemId: string): Promise<{ status: BrainMemoryItemStatus }> {
  const res = await authFetch(`${BASE}/api/files/brain/${itemId}/transcribe-now`, {
    method: "POST",
  });
  if (res.status === 404) {
    throw new TranscribeNowUnavailable();
  }
  if (!res.ok) {
    throw new Error(`transcribe-now failed: ${res.status}`);
  }
  return res.json();
}

export class TranscribeNowUnavailable extends Error {
  constructor() {
    super("transcribe-now-not-available");
    this.name = "TranscribeNowUnavailable";
  }
}
```

- [ ] **Step 3: TypeScript check**

```bash
cd apps/web-dashboard
npx tsc --noEmit 2>&1 | tail -10
```

Expected: no errors. (If `BrainMemoryItemInfo` / `KnowledgeChunkItem` are used elsewhere with strict typing, fix the call sites — they should still compile because the new fields are optional.)

- [ ] **Step 4: Commit**

```bash
git add apps/web-dashboard/src/lib/api.ts
git commit -m "feat(dashboard): extend types for WARP-214 — status, metadata, transcribeNow"
```

### Task 2.2: lib/mime-icons.ts module

**Files:**
- Create: `apps/web-dashboard/src/lib/mime-icons.ts`
- Test: `apps/web-dashboard/src/__tests__/lib/mime-icons.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web-dashboard/src/__tests__/lib/mime-icons.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  FileText,
  Image as ImageIcon,
  Headphones,
  Film,
  Mail,
  FileArchive,
} from "lucide-react";
import { iconForMime } from "@/lib/mime-icons";

describe("iconForMime", () => {
  it.each([
    ["audio/mpeg", Headphones],
    ["audio/mp4", Headphones],
    ["audio/wav", Headphones],
    ["audio/x-wav", Headphones],
    ["audio/ogg", Headphones],
    ["audio/flac", Headphones],
    ["audio/webm", Headphones],
    ["audio/aac", Headphones],
    ["video/mp4", Film],
    ["video/quicktime", Film],
    ["video/x-matroska", Film],
    ["video/webm", Film],
    ["video/x-msvideo", Film],
    ["video/mpeg", Film],
    ["message/rfc822", Mail],
    ["application/vnd.ms-outlook", Mail],
    ["application/x-msmail", Mail],
    ["application/zip", FileArchive],
    ["application/x-zip-compressed", FileArchive],
    ["application/x-tar", FileArchive],
    ["application/gzip", FileArchive],
    ["application/x-gzip", FileArchive],
    ["application/x-bzip2", FileArchive],
    ["image/png", ImageIcon],
    ["image/jpeg", ImageIcon],
    ["image/webp", ImageIcon],
    ["application/pdf", FileText],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", FileText],
    ["text/plain", FileText],
    ["text/html", FileText],
  ])("returns the right icon for %s", (mime, expected) => {
    expect(iconForMime(mime)).toBe(expected);
  });

  it("falls back to FileText for unknown MIME", () => {
    expect(iconForMime("application/x-octet-stream")).toBe(FileText);
    expect(iconForMime("foo/bar")).toBe(FileText);
    expect(iconForMime("")).toBe(FileText);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/lib/mime-icons.test.ts 2>&1 | tail -10
```

Expected: ModuleNotFoundError on `@/lib/mime-icons`.

- [ ] **Step 3: Create the module**

Create `apps/web-dashboard/src/lib/mime-icons.ts`:

```typescript
/**
 * WARP-214 — central MIME → Lucide icon mapping.
 *
 * Object-icon set: distinct silhouettes that read at chip size (16-20px) and
 * card size (28-32px). Headphones for audio, Film for video, Mail for email,
 * FileArchive for archives. Phase 1 types (text/pdf/docx) keep the existing
 * FileText icon; image/* uses ImageIcon. Unknown MIMEs fall back to FileText.
 *
 * Single source of truth — every dashboard surface (RecentlyIndexedTab,
 * BrainMemoryTab, SearchTab, CitationChip, Breadcrumbs) imports `iconForMime`
 * so adding a new MIME class is one-line edit.
 */

import {
  FileArchive,
  FileText,
  Film,
  Headphones,
  Image as ImageIcon,
  Mail,
  type LucideIcon,
} from "lucide-react";

const MIME_TO_ICON: Record<string, LucideIcon> = {
  // audio (WARP-197)
  "audio/mpeg": Headphones,
  "audio/mp4": Headphones,
  "audio/wav": Headphones,
  "audio/x-wav": Headphones,
  "audio/ogg": Headphones,
  "audio/flac": Headphones,
  "audio/webm": Headphones,
  "audio/aac": Headphones,
  // video (WARP-198)
  "video/mp4": Film,
  "video/quicktime": Film,
  "video/x-matroska": Film,
  "video/webm": Film,
  "video/x-msvideo": Film,
  "video/mpeg": Film,
  // email (WARP-199)
  "message/rfc822": Mail,
  "application/vnd.ms-outlook": Mail,
  "application/x-msmail": Mail,
  // archive (WARP-200)
  "application/zip": FileArchive,
  "application/x-zip-compressed": FileArchive,
  "application/x-tar": FileArchive,
  "application/gzip": FileArchive,
  "application/x-gzip": FileArchive,
  "application/x-bzip2": FileArchive,
  // Phase 1 docs (WARP-201)
  "application/pdf": FileText,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": FileText,
  "application/msword": FileText,
  "text/plain": FileText,
  "text/markdown": FileText,
  "text/csv": FileText,
  "text/html": FileText,
  "text/x-markdown": FileText,
  "application/json": FileText,
  "application/xml": FileText,
};

/**
 * Look up a Lucide icon component for a MIME type.
 * Image MIMEs (image/png, image/jpeg, etc.) all return ImageIcon; everything
 * else uses an explicit table entry, falling back to FileText.
 */
export function iconForMime(mime: string): LucideIcon {
  if (mime.startsWith("image/")) return ImageIcon;
  return MIME_TO_ICON[mime] ?? FileText;
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/lib/mime-icons.test.ts 2>&1 | tail -10
```

Expected: all tests pass (~31 cases including the unknown-MIME fallback set).

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/lib/mime-icons.ts \
        apps/web-dashboard/src/__tests__/lib/mime-icons.test.ts
git commit -m "feat(dashboard): centralized MIME → Lucide icon mapping (WARP-214)"
```

### Task 2.3: components/SourceChannelBadge.tsx

**Files:**
- Create: `apps/web-dashboard/src/components/SourceChannelBadge.tsx`
- Test: `apps/web-dashboard/src/__tests__/components/SourceChannelBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web-dashboard/src/__tests__/components/SourceChannelBadge.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";

describe("SourceChannelBadge", () => {
  it("renders 'transcribed by ASR' for asr_transcript", () => {
    render(<SourceChannelBadge subtitleSource="asr_transcript" warnings={[]} />);
    expect(screen.getByText(/transcribed by ASR/i)).toBeInTheDocument();
  });

  it("renders 'embedded subtitles' for embedded", () => {
    render(<SourceChannelBadge subtitleSource="embedded" warnings={[]} />);
    expect(screen.getByText(/embedded subtitles/i)).toBeInTheDocument();
  });

  it("renders 'text from video frames' for frame_ocr", () => {
    render(<SourceChannelBadge subtitleSource="frame_ocr" warnings={[]} />);
    expect(screen.getByText(/text from video frames/i)).toBeInTheDocument();
  });

  it("renders 'OCR · low confidence' when warnings include low_confidence_ocr", () => {
    const { container } = render(
      <SourceChannelBadge subtitleSource={null} warnings={["low_confidence_ocr"]} />,
    );
    expect(container.textContent).toContain("OCR · low confidence");
  });

  it("renders 'OCR' when warnings include ocr_used (not low confidence)", () => {
    render(<SourceChannelBadge subtitleSource={null} warnings={["ocr_used"]} />);
    expect(screen.getByText(/^OCR$/)).toBeInTheDocument();
  });

  it("returns null when no signal applies (PDF text, plain text, etc.)", () => {
    const { container } = render(
      <SourceChannelBadge subtitleSource={null} warnings={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/SourceChannelBadge.test.tsx 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create the component**

Create `apps/web-dashboard/src/components/SourceChannelBadge.tsx`:

```typescript
"use client";

/**
 * WARP-214 — small "transcribed by ASR" / "embedded subtitles" / "OCR" pill
 * shown in the metadata row alongside size + date on RecentlyIndexedTab and
 * SearchTab cards.
 *
 * Returns null when no signal applies (PDF text, email body, plain text,
 * DOCX) — that's the design's intent: the pill only appears when the channel
 * is "lossy" enough that the user benefits from knowing.
 */

import type { SubtitleSource } from "@/lib/api";

export interface SourceChannelBadgeProps {
  subtitleSource?: SubtitleSource | null;
  warnings: string[];
}

export function SourceChannelBadge({
  subtitleSource,
  warnings,
}: SourceChannelBadgeProps) {
  // Subtitle source wins when present (video extractor + future frame OCR).
  if (subtitleSource === "asr_transcript") {
    return <span className="source-channel-badge">transcribed by ASR</span>;
  }
  if (subtitleSource === "embedded") {
    return <span className="source-channel-badge">embedded subtitles</span>;
  }
  if (subtitleSource === "frame_ocr") {
    return <span className="source-channel-badge">text from video frames</span>;
  }

  // Warnings array — image OCR signals.
  if (warnings.includes("low_confidence_ocr")) {
    return <span className="source-channel-badge">OCR · low confidence</span>;
  }
  if (warnings.includes("ocr_used")) {
    return <span className="source-channel-badge">OCR</span>;
  }

  return null;
}
```

(The `source-channel-badge` Tailwind class can be a one-line addition to the dashboard's `globals.css` or extracted into the component as inline styles. Match whichever pattern the existing badges use — see how `AttachmentChip.tsx` styles its pills.)

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/SourceChannelBadge.test.tsx 2>&1 | tail -10
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/components/SourceChannelBadge.tsx \
        apps/web-dashboard/src/__tests__/components/SourceChannelBadge.test.tsx
git commit -m "feat(dashboard): SourceChannelBadge component (WARP-214)"
```

### Task 2.4: components/Breadcrumbs.tsx

**Files:**
- Create: `apps/web-dashboard/src/components/Breadcrumbs.tsx`
- Test: `apps/web-dashboard/src/__tests__/components/Breadcrumbs.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web-dashboard/src/__tests__/components/Breadcrumbs.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import type { ChainStep } from "@/lib/api";

describe("Breadcrumbs", () => {
  it("returns null at depth 0 (no chain)", () => {
    const { container } = render(<Breadcrumbs chain={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when chain is undefined", () => {
    const { container } = render(<Breadcrumbs chain={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 2 segments + 1 chevron at depth 1 (email → pdf)", () => {
    const chain: ChainStep[] = [
      { filename: "march.eml", mime: "message/rfc822" },
      { filename: "proposal.pdf", mime: "application/pdf" },
    ];
    render(<Breadcrumbs chain={chain} />);
    expect(screen.getByText("march.eml")).toBeInTheDocument();
    expect(screen.getByText("proposal.pdf")).toBeInTheDocument();
    // 1 chevron between 2 segments
    expect(screen.getAllByTestId("breadcrumb-chevron")).toHaveLength(1);
  });

  it("renders 3 segments + 2 chevrons at depth 2 (zip → email → pdf)", () => {
    const chain: ChainStep[] = [
      { filename: "q1-stuff.zip", mime: "application/zip" },
      { filename: "march.eml", mime: "message/rfc822" },
      { filename: "proposal.pdf", mime: "application/pdf" },
    ];
    render(<Breadcrumbs chain={chain} />);
    expect(screen.getByText("q1-stuff.zip")).toBeInTheDocument();
    expect(screen.getByText("march.eml")).toBeInTheDocument();
    expect(screen.getByText("proposal.pdf")).toBeInTheDocument();
    expect(screen.getAllByTestId("breadcrumb-chevron")).toHaveLength(2);
  });

  it("returns null and warns once when chain is malformed (non-array)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<Breadcrumbs chain={"oops" as any} />);
    expect(container.firstChild).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/Breadcrumbs.test.tsx 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create the component**

Create `apps/web-dashboard/src/components/Breadcrumbs.tsx`:

```typescript
"use client";

/**
 * WARP-214 — chevron-joined breadcrumb showing the recursion chain that
 * produced this chunk's text. Max depth-2 cap from the spec, so the chain
 * is at most three segments. Each segment is the MIME icon + filename;
 * segments are joined by chevrons.
 *
 * Returns null at depth 0 (~95% of files don't recurse) — keeps cards
 * clean. Returns null and warns once when chain is malformed.
 */

import { ChevronRight } from "lucide-react";
import { iconForMime } from "@/lib/mime-icons";
import type { ChainStep } from "@/lib/api";

export interface BreadcrumbsProps {
  chain?: ChainStep[];
}

let warnedOnceAboutMalformed = false;

export function Breadcrumbs({ chain }: BreadcrumbsProps) {
  if (!chain) return null;
  if (!Array.isArray(chain)) {
    if (!warnedOnceAboutMalformed) {
      console.warn("[Breadcrumbs] received non-array chain:", chain);
      warnedOnceAboutMalformed = true;
    }
    return null;
  }
  if (chain.length === 0) return null;

  return (
    <div className="breadcrumbs flex flex-wrap items-center gap-1 text-xs">
      {chain.map((step, i) => {
        const Icon = iconForMime(step.mime);
        const isLast = i === chain.length - 1;
        return (
          <span key={`${step.filename}-${i}`} className="flex items-center gap-1">
            <Icon size={12} className="text-label-tertiary" />
            <span className={isLast ? "text-label-primary font-medium" : "text-label-tertiary"}>
              {step.filename}
            </span>
            {!isLast && (
              <ChevronRight
                size={10}
                data-testid="breadcrumb-chevron"
                className="text-label-quaternary"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/Breadcrumbs.test.tsx 2>&1 | tail -10
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/components/Breadcrumbs.tsx \
        apps/web-dashboard/src/__tests__/components/Breadcrumbs.test.tsx
git commit -m "feat(dashboard): Breadcrumbs component (WARP-214)"
```

### Task 2.5: components/StatusChip.tsx

**Files:**
- Create: `apps/web-dashboard/src/components/StatusChip.tsx`
- Test: `apps/web-dashboard/src/__tests__/components/StatusChip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web-dashboard/src/__tests__/components/StatusChip.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusChip } from "@/components/StatusChip";

describe("StatusChip", () => {
  it("renders 'Queued for transcription' for queued_for_transcription", () => {
    render(<StatusChip itemId="bmi-1" status="queued_for_transcription" />);
    expect(screen.getByText(/Queued for transcription/i)).toBeInTheDocument();
  });

  it("shows the kebab overflow only on queued_for_transcription", () => {
    const { rerender } = render(
      <StatusChip itemId="bmi-1" status="queued_for_transcription" />,
    );
    expect(screen.getByLabelText(/more actions/i)).toBeInTheDocument();

    rerender(<StatusChip itemId="bmi-1" status="indexing" />);
    expect(screen.queryByLabelText(/more actions/i)).toBeNull();

    rerender(<StatusChip itemId="bmi-1" status="ready" />);
    expect(screen.queryByLabelText(/more actions/i)).toBeNull();
  });

  it("renders 'Indexing…' for indexing", () => {
    render(<StatusChip itemId="bmi-1" status="indexing" />);
    expect(screen.getByText(/Indexing/i)).toBeInTheDocument();
  });

  it("returns null when status is ready (clean state)", () => {
    const { container } = render(<StatusChip itemId="bmi-1" status="ready" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Failed' for failed and shows the failureReason in tooltip", () => {
    render(
      <StatusChip
        itemId="bmi-1"
        status="failed"
        failureReason="ffmpeg exited with code 1"
      />,
    );
    expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    expect(
      screen.getByTitle(/ffmpeg exited with code 1/i),
    ).toBeInTheDocument();
  });

  it("renders generic 'Processing' for unknown enum value (forward-compat)", () => {
    render(<StatusChip itemId="bmi-1" status={"backfilling" as any} />);
    expect(screen.getByText(/Processing/i)).toBeInTheDocument();
  });

  it("calls onTranscribeNow when 'Transcribe now' is clicked from the kebab", () => {
    const onTranscribeNow = vi.fn();
    render(
      <StatusChip
        itemId="bmi-1"
        status="queued_for_transcription"
        onTranscribeNow={onTranscribeNow}
      />,
    );
    fireEvent.click(screen.getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/Transcribe now/i));
    expect(onTranscribeNow).toHaveBeenCalledWith("bmi-1");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/StatusChip.test.tsx 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create the component**

Create `apps/web-dashboard/src/components/StatusChip.tsx`:

```typescript
"use client";

/**
 * WARP-214 — small status pill on BrainMemoryItem cards.
 *
 * Four enum values:
 *   - queued_for_transcription → "Queued for transcription · runs nightly"
 *     + kebab overflow with discreet "Transcribe now" action (WARP-218)
 *   - indexing → "Indexing…" (animated)
 *   - ready    → null (clean state — chip vanishes when ready)
 *   - failed   → "Failed" + tooltip with failureReason
 *
 * Forward-compat: unknown enum value renders generic "Processing" pill
 * so server-side enum changes can land before the dashboard knows about
 * them.
 */

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { BrainMemoryItemStatus } from "@/lib/api";

export interface StatusChipProps {
  itemId: string;
  status: BrainMemoryItemStatus | string;
  failureReason?: string | null;
  onTranscribeNow?: (itemId: string) => void;
}

export function StatusChip({
  itemId,
  status,
  failureReason,
  onTranscribeNow,
}: StatusChipProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (status === "ready") return null;

  let label: string;
  let className: string;
  if (status === "queued_for_transcription") {
    label = "Queued for transcription · runs nightly";
    className = "status-chip status-chip-queued";
  } else if (status === "indexing") {
    label = "Indexing…";
    className = "status-chip status-chip-indexing";
  } else if (status === "failed") {
    label = "Failed";
    className = "status-chip status-chip-failed";
  } else {
    // Forward-compat for unknown enum values.
    label = "Processing";
    className = "status-chip status-chip-unknown";
  }

  const showOverflow =
    status === "queued_for_transcription" && typeof onTranscribeNow === "function";

  return (
    <div className="inline-flex items-center gap-1">
      <span
        className={className}
        title={status === "failed" ? failureReason ?? undefined : undefined}
      >
        {label}
      </span>
      {showOverflow && (
        <div className="relative">
          <button
            aria-label="More actions"
            className="status-chip-overflow"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="status-chip-menu">
              <button
                className="status-chip-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onTranscribeNow!(itemId);
                }}
              >
                Transcribe now
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

(Match Tailwind / CSS class conventions used by `AttachmentChip.tsx`. The `status-chip-*` classes can live in `globals.css` or be extracted as inline styles.)

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/StatusChip.test.tsx 2>&1 | tail -10
```

Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/components/StatusChip.tsx \
        apps/web-dashboard/src/__tests__/components/StatusChip.test.tsx
git commit -m "feat(dashboard): StatusChip component (WARP-214)"
```

### Task 2.6: lib/hooks/useBrainStatus.ts

**Files:**
- Create: `apps/web-dashboard/src/lib/hooks/useBrainStatus.ts`
- Test: `apps/web-dashboard/src/__tests__/lib/hooks/useBrainStatus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web-dashboard/src/__tests__/lib/hooks/useBrainStatus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useBrainStatus } from "@/lib/hooks/useBrainStatus";

const getBrainMemoryItemsMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getBrainMemoryItems: () => getBrainMemoryItemsMock() };
});

describe("useBrainStatus", () => {
  beforeEach(() => {
    getBrainMemoryItemsMock.mockReset();
  });

  it("seeds state from GET /api/files/brain", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        { id: "bmi-1", filename: "a.wav", mimeType: "audio/wav", sizeBytes: 100, uploadedAt: "...", status: "queued_for_transcription" },
        { id: "bmi-2", filename: "b.txt", mimeType: "text/plain", sizeBytes: 50, uploadedAt: "...", status: "ready" },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => {
      expect(result.current.items.size).toBe(2);
    });
    expect(result.current.items.get("bmi-1")?.status).toBe("queued_for_transcription");
    expect(result.current.items.get("bmi-2")?.status).toBe("ready");
  });

  it("merges WS message into state by itemId", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        { id: "bmi-1", filename: "a.wav", mimeType: "audio/wav", sizeBytes: 100, uploadedAt: "...", status: "indexing" },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => expect(result.current.items.size).toBe(1));

    // Simulate a WS message
    act(() => {
      result.current._testInjectWsMessage({
        topic: "droplet/files/dev/brain/indexed",
        payload: { itemId: "bmi-1", status: "ready" },
      });
    });

    expect(result.current.items.get("bmi-1")?.status).toBe("ready");
  });
});
```

(The `_testInjectWsMessage` helper is a test seam — the hook exposes it only when `process.env.NODE_ENV === "test"`.)

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/lib/hooks/useBrainStatus.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create the hook**

Create `apps/web-dashboard/src/lib/hooks/useBrainStatus.ts`:

```typescript
"use client";

/**
 * WARP-214 — hybrid GET + WS hook for BrainMemoryItem statuses.
 *
 * Initial state from GET /api/files/brain. Subsequent updates from the
 * per-user WS bridge at /api/ws/events (matches the useFileRealtime
 * pattern). On WS disconnect, falls back to a 5-second poll on the GET
 * until WS reconnects.
 *
 * Returns a Map keyed by itemId so callers can render in any order
 * and merge updates by id without array-shuffle re-renders.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getBrainMemoryItems, type BrainMemoryItemInfo } from "@/lib/api";

interface UseBrainStatusReturn {
  items: Map<string, BrainMemoryItemInfo>;
  loading: boolean;
  error: string | null;
  // Test-only seam — only populated when NODE_ENV === "test".
  _testInjectWsMessage?: (msg: { topic: string; payload: any }) => void;
}

const POLL_INTERVAL_MS = 5_000;

export function useBrainStatus(): UseBrainStatusReturn {
  const [items, setItems] = useState<Map<string, BrainMemoryItemInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refreshFromGet = useCallback(async () => {
    try {
      const res = await getBrainMemoryItems();
      const next = new Map<string, BrainMemoryItemInfo>();
      for (const item of res.items) {
        next.set(item.id, item);
      }
      setItems(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? "Failed to load brain memory");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWsMessage = useCallback(
    (msg: { topic?: string; payload?: any }) => {
      if (!msg?.topic?.endsWith("/brain/indexed")) return;
      const { itemId, status } = msg.payload ?? {};
      if (!itemId || !status) return;
      setItems((prev) => {
        const next = new Map(prev);
        const existing = next.get(itemId);
        if (existing) {
          next.set(itemId, { ...existing, status });
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    refreshFromGet();
  }, [refreshFromGet]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(refreshFromGet, POLL_INTERVAL_MS);
    };
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/events`;
      try {
        ws = new WebSocket(url);
      } catch {
        startPoll();
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        stopPoll();
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : "");
          handleWsMessage(data);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          startPoll();
          scheduleReconnect();
        }
      };
      ws.onerror = () => ws?.close();
    };

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
      const jitter = Math.random() * base * 0.25;
      reconnectTimer = setTimeout(connect, base + jitter);
    };

    connect();
    return () => {
      closed = true;
      stopPoll();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [refreshFromGet, handleWsMessage]);

  const out: UseBrainStatusReturn = { items, loading, error };
  if (process.env.NODE_ENV === "test") {
    out._testInjectWsMessage = handleWsMessage;
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/lib/hooks/useBrainStatus.test.ts 2>&1 | tail -10
```

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useBrainStatus.ts \
        apps/web-dashboard/src/__tests__/lib/hooks/useBrainStatus.test.ts
git commit -m "feat(dashboard): useBrainStatus hook — hybrid GET + WS (WARP-214)"
```

### Task 2.7: Update CitationChip to use mime-icons

**Files:**
- Modify: `apps/web-dashboard/src/components/CitationChip.tsx`
- Modify: `apps/web-dashboard/src/__tests__/components/CitationChip.test.tsx`

- [ ] **Step 1: Read the existing CitationChip**

```bash
cat apps/web-dashboard/src/components/CitationChip.tsx
```

Note the props interface and the inline `Icon = source === "brain" ? Sparkles : FileText` line.

- [ ] **Step 2: Modify the component to use iconForMime**

Edit the icon-selection logic:

```typescript
import { iconForMime } from "@/lib/mime-icons";

// ... in the component body, replace:
//   const Icon = source === "brain" ? Sparkles : FileText;
// with:
const Icon = props.mimeType ? iconForMime(props.mimeType) : (source === "brain" ? Sparkles : FileText);
```

Add `mimeType?: string` to `CitationChipProps`. The fallback to Sparkles/FileText preserves existing behavior when callers don't pass `mimeType`.

- [ ] **Step 3: Add a test for the new behavior**

In `apps/web-dashboard/src/__tests__/components/CitationChip.test.tsx`, add:

```typescript
it("uses iconForMime when mimeType prop is provided", () => {
  const { container } = render(
    <CitationChip
      source="brain"
      path="/Brain/meeting.m4a"
      mimeType="audio/mp4"
      score={0.9}
      snippet="..."
    />,
  );
  // The Headphones icon has a distinctive path — assert via SVG presence.
  const svg = container.querySelector("svg");
  expect(svg?.outerHTML).toMatch(/H3 14h3a2/); // Headphones path data
});
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__/components/CitationChip.test.tsx 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/components/CitationChip.tsx \
        apps/web-dashboard/src/__tests__/components/CitationChip.test.tsx
git commit -m "feat(dashboard): CitationChip uses iconForMime when mimeType provided (WARP-214)"
```

### Task 2.8: BrainMemoryTab integration

**Files:**
- Modify: `apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx`

- [ ] **Step 1: Read the existing tab**

```bash
cat apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx
```

Note the current `getBrainMemoryItems` direct call; we're replacing it with `useBrainStatus`.

- [ ] **Step 2: Wire useBrainStatus + StatusChip + iconForMime**

Replace the relevant sections:

```typescript
"use client";

import {
  Download,
  FileArchive,
  Trash2,
} from "lucide-react";
import { useBrainStatus } from "@/lib/hooks/useBrainStatus";
import { iconForMime } from "@/lib/mime-icons";
import { StatusChip } from "@/components/StatusChip";
import { transcribeNow, TranscribeNowUnavailable } from "@/lib/api";

// ... inside the component body:
const { items, loading, error } = useBrainStatus();
const itemArray = Array.from(items.values()).sort(
  (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
);

const onTranscribeNow = async (itemId: string) => {
  try {
    await transcribeNow(itemId);
    // Status flip will arrive via the WS bridge.
  } catch (e) {
    if (e instanceof TranscribeNowUnavailable) {
      // Surface a one-line toast/inline message — "Manual transcription not available yet"
      // Existing error reporter pattern in this file dictates exact UX.
      console.warn("transcribe-now route is 404 — WARP-218 not merged yet");
    } else {
      console.error("transcribe-now failed:", e);
    }
  }
};

// In the JSX rendering each item card, replace the existing icon line with:
const Icon = iconForMime(item.mimeType);
// ... and slot a <StatusChip /> inline:
<StatusChip
  itemId={item.id}
  status={item.status ?? "ready"}
  failureReason={item.failureReason}
  onTranscribeNow={onTranscribeNow}
/>
```

(Keep the existing layout — headers, empty states, button placement. The change is icon mapping + chip injection.)

- [ ] **Step 3: Run the existing tests**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__ -t "BrainMemoryTab" 2>&1 | tail -10
```

Expected: green (existing tests pass; the changes are additive).

- [ ] **Step 4: Commit**

```bash
git add apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx
git commit -m "feat(dashboard): BrainMemoryTab uses iconForMime + StatusChip + useBrainStatus (WARP-214)"
```

### Task 2.9: RecentlyIndexedTab integration

**Files:**
- Modify: `apps/web-dashboard/src/app/knowledge/RecentlyIndexedTab.tsx`

- [ ] **Step 1: Replace the inline fileIconFor with iconForMime**

Open `apps/web-dashboard/src/app/knowledge/RecentlyIndexedTab.tsx`. Find `fileIconFor` (line ~52). Delete it and replace usages:

```typescript
// Delete:
//   function fileIconFor(path: string) { ... }
// Replace each call site:
//   const Icon = fileIconFor(item.path);
// With:
import { iconForMime } from "@/lib/mime-icons";
// inside the component body where item is in scope:
const mime = item.path.endsWith(".pdf") ? "application/pdf" : ""; // or look up properly
// The KnowledgeChunkItem may not carry mimeType today; if not, derive from path extension via a tiny extension-to-mime helper, or use the existing fileIconFor logic but call iconForMime with a synthesized mime string.
```

The cleanest implementation: extend `KnowledgeChunkItem` (orchestrator-side) to include `mimeType`. But that's another backend change — out of scope for WARP-214. Instead, add a small `mimeFromPath` helper in `lib/mime-icons.ts`:

```typescript
// Append to lib/mime-icons.ts:
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
};

export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}
```

(Add a unit test: `mimeFromPath("foo.zip") === "application/zip"`, etc. ~10 cases.)

In `RecentlyIndexedTab.tsx`:

```typescript
import { iconForMime, mimeFromPath } from "@/lib/mime-icons";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";

// Inside the item-card JSX:
const mime = mimeFromPath(item.path);
const Icon = iconForMime(mime);
// Render:
<div className="card">
  <Icon size={20} />
  <span>{item.path}</span>
  <Breadcrumbs chain={item.metadata?.chain} />
  <p>{item.snippet}</p>
  <div className="metadata-row">
    <span>{formatBytes(item.sizeBytes ?? 0)}</span>
    <span>·</span>
    <span>{formatDate(item.indexedAt)}</span>
    <SourceChannelBadge
      subtitleSource={item.metadata?.subtitle_source ?? null}
      warnings={[]}
    />
  </div>
</div>
```

- [ ] **Step 2: Update the existing snapshot/render tests if any**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__ -t "RecentlyIndexedTab" 2>&1 | tail -10
```

Expected: green. If a test asserts the old `FileText` icon explicitly, update it to assert via `data-testid` or the icon's path data.

- [ ] **Step 3: Commit**

```bash
git add apps/web-dashboard/src/lib/mime-icons.ts \
        apps/web-dashboard/src/__tests__/lib/mime-icons.test.ts \
        apps/web-dashboard/src/app/knowledge/RecentlyIndexedTab.tsx
git commit -m "feat(dashboard): RecentlyIndexedTab uses iconForMime + Breadcrumbs + SourceChannelBadge (WARP-214)"
```

### Task 2.10: SearchTab integration

**Files:**
- Modify: `apps/web-dashboard/src/app/knowledge/SearchTab.tsx`

- [ ] **Step 1: Apply the same pattern as RecentlyIndexedTab**

Same imports, same render shape inside the search-results map:

```typescript
import { iconForMime, mimeFromPath } from "@/lib/mime-icons";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";

// In the hits.map(...):
const mime = mimeFromPath(hit.path);
const Icon = iconForMime(mime);
// Render with the same metadata-row pattern as RecentlyIndexedTab.
```

- [ ] **Step 2: Run existing SearchTab tests**

```bash
cd apps/web-dashboard
npx vitest run src/__tests__ -t "SearchTab" 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add apps/web-dashboard/src/app/knowledge/SearchTab.tsx
git commit -m "feat(dashboard): SearchTab uses iconForMime + Breadcrumbs + SourceChannelBadge (WARP-214)"
```

---

## Phase 3 — Manual smoke + push

### Task 3.1: Run the full dashboard suite

- [ ] **Step 1: Full vitest run**

```bash
cd apps/web-dashboard
npm test 2>&1 | tail -20
```

Expected: all green (the existing ~246 tests + ~30 new from this PR).

- [ ] **Step 2: Full orchestrator run**

```bash
cd apps/orchestrator
npm test 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 3: Full file-indexer run**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -10
```

Expected: green (some integration tests skip without RUN_RAG_INTEGRATION; that's expected).

### Task 3.2: Local-validation gate (per spec §8)

- [ ] **Step 1: Bring up the test stack**

```bash
./scripts/test-rag.sh --no-down
```

Expected: Compose stack boots in ~5–10 min on cold cache.

- [ ] **Step 2: Drop a `.zip` containing a nested `.eml` containing a `.pdf`**

Use the existing fixtures:

```bash
mkdir -p /tmp/warp214-fixture
cp services/file-indexer/tests/fixtures/with-pdf-attachment.eml /tmp/warp214-fixture/march.eml
zip /tmp/warp214-fixture/q1-stuff.zip /tmp/warp214-fixture/march.eml

curl -X POST http://localhost:3000/api/files/brain/upload \
  -F "file=@/tmp/warp214-fixture/q1-stuff.zip"
```

Expected: 202 with `{itemId, status}`. (`status` is `indexing` or `queued_for_transcription` depending on whether WARP-218 is merged.)

- [ ] **Step 3: Open the dashboard at /knowledge and verify**

Open `http://localhost:3000/knowledge` in a browser. Verify:

- The brain-memory item shows the `FileArchive` icon (amber).
- The status chip shows the right state (or vanishes when `ready`).
- Hit Search → search for "budget meeting kickoff" or whatever the inner PDF contains. Verify the result card shows:
  - the chevron breadcrumb `q1-stuff.zip › march.eml › proposal.pdf`
  - the metadata row with date/size
- Click a breadcrumb segment — verifies it links somewhere reasonable.

- [ ] **Step 4: Tear down**

```bash
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml down
```

- [ ] **Step 5: Document the smoke result in the PR body** (verbatim, e.g. "manual smoke: dropped q1-stuff.zip, breadcrumb rendered as expected, status flipped from indexing to ready in 12s").

### Task 3.3: Push WARP-214

- [ ] **Step 1: Final state check**

```bash
git status
git log --oneline main..HEAD | head -25
```

Expected: clean tree, ~16-20 commits since main.

- [ ] **Step 2: Push**

```bash
git push -u origin WARP-214
```

- [ ] **Step 3: Hand off to QA**

Do NOT open the PR yet. Return a self-assessment per the harness flow with these section headers:

```
## Self-assessment

### What I built
- [files created/modified, line counts]

### Tests
- [unit test counts per file]
- [orchestrator + file-indexer suite results]

### Decisions / deviations
- [anything decided differently from the plan, with rationale]

### Known limits / follow-ups
- [things noticed but not fixed because out of scope]

### Manager-call items (if any)
- [places where the plan was silent/ambiguous]

### Local-validation snapshot
- [output of the full smoke described in Task 3.2]

### Commit log
- [git log --oneline since branch base]
```

Manager turns this into the PR body and dispatches QA.

---

## Self-review checklist (run before pushing)

1. **Spec coverage:** §1 goals (4 deliverables), §3 architecture (frontend + 1-line backend → expanded to persistence path), §4 file structure, §5.1–5.4 visual decisions, §6 data flow, §7 error handling, §8 testing — every section maps to a task.

2. **No placeholders:** search the diff for `TODO`, `TBD`, `FIXME`, `placeholder`. Should return zero hits except in pre-existing strings (e.g. test mock comments).

3. **Type consistency:** `BrainMemoryItemInfo` has `status` + `failureReason` (Task 2.1). `KnowledgeChunkItem` + `KnowledgeSearchHit` both have `metadata` (Task 2.1). `ChainStep` shape (`{filename, mime, parentItemId?}`) is uniform across email (Task 1.5), archive (Task 1.6), and Breadcrumbs (Task 2.4). `BrainMemoryItemStatus` enum is the same value set in `lib/api.ts`, `StatusChip`, and `useBrainStatus`.

4. **Tests run green locally before pushing** — caught any breakage during incremental task runs, plus full suites in Task 3.1.

5. **No forbidden surfaces touched** — no changes to `@droplet/tools-core`, no changes to existing migrations (only adds a new one), no changes to `setup.sh` or production Compose files.

6. **Local smoke documented in the PR** — see Task 3.2.
