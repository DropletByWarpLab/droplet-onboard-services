# RAG System Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the existing `services/file-indexer/` skeleton with real extractors (PDF, DOCX, image OCR, text/code/HTML), wire `embedText` into the orchestrator's MCP context so the existing `search_content` tool actually retrieves, add a separate per-user "brain memory" tier for chat-attached files external to Nextcloud, ship the `/knowledge` dashboard view, and prove the full path with a live end-to-end test against the Compose stack.

**Architecture:** Extractor dispatch in `services/file-indexer/extractors/` per MIME family. Brain memory at `/data/brain-memory/<userId>/<itemId>/` with a `BrainMemoryItem` Prisma manifest + `source` discriminator on `FileContentChunk`. `file-search.service.ts` is the single shared retrieval module backing both the LLM tool and the dashboard. Six tickets WARP-201..206; WARP-201 first, then 202/203/204 in parallel, then 205, then 206.

**Tech Stack:**
- Backend: Node.js 20, TypeScript, Express, Prisma 5, PostgreSQL with pgvector, Python 3.12 (file-indexer), watchdog, gRPC
- Frontend: Next.js 14, React 18, SWR, Tailwind, lucide-react
- New deps: `pypdf>=4.0`, `python-docx>=1.0`, `pytesseract>=0.3.10`, `Pillow>=10.0`, `readability-lxml>=0.8`; `tesseract-ocr` + `tesseract-ocr-eng` system packages
- Infra: Docker Compose, GitHub Actions, MQTT (existing Mosquitto), `@grpc/grpc-js` (orchestrator-side gRPC client)

**Spec:** [`docs/superpowers/specs/2026-04-28-rag-system-design.md`](../specs/2026-04-28-rag-system-design.md) (authoritative — read before starting any ticket).

**Ticket → branch → PR:** Six tickets [WARP-201..206](https://warp-lab.atlassian.net/browse/WARP-201). Each ships as its own PR through the agent harness (Dev → QA → UI/UX → Manager → PR → CI → Code Reviewer → human merge). UI/UX gate runs on WARP-203 (chat drop-zone UX) and WARP-204 (`/knowledge` view).

**Execution order:**

1. **WARP-201** (foundation extractors) — must merge first.
2. **WARP-202**, **WARP-203**, **WARP-204** — parallel after WARP-201 merges.
3. **WARP-205** (export/delete) — after WARP-203.
4. **WARP-206** (end-to-end smoke) — after WARP-202 + WARP-203 + WARP-204.

---

## File Structure

### WARP-201 — Foundation extractors

| Path | Purpose |
|---|---|
| `services/file-indexer/extractors/__init__.py` (modify) | Re-export `dispatch()` |
| `services/file-indexer/extractors/registry.py` (new) | MIME → extractor map; size + char caps; `dispatch(path, mime) → ExtractedDoc \| None` |
| `services/file-indexer/extractors/types.py` (new) | `ExtractedDoc` TypedDict |
| `services/file-indexer/extractors/text.py` (new) | txt, md, csv, code, html via `readability-lxml` |
| `services/file-indexer/extractors/pdf.py` (new) | `pypdf` text extraction with page breaks |
| `services/file-indexer/extractors/docx.py` (new) | `python-docx` with paragraph→page mapping |
| `services/file-indexer/extractors/image.py` (new) | `pytesseract` + `Pillow` with mean-confidence warnings |
| `services/file-indexer/watcher.py` (modify) | Wire `extractors.dispatch()` into the existing watcher's read-and-index path |
| `services/file-indexer/Dockerfile` (modify) | Add `tesseract-ocr` + `tesseract-ocr-eng` system packages |
| `services/file-indexer/requirements.txt` (modify) | Add new Python deps |
| `services/file-indexer/tests/test_extractors.py` (new) | Unit tests per extractor + dispatch unknown-MIME |
| `services/file-indexer/tests/fixtures/` (new) | Per-extractor public-domain sample files |
| `tests/rag-extractors.integration.test.ts` (new) | Live integration test booting compose, drops fixtures, asserts chunks |

### WARP-202 — embedText wiring + search_content live

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/services/embedding.client.ts` (new) | gRPC client to ai-gateway `EmbedText` (TypeScript mirror of `services/file-indexer/embedder.py`) |
| `apps/orchestrator/proto/inference.proto` (no changes — generated stubs only) | Inherit existing |
| `apps/orchestrator/scripts/generate-grpc.sh` (modify) | Generate TS stubs alongside Python ones |
| `apps/orchestrator/src/services/file-search.service.ts` (new) | Single source of truth for cosine + recency queries — used by both MCP tool and dashboard routes |
| `services/mcp-server/src/index.ts` (modify) | Instantiate the embedding client in the stdio child; expose via `ContextDeps` |
| `services/mcp-server/src/context.ts` (modify) | `buildContext()` passes `ctx.embedText` from deps |
| `services/mcp-server/__tests__/embedtext-wiring.test.ts` (new) | Asserts `ctx.embedText` is callable from a handler |
| `tests/rag-search.integration.test.ts` (new) | Live integration test: boot compose, index a fixture, run MCP `search_content`, assert non-empty result with the right shape |

### WARP-203 — BrainMemoryItem + brain-upload + ingest pipeline

| Path | Purpose |
|---|---|
| `apps/orchestrator/prisma/schema.prisma` (modify) | Add `BrainMemoryItem`, `BrainMemorySource`, `FileContentSource` enums; extend `FileContentChunk` with `source`, `brainItemId`, `pageNumber`, `warnings` + composite index |
| `apps/orchestrator/prisma/migrations/20260428000000_brain_memory/migration.sql` (new) | Prisma-generated migration + idempotent seed |
| `apps/orchestrator/src/routes/files-brain.ts` (new) | `POST /api/files/brain/upload`, `GET /api/files/brain/:itemId`, `GET /api/files/brain` |
| `apps/orchestrator/src/services/brain-memory.service.ts` (new) | Filesystem operations + manifest writer + cascade helper |
| `apps/orchestrator/src/index.ts` (modify) | Mount the new router |
| `docker/docker-compose.yml` (modify) | Add `brain-memory-data` volume bind-mounted into orchestrator + file-indexer |
| `services/file-indexer/main.py` (modify) | Subscribe to `droplet/files/brain/uploaded`, dispatch through extractors, set `source="brain"` |
| `services/file-indexer/db.py` (modify) | Add `source` + `brainItemId` columns to `upsert_chunk()` signature |
| `services/file-indexer/mqtt_client.py` (modify) | Publish `droplet/files/brain/indexed` when finished |
| `apps/web-dashboard/src/components/ChatInput.tsx` (modify) | File drop-zone + multi-file input |
| `apps/web-dashboard/src/lib/hooks/useChat.ts` (modify) | `attach(file)` method + chip state machine + MQTT subscription |
| `apps/web-dashboard/src/lib/api.ts` (modify) | `uploadBrainAttachment(file)` calling the new route |
| `apps/web-dashboard/src/components/AttachmentChip.tsx` (new) | Chip rendering per status |
| `apps/orchestrator/src/__tests__/files-brain.test.ts` (new) | supertest unit coverage |
| `tests/rag-brain-upload.integration.test.ts` (new) | Live integration: upload, poll for indexedAt, assert chunks |

### WARP-204 — `/knowledge` dashboard view

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/routes/files-knowledge.ts` (new) | `GET /api/files/recent`, `GET /api/files/search` |
| `apps/orchestrator/src/index.ts` (modify) | Mount the new router |
| `apps/web-dashboard/src/app/knowledge/page.tsx` (new) | Top-level `/knowledge` route — tab container |
| `apps/web-dashboard/src/app/knowledge/RecentlyIndexedTab.tsx` (new) | Day-grouped cards with infinite scroll |
| `apps/web-dashboard/src/app/knowledge/SearchTab.tsx` (new) | Search input + results render |
| `apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx` (new) | List + per-item actions |
| `apps/web-dashboard/src/components/CitationChip.tsx` (new — extracted from chat surface) | Shared citation chip used by both `/knowledge` and `/chat` |
| `apps/web-dashboard/src/lib/api.ts` (modify) | `getRecentFiles`, `searchFiles`, `getBrainMemoryItems` |
| `apps/web-dashboard/src/components/Nav.tsx` (modify) | New "Knowledge" nav entry |
| `apps/orchestrator/src/__tests__/files-knowledge.test.ts` (new) | supertest coverage |
| `apps/web-dashboard/src/__tests__/knowledge.test.tsx` (new) | Vitest + Testing Library |
| `tests/rag-knowledge.integration.test.ts` (new) | Live integration: seed both sources, assert API shapes |

### WARP-205 — Brain memory export + delete + cascade

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/routes/files-brain.ts` (modify) | Add `GET /api/files/brain/export`, `DELETE /api/files/brain/:itemId` |
| `apps/orchestrator/src/services/brain-memory.service.ts` (modify) | `streamExportZip(...)`, `deleteItem(...)`, `purgeUser(userId)` |
| `apps/orchestrator/src/routes/auth.ts` (modify) | Wire `purgeUser(userId)` into the user-deletion path |
| `apps/web-dashboard/src/app/knowledge/BrainMemoryTab.tsx` (modify) | Wire delete + download + export buttons |
| `apps/web-dashboard/src/app/chat/SessionHeader.tsx` (modify) | "Export brain memory for this chat" affordance |
| `apps/orchestrator/src/__tests__/files-brain-export.test.ts` (new) | Unit coverage |
| `tests/rag-brain-export.integration.test.ts` (new) | Live integration: zip stream + delete + cascade |

### WARP-206 — End-to-end smoke + CI workflow

| Path | Purpose |
|---|---|
| `tests/rag-end-to-end.integration.test.ts` (new) | Boots full stack; PDF + image; LLM citation assertions |
| `.github/workflows/rag-tests.yml` (new) | Path-filtered workflow running per-extractor + brain-upload + knowledge + end-to-end tests |
| `scripts/test-rag.sh` (new) | Local fast-loop runner |
| `docs/RAG_TESTING.md` (new) | Operator docs |
| `tests/package.json` (modify) | Add `test:rag` script |
| `services/file-indexer/README.md` (modify) | Reference the testing flow |

---

## Pre-flight: Branch + tickets

These run before any ticket starts and live on the `RAG-foundation` branch (already created and pushed for the spec).

### Task 0.1: Verify branch + spec is committed

- [ ] **Step 1: Check current state**

```bash
git status
git rev-parse --abbrev-ref HEAD
git log -1 --format="%h %s"
```

Expected: branch `RAG-foundation`, clean tree, last commit is the spec commit (`docs: design for RAG system Phase 1`).

- [ ] **Step 2: Confirm tickets exist**

```bash
gh api 'projects/v3' >/dev/null 2>&1 || echo "(skipping — gh projects v3 access not configured; verify manually in Jira)"
```

Verify in Jira browser:
- WARP-201 through WARP-206 exist, all in "To Do".
- WARP-197 through WARP-200 exist (Phase 2 deferred).

---

## WARP-201 — Foundation extractors

**Branch:** `WARP-201` (off `main` after RAG-foundation spec/plan merges)
**Spec sections:** §5 (extractor architecture), §11 (testing strategy)

### Task 1.1: Define `ExtractedDoc` shape

**Files:**
- Create: `services/file-indexer/extractors/types.py`

- [ ] **Step 1: Write file**

```python
"""Shared types for the extractor family.

Every extractor produces an `ExtractedDoc` so the chunker + db layer
don't need per-format conditional logic.
"""
from __future__ import annotations
from typing import Optional, TypedDict


class ExtractedDoc(TypedDict, total=False):
    text: str                    # required — canonical UTF-8 text fed to the chunker
    page_breaks: list[int]       # optional — byte/char offsets where source pages break
    language: Optional[str]      # optional — detected via langdetect; None if unknown
    metadata: dict               # required — title, author, page_count, word_count, extractor_name, extractor_version
    warnings: list[str]          # required — e.g. ["low_confidence_ocr_page_3"]
```

- [ ] **Step 2: Commit**

```bash
git add services/file-indexer/extractors/types.py
git commit -m "feat(file-indexer): ExtractedDoc shape for extractor family (WARP-201)"
```

### Task 1.2: Build the dispatch registry with size caps

**Files:**
- Create: `services/file-indexer/extractors/registry.py`
- Test: `services/file-indexer/tests/test_extractors.py`

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the extractor registry's dispatch + size-cap behavior.

Per-extractor tests live in their own files (test_extractors_pdf.py, etc.).
"""
import os
import pytest
from extractors.registry import dispatch, MAX_INDEX_BYTES


def test_dispatch_unknown_mime_returns_none(tmp_path):
    f = tmp_path / "data.unknown-binary"
    f.write_bytes(b"\x00\x01\x02")
    result = dispatch(str(f), "application/x-unknown")
    assert result is None


def test_dispatch_oversized_skips(tmp_path, monkeypatch):
    f = tmp_path / "huge.txt"
    f.write_text("x")
    # Pretend the file is huge by patching os.path.getsize.
    monkeypatch.setattr(os.path, "getsize", lambda p: MAX_INDEX_BYTES + 1)
    result = dispatch(str(f), "text/plain")
    assert result is None


def test_dispatch_text_returns_extracted_doc(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("hello world\n")
    result = dispatch(str(f), "text/plain")
    assert result is not None
    assert "hello world" in result["text"]
    assert result["metadata"]["extractor_name"] == "text"
```

- [ ] **Step 2: Run (expect fail — module missing)**

```bash
cd services/file-indexer
pytest tests/test_extractors.py -v
```

Expected: FAIL — `ModuleNotFoundError` on `extractors.registry`.

- [ ] **Step 3: Write the registry**

```python
"""MIME → extractor dispatch.

Caller responsibility: pass the path to a real file + the detected MIME.
We pick the right extractor, run it, and return the `ExtractedDoc`.
Returns None when:
  - The MIME is not known.
  - The file is over MAX_INDEX_BYTES.
  - The extractor itself errored (logged; chunks just don't get written).
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

MAX_INDEX_BYTES = int(os.environ.get("MAX_INDEX_BYTES", 50 * 1024 * 1024))
MAX_INDEX_CHARS = int(os.environ.get("MAX_INDEX_CHARS", 5_000_000))


def _route(mime: str) -> Optional[Callable[[str], ExtractedDoc]]:
    # Lazy import so test runners can monkeypatch individual extractors.
    if mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        from extractors.text import extract as text_extract  # noqa: PLC0415
        return text_extract
    if mime == "application/pdf":
        from extractors.pdf import extract as pdf_extract  # noqa: PLC0415
        return pdf_extract
    if mime in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    }:
        from extractors.docx import extract as docx_extract  # noqa: PLC0415
        return docx_extract
    if mime.startswith("image/"):
        from extractors.image import extract as image_extract  # noqa: PLC0415
        return image_extract
    return None


def dispatch(path: str, mime: str) -> Optional[ExtractedDoc]:
    try:
        size = os.path.getsize(path)
    except OSError as e:
        logger.warning("dispatch: cannot stat %s: %s", path, e)
        return None
    if size > MAX_INDEX_BYTES:
        logger.info("dispatch: skipping oversized file %s (%d bytes > %d)", path, size, MAX_INDEX_BYTES)
        return None

    fn = _route(mime)
    if fn is None:
        logger.debug("dispatch: no extractor for mime=%s path=%s", mime, path)
        return None

    try:
        doc = fn(path)
    except Exception as e:
        logger.warning("dispatch: extractor %s failed on %s: %s", fn.__name__, path, e)
        return None

    # Truncate-and-warn if the extracted text is huge.
    text = doc.get("text", "")
    if len(text) > MAX_INDEX_CHARS:
        doc["text"] = text[:MAX_INDEX_CHARS]
        warnings = doc.setdefault("warnings", [])
        warnings.append(f"truncated_at_{MAX_INDEX_CHARS}_chars")

    return doc
```

- [ ] **Step 4: Stub-import the extractor modules so pytest collection doesn't crash before they exist**

Create empty `__init__.py`-equivalents (we'll fill these in next tasks):

```bash
mkdir -p services/file-indexer/extractors
cat > services/file-indexer/extractors/text.py <<'PY'
"""Placeholder. Filled in by Task 1.3."""
from extractors.types import ExtractedDoc
def extract(path: str) -> ExtractedDoc:
    raise NotImplementedError("text extractor — Task 1.3")
PY
cat > services/file-indexer/extractors/pdf.py <<'PY'
"""Placeholder. Filled in by Task 1.4."""
from extractors.types import ExtractedDoc
def extract(path: str) -> ExtractedDoc:
    raise NotImplementedError("pdf extractor — Task 1.4")
PY
cat > services/file-indexer/extractors/docx.py <<'PY'
"""Placeholder. Filled in by Task 1.5."""
from extractors.types import ExtractedDoc
def extract(path: str) -> ExtractedDoc:
    raise NotImplementedError("docx extractor — Task 1.5")
PY
cat > services/file-indexer/extractors/image.py <<'PY'
"""Placeholder. Filled in by Task 1.6."""
from extractors.types import ExtractedDoc
def extract(path: str) -> ExtractedDoc:
    raise NotImplementedError("image extractor — Task 1.6")
PY
```

- [ ] **Step 5: Run the registry tests (text-extractor stub will raise; that's OK for the unknown-MIME and oversized tests; the third test will fail until Task 1.3)**

```bash
cd services/file-indexer
pytest tests/test_extractors.py::test_dispatch_unknown_mime_returns_none tests/test_extractors.py::test_dispatch_oversized_skips -v
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/registry.py services/file-indexer/extractors/{text,pdf,docx,image}.py services/file-indexer/tests/test_extractors.py
git commit -m "feat(file-indexer): extractor dispatch registry with size + char caps (WARP-201)"
```

### Task 1.3: Text extractor (txt, md, csv, code, html)

**Files:**
- Modify: `services/file-indexer/extractors/text.py`
- Test: `services/file-indexer/tests/test_extractors_text.py` (new)

- [ ] **Step 1: Write the failing test**

```python
import pytest
from extractors.text import extract


def test_plain_text(tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("Hello world.\nSecond line.\n", encoding="utf-8")
    doc = extract(str(f))
    assert "Hello world" in doc["text"]
    assert "Second line" in doc["text"]
    assert doc["metadata"]["extractor_name"] == "text"
    assert doc["metadata"]["word_count"] >= 4


def test_html_strips_boilerplate(tmp_path):
    f = tmp_path / "page.html"
    f.write_text(
        "<html><head><script>var x=1;</script></head><body>"
        "<nav>Skip me</nav>"
        "<article><h1>Real Title</h1><p>Real content here.</p></article>"
        "</body></html>",
        encoding="utf-8",
    )
    doc = extract(str(f))
    assert "Real Title" in doc["text"]
    assert "Real content here" in doc["text"]
    # Boilerplate should be stripped.
    assert "Skip me" not in doc["text"]
    assert "var x" not in doc["text"]


def test_csv_passthrough(tmp_path):
    f = tmp_path / "data.csv"
    f.write_text("col1,col2\nA,1\nB,2\n", encoding="utf-8")
    doc = extract(str(f))
    assert "col1,col2" in doc["text"]
    assert "A,1" in doc["text"]


def test_unicode_decode_fallback(tmp_path):
    f = tmp_path / "weird.txt"
    f.write_bytes(b"\xff\xfe\x00\x00plain ASCII tail")
    # Should not raise; should fall back to errors='replace'.
    doc = extract(str(f))
    assert "plain ASCII tail" in doc["text"]
```

- [ ] **Step 2: Run (expect fail — `NotImplementedError`)**

```bash
cd services/file-indexer
pytest tests/test_extractors_text.py -v
```

- [ ] **Step 3: Implement**

Replace `services/file-indexer/extractors/text.py` with:

```python
"""Text extractor: txt, md, csv, code, html.

HTML uses readability-lxml to strip nav/ads/boilerplate before chunking;
falls back to plain-text on parse error.
"""
from __future__ import annotations

import os
from typing import cast

from extractors.types import ExtractedDoc


_HTML_EXT = {".html", ".htm", ".xhtml"}


def _read_text(path: str) -> str:
    # Try utf-8 first, fall back to latin-1 with replace so we never crash.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except UnicodeDecodeError:
        with open(path, "r", encoding="latin-1", errors="replace") as fh:
            return fh.read()


def _strip_html(raw: str) -> str:
    try:
        from readability import Document  # readability-lxml
        doc = Document(raw)
        # Document.summary() returns HTML; strip tags via lxml html_to_text-ish.
        from lxml import html  # type: ignore
        tree = html.fromstring(doc.summary())
        text = tree.text_content().strip()
        return text or raw  # if readability stripped everything, fall back to raw
    except Exception:
        # Last-resort: very crude tag strip.
        import re
        return re.sub(r"<[^>]+>", " ", raw)


def extract(path: str) -> ExtractedDoc:
    ext = os.path.splitext(path)[1].lower()
    raw = _read_text(path)
    if ext in _HTML_EXT or raw.lstrip().lower().startswith("<!doctype html") or raw.lstrip().lower().startswith("<html"):
        text = _strip_html(raw)
    else:
        text = raw

    text = text.strip()
    word_count = len(text.split())

    return cast(
        ExtractedDoc,
        {
            "text": text,
            "page_breaks": [],
            "language": None,
            "metadata": {
                "extractor_name": "text",
                "extractor_version": "1.0",
                "word_count": word_count,
            },
            "warnings": [],
        },
    )
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
pytest tests/test_extractors_text.py -v
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run the registry test that depends on text extractor**

```bash
pytest tests/test_extractors.py::test_dispatch_text_returns_extracted_doc -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/text.py services/file-indexer/tests/test_extractors_text.py
git commit -m "feat(file-indexer): text/html/csv/code extractor (WARP-201)"
```

### Task 1.4: PDF extractor

**Files:**
- Modify: `services/file-indexer/extractors/pdf.py`
- Test: `services/file-indexer/tests/test_extractors_pdf.py` (new)
- Modify: `services/file-indexer/requirements.txt`
- Add fixture: `services/file-indexer/tests/fixtures/sample.pdf` (small public-domain PDF)

- [ ] **Step 1: Add `pypdf>=4.0` to `requirements.txt`**

```bash
echo 'pypdf>=4.0' >> services/file-indexer/requirements.txt
pip install -r services/file-indexer/requirements.txt
```

- [ ] **Step 2: Add a small PDF fixture**

Use a small public-domain PDF (e.g. a short Project Gutenberg PDF, or generate one via `reportlab` or even a hand-written PDF). For the plan, generate a 2-page test fixture programmatically once and commit:

```bash
mkdir -p services/file-indexer/tests/fixtures
python - <<'PY'
from pypdf import PdfWriter, PdfReader
from io import BytesIO
# Generate via reportlab (already a transitive dep of pypdf? if not, install)
from reportlab.pdfgen import canvas
buf = BytesIO()
c = canvas.Canvas(buf)
c.drawString(100, 750, "Hello from page one of the test fixture.")
c.showPage()
c.drawString(100, 750, "And here is page two with a unique phrase: alphahotel.")
c.showPage()
c.save()
with open("services/file-indexer/tests/fixtures/sample.pdf", "wb") as f:
    f.write(buf.getvalue())
PY
```

If `reportlab` isn't installed, add to requirements-dev.txt:
```bash
echo 'reportlab>=4.0' >> services/file-indexer/requirements-dev.txt
pip install reportlab
```
Then re-run the generator. Verify the file exists:
```bash
ls -la services/file-indexer/tests/fixtures/sample.pdf
```

- [ ] **Step 3: Write the failing test**

```python
import os
from pathlib import Path
from extractors.pdf import extract


FIXTURE = Path(__file__).parent / "fixtures" / "sample.pdf"


def test_extract_two_page_pdf():
    assert FIXTURE.exists(), f"missing fixture {FIXTURE}"
    doc = extract(str(FIXTURE))
    assert "Hello from page one" in doc["text"]
    assert "alphahotel" in doc["text"]
    assert doc["metadata"]["extractor_name"] == "pdf"
    assert doc["metadata"]["page_count"] == 2
    # Page breaks recorded so citations can deep-link.
    assert len(doc["page_breaks"]) == 2  # one entry per page boundary


def test_extract_corrupt_pdf_raises_caught_in_dispatch(tmp_path):
    f = tmp_path / "corrupt.pdf"
    f.write_bytes(b"%PDF-not-actually")
    # extract() raising is OK — registry.dispatch swallows.
    import pytest
    with pytest.raises(Exception):
        extract(str(f))
```

- [ ] **Step 4: Run (expect fail — NotImplementedError)**

```bash
cd services/file-indexer
pytest tests/test_extractors_pdf.py -v
```

- [ ] **Step 5: Implement**

```python
"""PDF extractor using pypdf.

Records per-page text + the cumulative character offset where each page
ended, so chunkers / citation rendering can deep-link to a page number.
"""
from __future__ import annotations

from typing import cast

from pypdf import PdfReader

from extractors.types import ExtractedDoc


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    parts: list[str] = []
    page_breaks: list[int] = []
    cum = 0
    for page in reader.pages:
        text = (page.extract_text() or "").strip()
        if text:
            parts.append(text)
            cum += len(text) + 2  # +2 for "\n\n" join below
        page_breaks.append(cum)

    full_text = "\n\n".join(parts)

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": page_breaks,
            "language": None,
            "metadata": {
                "extractor_name": "pdf",
                "extractor_version": "1.0",
                "page_count": len(reader.pages),
                "word_count": len(full_text.split()),
            },
            "warnings": [],
        },
    )
```

- [ ] **Step 6: Run tests**

```bash
pytest tests/test_extractors_pdf.py -v
```

Expected: PASS — 2 tests.

- [ ] **Step 7: Commit**

```bash
git add services/file-indexer/extractors/pdf.py services/file-indexer/tests/test_extractors_pdf.py services/file-indexer/tests/fixtures/sample.pdf services/file-indexer/requirements.txt services/file-indexer/requirements-dev.txt
git commit -m "feat(file-indexer): pypdf extractor with page breaks (WARP-201)"
```

### Task 1.5: DOCX extractor

**Files:**
- Modify: `services/file-indexer/extractors/docx.py`
- Test: `services/file-indexer/tests/test_extractors_docx.py` (new)
- Modify: `services/file-indexer/requirements.txt`
- Fixture: `services/file-indexer/tests/fixtures/sample.docx`

- [ ] **Step 1: Add dep + generate fixture**

```bash
echo 'python-docx>=1.0' >> services/file-indexer/requirements.txt
pip install python-docx

python - <<'PY'
from docx import Document
d = Document()
d.add_heading("Test Document", level=1)
d.add_paragraph("First paragraph with the unique token bravoindigo.")
d.add_paragraph("Second paragraph for the test.")
d.save("services/file-indexer/tests/fixtures/sample.docx")
PY
```

- [ ] **Step 2: Write failing test**

```python
from pathlib import Path
from extractors.docx import extract

FIXTURE = Path(__file__).parent / "fixtures" / "sample.docx"


def test_extract_docx():
    doc = extract(str(FIXTURE))
    assert "Test Document" in doc["text"]
    assert "bravoindigo" in doc["text"]
    assert doc["metadata"]["extractor_name"] == "docx"
    assert doc["metadata"]["word_count"] >= 5
```

- [ ] **Step 3: Run (expect fail)**

```bash
pytest tests/test_extractors_docx.py -v
```

- [ ] **Step 4: Implement**

```python
"""DOCX extractor using python-docx."""
from __future__ import annotations

from typing import cast

from docx import Document

from extractors.types import ExtractedDoc


def extract(path: str) -> ExtractedDoc:
    document = Document(path)
    parts: list[str] = []
    for para in document.paragraphs:
        text = para.text.strip()
        if text:
            parts.append(text)

    # Tables go too — flatten cell text.
    for table in document.tables:
        for row in table.rows:
            row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                parts.append(row_text)

    full_text = "\n\n".join(parts)

    return cast(
        ExtractedDoc,
        {
            "text": full_text,
            "page_breaks": [],  # python-docx doesn't track page breaks reliably
            "language": None,
            "metadata": {
                "extractor_name": "docx",
                "extractor_version": "1.0",
                "paragraph_count": len(document.paragraphs),
                "word_count": len(full_text.split()),
            },
            "warnings": [],
        },
    )
```

- [ ] **Step 5: Run tests**

```bash
pytest tests/test_extractors_docx.py -v
```

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/docx.py services/file-indexer/tests/test_extractors_docx.py services/file-indexer/tests/fixtures/sample.docx services/file-indexer/requirements.txt
git commit -m "feat(file-indexer): python-docx extractor (WARP-201)"
```

### Task 1.6: Image OCR extractor

**Files:**
- Modify: `services/file-indexer/extractors/image.py`
- Test: `services/file-indexer/tests/test_extractors_image.py` (new)
- Modify: `services/file-indexer/requirements.txt`
- Modify: `services/file-indexer/Dockerfile` (system tesseract)
- Fixture: `services/file-indexer/tests/fixtures/sample.png`

- [ ] **Step 1: Add deps + Dockerfile + fixture**

```bash
echo 'pytesseract>=0.3.10' >> services/file-indexer/requirements.txt
echo 'Pillow>=10.0' >> services/file-indexer/requirements.txt
pip install pytesseract Pillow
```

In `services/file-indexer/Dockerfile`, before the `pip install` line, add:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
```

Generate a fixture (white background with the OCR-friendly text "echofoxtrot"):

```bash
python - <<'PY'
from PIL import Image, ImageDraw, ImageFont
img = Image.new("RGB", (300, 80), color="white")
d = ImageDraw.Draw(img)
# Use the default font; OCR will get crisp results for clean text.
d.text((10, 25), "echofoxtrot OCR sample", fill="black")
img.save("services/file-indexer/tests/fixtures/sample.png")
PY
```

Verify Tesseract is installed locally for tests (if not in Docker):
```bash
which tesseract || echo "Install with: brew install tesseract  (macOS) or apt install tesseract-ocr (Linux)"
```

- [ ] **Step 2: Write failing test**

```python
from pathlib import Path
from extractors.image import extract

FIXTURE = Path(__file__).parent / "fixtures" / "sample.png"


def test_extract_image_ocr():
    doc = extract(str(FIXTURE))
    assert "echofoxtrot" in doc["text"].lower()
    assert doc["metadata"]["extractor_name"] == "image"
```


def test_low_confidence_warning_present_when_text_is_garbage(tmp_path):
    # Generate a noisy image with no real text so OCR confidence tanks.
    from PIL import Image
    import random
    img = Image.new("RGB", (200, 60), color="white")
    px = img.load()
    random.seed(0)
    for x in range(200):
        for y in range(60):
            if random.random() < 0.5:
                px[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
    f = tmp_path / "noise.png"
    img.save(f)
    doc = extract(str(f))
    # Either: text is empty AND no warning, OR text exists with the warning.
    if doc["text"]:
        assert "low_confidence_ocr" in doc["warnings"]
```

- [ ] **Step 3: Run (expect fail)**

```bash
pytest tests/test_extractors_image.py -v
```

- [ ] **Step 4: Implement**

```python
"""Image OCR extractor: pytesseract + Pillow.

Captures per-page mean confidence; attaches `low_confidence_ocr` warning
when below threshold (default 50). Handles JPG, PNG, HEIC (via Pillow
plugin if available), TIFF.
"""
from __future__ import annotations

import os
from typing import cast

import pytesseract
from PIL import Image

from extractors.types import ExtractedDoc

OCR_CONFIDENCE_THRESHOLD = int(os.environ.get("OCR_CONFIDENCE_THRESHOLD", 50))


def _mean_confidence(data: dict) -> float:
    confs = [int(c) for c in data.get("conf", []) if c not in (None, "-1", -1, "")]
    if not confs:
        return 0.0
    return sum(confs) / len(confs)


def extract(path: str) -> ExtractedDoc:
    img = Image.open(path)
    text = pytesseract.image_to_string(img).strip()
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    mean_conf = _mean_confidence(data)
    warnings: list[str] = []
    if mean_conf < OCR_CONFIDENCE_THRESHOLD and text:
        warnings.append("low_confidence_ocr")

    return cast(
        ExtractedDoc,
        {
            "text": text,
            "page_breaks": [],
            "language": None,
            "metadata": {
                "extractor_name": "image",
                "extractor_version": "1.0",
                "ocr_mean_confidence": mean_conf,
                "word_count": len(text.split()),
            },
            "warnings": warnings,
        },
    )
```

- [ ] **Step 5: Run tests**

```bash
pytest tests/test_extractors_image.py -v
```

Expected: PASS — 2 tests (skip the second if local Tesseract isn't installed; it will run in the Docker build CI).

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/image.py services/file-indexer/tests/test_extractors_image.py services/file-indexer/tests/fixtures/sample.png services/file-indexer/requirements.txt services/file-indexer/Dockerfile
git commit -m "feat(file-indexer): tesseract OCR image extractor (WARP-201)"
```

### Task 1.7: Wire `dispatch()` into the watcher

**Files:**
- Modify: `services/file-indexer/watcher.py`

- [ ] **Step 1: Read current watcher to find the index hook**

```bash
grep -n "chunk_text\|read_text\|chunker" services/file-indexer/watcher.py | head
```

- [ ] **Step 2: Replace the existing "read file as plain text" path with `dispatch()`**

Identify the function that reads a path and calls `chunk_text()`. Replace its body with:

```python
import mimetypes
from extractors.registry import dispatch

# inside the existing index function, replacing the f.read() path:
mime, _ = mimetypes.guess_type(path)
if mime is None:
    return  # unknown — skip silently
doc = dispatch(path, mime)
if doc is None:
    return
text = doc["text"]
warnings = doc.get("warnings", [])
# pass `warnings` into upsert_chunk if the existing API supports it; if not,
# leave for WARP-203's db.py refactor to plumb the new column.
chunks = chunk_text(text)
# ... existing chunk → embed → upsert flow ...
```

- [ ] **Step 3: Run the existing watcher unit tests + the new extractor tests**

```bash
cd services/file-indexer
pytest tests/ -v
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/watcher.py
git commit -m "feat(file-indexer): wire extractors.dispatch into watcher (WARP-201)"
```

### Task 1.8: Live integration test against the compose stack

**Files:**
- Create: `tests/rag-extractors.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "pg";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE = `docker compose -f ${REPO_ROOT}/docker/docker-compose.yml`;

// Where in Nextcloud the watcher is configured to look. Adjust path to match
// the FILES_ROOT the file-indexer service watches per its config.py.
const WATCH_DIR = "/data/files";

describe("RAG extractors — live integration", () => {
  let pg: Client;

  beforeAll(async () => {
    // Boot the relevant compose services. setup.sh has already provisioned
    // .env on a real device; in CI, .env is wired by the workflow.
    execSync(`${COMPOSE} up -d db cache broker ai-gateway file-indexer`, { stdio: "inherit" });
    // Wait for db to accept connections.
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    for (let i = 0; i < 30; i++) {
      try { await pg.connect(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  }, 120_000);

  afterAll(async () => {
    await pg?.end();
    execSync(`${COMPOSE} down`, { stdio: "inherit" });
  });

  it("indexes a PDF dropped into Nextcloud and produces FileContentChunk rows", async () => {
    const pdfFixture = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.pdf");
    // Drop the fixture into the watched dir inside the file-indexer container.
    execSync(`${COMPOSE} exec -T file-indexer mkdir -p ${WATCH_DIR}/test-rag-pdf`);
    execSync(
      `${COMPOSE} cp ${pdfFixture} file-indexer:${WATCH_DIR}/test-rag-pdf/sample.pdf`,
    );

    // Poll for the chunk to land — give the watcher up to 60s.
    let rows: { text: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await pg.query(
        `SELECT "text" FROM "FileContentChunk" WHERE "path" LIKE '%sample.pdf' LIMIT 5`,
      );
      rows = res.rows;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(rows.length).toBeGreaterThan(0);
    const allText = rows.map((r) => r.text).join("\n");
    expect(allText).toContain("Hello from page one");
    expect(allText).toContain("alphahotel");
  }, 180_000);

  // Repeat the pattern for sample.docx, sample.png, sample.txt.
  // Truncated for brevity; same shape — copy fixture, poll DB, assert content.
});
```

- [ ] **Step 2: Run locally (assumes Docker + .env)**

```bash
cd tests
npx vitest run rag-extractors.integration.test.ts
```

Expected: PASS — the watcher picks up the dropped fixtures and rows materialize.

- [ ] **Step 3: Commit**

```bash
git add tests/rag-extractors.integration.test.ts
git commit -m "test(rag): live integration test for extractors against compose (WARP-201)"
```

### Task 1.9: WARP-201 final check + push

- [ ] **Step 1: Run full file-indexer suite**

```bash
cd services/file-indexer
pytest tests/ -v
```

Expected: all green.

- [ ] **Step 2: Verify no production code outside `services/file-indexer/`**

```bash
git diff --name-only main...HEAD | grep -v "^services/file-indexer/" | grep -v "^tests/rag-" | grep -v "^docs/"
```

Expected: no output.

- [ ] **Step 3: Push**

```bash
git push -u origin WARP-201
```

WARP-201 done. Hand off to the agent harness (QA → Manager → PR).

---

## WARP-202 — embedText wiring + search_content live

**Branch:** `WARP-202` (parallel after WARP-201 merges)

### Task 2.1: Generate TS gRPC stubs from existing proto

**Files:**
- Modify: `scripts/generate-grpc.sh`

- [ ] **Step 1: Read the current script**

```bash
cat scripts/generate-grpc.sh
```

- [ ] **Step 2: Add a TS generation step**

Append to the script:

```bash
echo "Generating TS gRPC stubs..."
cd "$(dirname "$0")/.."

# Use grpc_tools_node_protoc + ts-proto.
npx grpc_tools_node_protoc \
  --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=apps/orchestrator/src/grpc-generated \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useExactTypes=false \
  --proto_path=./proto \
  ./proto/inference.proto
```

- [ ] **Step 3: Add ts-proto dev dep to orchestrator**

```bash
cd apps/orchestrator
npm install --save-dev ts-proto grpc-tools
```

- [ ] **Step 4: Run the script**

```bash
bash scripts/generate-grpc.sh
```

Verify `apps/orchestrator/src/grpc-generated/inference.ts` exists.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-grpc.sh apps/orchestrator/package.json apps/orchestrator/package-lock.json apps/orchestrator/src/grpc-generated/
git commit -m "build(orchestrator): generate TS gRPC stubs from inference.proto (WARP-202)"
```

### Task 2.2: TS embedding client

**Files:**
- Create: `apps/orchestrator/src/services/embedding.client.ts`
- Test: `apps/orchestrator/src/__tests__/embedding.client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { EmbeddingClient } from "../services/embedding.client.js";

describe("EmbeddingClient", () => {
  it("calls EmbedText and returns float vectors", async () => {
    const stub = {
      EmbedText: vi.fn((req, cb) => {
        cb(null, { embeddings: [{ values: [0.1, 0.2, 0.3] }] });
      }),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    const vecs = await client.embed(["hello"]);
    expect(vecs).toEqual([[0.1, 0.2, 0.3]]);
    expect(stub.EmbedText).toHaveBeenCalledWith(
      { texts: ["hello"], model: undefined },
      expect.any(Function),
    );
  });

  it("returns empty array for empty input (no RPC)", async () => {
    const stub = { EmbedText: vi.fn() };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    expect(await client.embed([])).toEqual([]);
    expect(stub.EmbedText).not.toHaveBeenCalled();
  });

  it("propagates gRPC errors as a thrown Error", async () => {
    const stub = {
      EmbedText: vi.fn((_req, cb) => cb(new Error("UNAVAILABLE"), null)),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    await expect(client.embed(["x"])).rejects.toThrow(/UNAVAILABLE/);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/embedding.client.test.ts
```

- [ ] **Step 3: Implement**

```ts
import { credentials, type ServiceError } from "@grpc/grpc-js";
import { InferenceServiceClient } from "../grpc-generated/inference.js";

export interface EmbeddingClientOptions {
  url: string;
  /** Test seam — production paths instantiate `InferenceServiceClient` directly. */
  stubFactory?: (url: string) => Pick<InstanceType<typeof InferenceServiceClient>, "EmbedText">;
}

export class EmbeddingClient {
  private stub: Pick<InstanceType<typeof InferenceServiceClient>, "EmbedText">;
  constructor(opts: EmbeddingClientOptions) {
    this.stub = opts.stubFactory
      ? opts.stubFactory(opts.url)
      : new InferenceServiceClient(opts.url, credentials.createInsecure());
  }

  /** Embed a batch of strings. Empty input returns []. */
  async embed(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    return new Promise((resolve, reject) => {
      this.stub.EmbedText(
        { texts, model },
        (err: ServiceError | null, res: { embeddings?: { values?: number[] }[] } | null) => {
          if (err) return reject(err);
          const out = (res?.embeddings ?? []).map((e) => e.values ?? []);
          resolve(out);
        },
      );
    });
  }
}
```

- [ ] **Step 4: Run test**

```bash
npx vitest run src/__tests__/embedding.client.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/embedding.client.ts apps/orchestrator/src/__tests__/embedding.client.test.ts
git commit -m "feat(orchestrator): TS gRPC embedding client mirroring file-indexer's Python (WARP-202)"
```

### Task 2.3: Wire embedding client into mcp-server child + ToolContext

**Files:**
- Modify: `services/mcp-server/src/index.ts`
- Modify: `services/mcp-server/src/context.ts`
- Test: `services/mcp-server/__tests__/embedtext-wiring.test.ts`

- [ ] **Step 1: Read current `index.ts` deps construction**

```bash
grep -n "buildContext\|ContextDeps\|httpFactory" services/mcp-server/src/index.ts services/mcp-server/src/context.ts
```

- [ ] **Step 2: Add the embedding client to `ContextDeps`**

Modify `services/mcp-server/src/context.ts`:

```ts
export interface ContextDeps {
  prisma: PrismaClient;
  matter: MatterController;
  httpFactory: (target: ...) => HttpClient;
  // NEW
  embedText?: (texts: string[]) => Promise<number[][]>;
}

export function buildContext(
  deps: ContextDeps,
  claims: Claims | undefined,
  signal: AbortSignal,
  ncToken?: string,
): ToolContext {
  return {
    // ... existing fields ...
    embedText: deps.embedText,    // NEW — surfaces in handlers' ctx
  };
}
```

- [ ] **Step 3: Construct the embedding client at index.ts startup**

```ts
import { EmbeddingClient } from "@droplet/orchestrator/dist/services/embedding.client.js";
// (or wherever the workspace export resolves; if cross-workspace import is awkward,
// duplicate the small client into mcp-server. Keep it small and matched.)

const aiGatewayUrl = process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
const embeddingClient = new EmbeddingClient({ url: aiGatewayUrl });

const deps: ContextDeps = {
  prisma,
  matter,
  httpFactory: ...,
  embedText: (texts) => embeddingClient.embed(texts),
};
```

- [ ] **Step 4: Add the wiring test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

describe("embedText wiring", () => {
  it("ctx.embedText is callable from a tool handler", async () => {
    const embedSpy = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      embedText: embedSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "embed-wiring-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // search_content invokes ctx.embedText to embed the query.
    await client.callTool({ name: "search_content", arguments: { query: "hello world" } });
    expect(embedSpy).toHaveBeenCalledWith(["hello world"]);
    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 5: Run + commit**

```bash
cd services/mcp-server && npm run build && npx vitest run __tests__/embedtext-wiring.test.ts
git add services/mcp-server/src/index.ts services/mcp-server/src/context.ts services/mcp-server/__tests__/embedtext-wiring.test.ts
git commit -m "feat(mcp-server): wire embedText into ContextDeps (WARP-202)"
```

### Task 2.4: Shared `file-search.service.ts`

**Files:**
- Create: `apps/orchestrator/src/services/file-search.service.ts`
- Test: `apps/orchestrator/src/__tests__/file-search.service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { searchByVector, listRecent } from "../services/file-search.service.js";

const fakePrisma = {
  $queryRaw: vi.fn(),
} as unknown as PrismaClient;

describe("file-search service", () => {
  it("searchByVector filters by userId and applies score threshold", async () => {
    (fakePrisma.$queryRaw as never as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, score: 0.81, snippet: "hello" },
    ]);
    const hits = await searchByVector(fakePrisma, {
      userId: "u1",
      vector: [0.1, 0.2],
      limit: 10,
      minSimilarity: 0.25,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("nextcloud");
    expect(fakePrisma.$queryRaw).toHaveBeenCalled();
    // Verify userId is in the SQL bindings.
    const args = (fakePrisma.$queryRaw as never as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(args)).toContain("u1");
  });

  it("listRecent groups by file and sorts by indexedAt desc", async () => {
    (fakePrisma.$queryRaw as never as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { source: "brain", path: "/b.png", indexedAt: new Date("2026-04-25") },
      { source: "nextcloud", path: "/a.pdf", indexedAt: new Date("2026-04-26") },
    ]);
    const recent = await listRecent(fakePrisma, { userId: "u1", limit: 50 });
    expect(recent).toHaveLength(2);
    expect(recent[0].path).toBe("/a.pdf"); // newest first
  });
});
```

- [ ] **Step 2: Run (expect fail)**

- [ ] **Step 3: Implement**

```ts
import type { PrismaClient } from "@prisma/client";

export interface SearchHit {
  source: "nextcloud" | "brain";
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  score: number;
  snippet: string;
  brainItemId: string | null;
}

export interface SearchByVectorParams {
  userId: string;
  vector: number[];
  limit: number;
  minSimilarity: number;
  source?: "nextcloud" | "brain";
  since?: Date;
}

export async function searchByVector(
  prisma: PrismaClient,
  params: SearchByVectorParams,
): Promise<SearchHit[]> {
  const vec = `[${params.vector.join(",")}]`;
  const rows: SearchHit[] = await prisma.$queryRaw`
    SELECT source, path, "chunkIdx", "pageNumber", "brainItemId",
      LEFT(text, 280) AS snippet,
      1 - (embedding <=> ${vec}::vector) AS score
    FROM "FileContentChunk"
    WHERE "userId" = ${params.userId}
      ${params.source ? prisma.$queryRaw`AND source = ${params.source}::"FileContentSource"` : prisma.$queryRaw``}
      ${params.since ? prisma.$queryRaw`AND "indexedAt" >= ${params.since}` : prisma.$queryRaw``}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${params.limit};
  `;
  return rows.filter((r) => r.score >= params.minSimilarity);
}

export interface ListRecentParams {
  userId: string;
  limit: number;
  before?: Date;
  source?: "nextcloud" | "brain";
}

export interface RecentItem {
  source: "nextcloud" | "brain";
  path: string;
  indexedAt: Date;
  brainItemId: string | null;
  snippet: string;
}

export async function listRecent(
  prisma: PrismaClient,
  params: ListRecentParams,
): Promise<RecentItem[]> {
  // Group by file (path + source) — return the most recent chunk per file.
  const rows: RecentItem[] = await prisma.$queryRaw`
    SELECT DISTINCT ON (source, path)
      source, path, "indexedAt", "brainItemId",
      LEFT(text, 280) AS snippet
    FROM "FileContentChunk"
    WHERE "userId" = ${params.userId}
      ${params.before ? prisma.$queryRaw`AND "indexedAt" < ${params.before}` : prisma.$queryRaw``}
      ${params.source ? prisma.$queryRaw`AND source = ${params.source}::"FileContentSource"` : prisma.$queryRaw``}
    ORDER BY source, path, "indexedAt" DESC
    LIMIT ${params.limit};
  `;
  return rows.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
}
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/file-search.service.test.ts
git add apps/orchestrator/src/services/file-search.service.ts apps/orchestrator/src/__tests__/file-search.service.test.ts
git commit -m "feat(orchestrator): file-search.service shared by MCP tool + dashboard (WARP-202)"
```

### Task 2.5: Live integration test

**Files:**
- Create: `tests/rag-search.integration.test.ts`

- [ ] **Step 1: Write the test (mirrors WARP-201's pattern but exercises the LLM-tool path via stdio MCP client)**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE = `docker compose -f ${REPO_ROOT}/docker/docker-compose.yml`;

describe("RAG search — live MCP integration", () => {
  let client: McpClient;

  beforeAll(async () => {
    execSync(`${COMPOSE} up -d db cache broker ai-gateway file-indexer mcp-server`, { stdio: "inherit" });
    // Wait for mcp-server health
    for (let i = 0; i < 30; i++) {
      try {
        const out = execSync(`curl -sf http://localhost:9090/health`).toString();
        if (out.includes("ok")) break;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Boot a stdio client against the mcp-server's bin (or use HTTP client with JWT — pick one).
    const SERVER_BIN = resolve(REPO_ROOT, "services/mcp-server/dist/index.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN, "--transport=stdio"],
    });
    client = new McpClient({ name: "rag-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    execSync(`${COMPOSE} down`, { stdio: "inherit" });
  });

  it("search_content returns non-empty result with the expected shape after a fixture is indexed", async () => {
    // (Assume WARP-201's integration step has already dropped sample.pdf and indexed it.)
    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "alphahotel" },
    });
    expect(res.isError).toBe(false);
    const text = (res.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.results.length).toBeGreaterThan(0);
    const top = parsed.results[0];
    expect(top.source).toBeDefined();
    expect(top.path).toMatch(/sample\.pdf$/);
    expect(top.score).toBeGreaterThan(0.25);
    expect(top.snippet.toLowerCase()).toContain("alphahotel");
  }, 180_000);
});
```

- [ ] **Step 2: Run + commit**

```bash
cd tests && npx vitest run rag-search.integration.test.ts
git add tests/rag-search.integration.test.ts
git commit -m "test(rag): live MCP search_content integration (WARP-202)"
git push -u origin WARP-202
```

WARP-202 done.

---

## WARP-203 — BrainMemoryItem + brain-upload + ingest pipeline

**Branch:** `WARP-203` (parallel after WARP-201 merges)

### Task 3.1: Prisma schema + migration

**Files:**
- Modify: `apps/orchestrator/prisma/schema.prisma`
- Create: `apps/orchestrator/prisma/migrations/20260428000000_brain_memory/migration.sql`

- [ ] **Step 1: Append the new models to `schema.prisma`** (exactly per spec §6.1).

- [ ] **Step 2: Generate the migration**

```bash
cd apps/orchestrator
npx prisma migrate dev --name brain_memory --create-only
```

Rename the generated timestamp directory to `20260428000000_brain_memory` for stability across branches.

- [ ] **Step 3: Append idempotent enum-update guards to the migration.sql** (CREATE TYPE IF NOT EXISTS pattern; pgvector pre-existing) and run the migration twice locally to verify idempotence.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/prisma/schema.prisma apps/orchestrator/prisma/migrations/20260428000000_brain_memory/
git commit -m "feat(orchestrator): BrainMemoryItem + FileContentSource schema (WARP-203)"
```

### Task 3.2: Brain memory service

**Files:**
- Create: `apps/orchestrator/src/services/brain-memory.service.ts`
- Test: `apps/orchestrator/src/__tests__/brain-memory.service.test.ts`

- [ ] **Step 1: Write failing test** (covers `writeOriginal`, `writeManifest`, `pathForItem(userId, itemId)`, `purgeUser`).

- [ ] **Step 2: Implement minimal API**

```ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const BRAIN_ROOT = process.env.BRAIN_MEMORY_ROOT ?? "/data/brain-memory";

export function pathForItem(userId: string, itemId: string): string {
  return join(BRAIN_ROOT, userId, itemId);
}

export async function ensureItemDir(userId: string, itemId: string): Promise<string> {
  const dir = pathForItem(userId, itemId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeOriginal(
  userId: string, itemId: string, filename: string, bytes: Buffer,
): Promise<string> {
  const dir = await ensureItemDir(userId, itemId);
  const path = join(dir, `original_${filename}`);
  await writeFile(path, bytes);
  return path;
}

export async function writeManifest(
  userId: string, itemId: string, manifest: object,
): Promise<void> {
  const dir = await ensureItemDir(userId, itemId);
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export async function purgeItem(userId: string, itemId: string): Promise<void> {
  await rm(pathForItem(userId, itemId), { recursive: true, force: true });
}

export async function purgeUser(userId: string): Promise<void> {
  await rm(join(BRAIN_ROOT, userId), { recursive: true, force: true });
}
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/brain-memory.service.test.ts
git add apps/orchestrator/src/services/brain-memory.service.ts apps/orchestrator/src/__tests__/brain-memory.service.test.ts
git commit -m "feat(orchestrator): brain-memory.service filesystem helpers (WARP-203)"
```

### Task 3.3: `POST /api/files/brain/upload` route

**Files:**
- Create: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/index.ts` (mount router)
- Test: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Write failing supertest** (covers: 401 unauth, 413 too-big, 415 wrong MIME, 202 happy path with row + disk + MQTT publish).

- [ ] **Step 2: Implement route handler**

```ts
import { Router } from "express";
import multer from "multer";
import type { PrismaClient } from "@prisma/client";
import { writeOriginal, writeManifest } from "../services/brain-memory.service.js";
import { mqttPublish } from "../services/mqtt.client.js"; // existing helper

const ALLOWED_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg", "image/png", "image/heic", "image/tiff",
]);

export function createFilesBrainRouter(prisma: PrismaClient): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

  router.post("/files/brain/upload", upload.single("file"), async (req, res, next) => {
    try {
      const user = (req as { user?: { username?: string } }).user;
      if (!user?.username) { res.status(401).json({ error: "auth_required" }); return; }
      if (!req.file) { res.status(400).json({ error: "no_file" }); return; }
      if (!ALLOWED_MIMES.has(req.file.mimetype)) {
        res.status(415).json({ error: "unsupported_mime", mimeType: req.file.mimetype });
        return;
      }

      const item = await prisma.brainMemoryItem.create({
        data: {
          userId: user.username,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          bytes: BigInt(req.file.size),
          storagePath: "",
          source: "chat_attachment",
          originatingChatId: typeof req.body.chatId === "string" ? req.body.chatId : null,
        },
      });
      const path = await writeOriginal(user.username, item.id, req.file.originalname, req.file.buffer);
      await prisma.brainMemoryItem.update({ where: { id: item.id }, data: { storagePath: path } });
      await writeManifest(user.username, item.id, { ...item, storagePath: path });
      await mqttPublish("droplet/files/brain/uploaded", JSON.stringify({
        itemId: item.id, userId: user.username, path, mimeType: req.file.mimetype,
      }));
      res.status(202).json({ itemId: item.id, status: "indexing" });
    } catch (e) { next(e); }
  });

  // GET /api/files/brain/:itemId, GET /api/files/brain — see spec §3 for shapes
  // (full impl in this same file; same RBAC enforcement)
  return router;
}
```

- [ ] **Step 3: Mount in `index.ts`**

```ts
app.use("/api", createFilesBrainRouter(prisma));
```

- [ ] **Step 4: Run + commit**

```bash
npm test
git add ...
git commit -m "feat(orchestrator): /api/files/brain/upload + /api/files/brain (WARP-203)"
```

### Task 3.4: file-indexer subscriber for `droplet/files/brain/uploaded`

**Files:**
- Modify: `services/file-indexer/main.py`
- Modify: `services/file-indexer/db.py` (add `source` + `brainItemId` to upsert_chunk signature)

- [ ] **Step 1: Add subscriber in main.py**

Subscribe to `droplet/files/brain/uploaded`. On message:
1. Read JSON body for `itemId, userId, path, mimeType`.
2. Run `extractors.dispatch(path, mimeType)`.
3. Run chunker → embedder.
4. Call `db.upsert_chunk(userId, ncFileId=None, path=path, chunkIdx=..., text=..., embedding=..., source="brain", brainItemId=itemId)`.
5. Update `BrainMemoryItem.indexedAt = NOW()` via `psycopg2`.
6. Publish `droplet/files/brain/indexed` with `{itemId, status: "ready"}` (or `"failed"` + reason).

- [ ] **Step 2: Update `db.py upsert_chunk`** to accept `source` + `brainItemId` columns.

- [ ] **Step 3: Run + commit**

```bash
cd services/file-indexer && pytest tests/ -v
git add ...
git commit -m "feat(file-indexer): subscribe to droplet/files/brain/uploaded (WARP-203)"
```

### Task 3.5: Dashboard chat drop-zone

**Files:**
- Modify: `apps/web-dashboard/src/components/ChatInput.tsx`
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts`
- Modify: `apps/web-dashboard/src/lib/api.ts`
- Create: `apps/web-dashboard/src/components/AttachmentChip.tsx`
- Test: `apps/web-dashboard/src/__tests__/ChatInput.test.tsx`

- [ ] **Step 1: Add `<input type="file" multiple>` + drag-over highlighting in ChatInput.**
- [ ] **Step 2: Add `attach(file)` to useChat — POST to `/api/files/brain/upload`, render pending chip, subscribe to MQTT bridge for status flips.**
- [ ] **Step 3: Add `AttachmentChip` component (pending/ready/failed states with retry/remove).**
- [ ] **Step 4: Vitest: drop a fake file → chip renders pending → MQTT status flip swaps to ready.**
- [ ] **Step 5: Commit + push**

```bash
git push -u origin WARP-203
```

WARP-203 done.

### Task 3.6: Live integration test

`tests/rag-brain-upload.integration.test.ts` mirrors the WARP-201/202 pattern: boot compose, upload via the new route, poll for `BrainMemoryItem.indexedAt` and `FileContentChunk(source=brain)` rows. Assert per-user RBAC by trying user-A creds against user-B uploads.

---

## WARP-204 — `/knowledge` dashboard view

**Branch:** `WARP-204` (parallel after WARP-201)

### Task 4.1: Recent + search routes

**Files:**
- Create: `apps/orchestrator/src/routes/files-knowledge.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Test: `apps/orchestrator/src/__tests__/files-knowledge.test.ts`

- [ ] **Step 1: Write failing supertest** (auth required, per-user filtering enforced, recent + search both return the right shape).

- [ ] **Step 2: Implement using `file-search.service`** (RAG-2 dependency — gracefully error if module missing in this branch; the integration test waits for both PRs).

```ts
router.get("/files/recent", async (req, res, next) => {
  try {
    const user = (req as { user?: { username: string } }).user;
    if (!user) { res.status(401).json({ error: "auth_required" }); return; }
    const limit = Math.min(50, parseInt(String(req.query.limit ?? "50"), 10));
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;
    const source = req.query.source as "nextcloud" | "brain" | undefined;
    const items = await listRecent(prisma, { userId: user.username, limit, before, source });
    res.json({ items });
  } catch (e) { next(e); }
});

router.get("/files/search", async (req, res, next) => {
  try {
    const user = (req as { user?: { username: string } }).user;
    if (!user) { res.status(401).json({ error: "auth_required" }); return; }
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) { res.status(400).json({ error: "query_too_short" }); return; }
    const limit = Math.min(20, parseInt(String(req.query.limit ?? "20"), 10));
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const source = req.query.source as "nextcloud" | "brain" | undefined;
    const vec = (await embeddingClient.embed([q]))[0];
    const hits = await searchByVector(prisma, {
      userId: user.username, vector: vec, limit, minSimilarity: 0.25, source, since,
    });
    res.json({ hits });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Commit**

### Task 4.2: Dashboard `/knowledge` route + tabs

**Files:**
- Create: `apps/web-dashboard/src/app/knowledge/page.tsx`
- Create: `apps/web-dashboard/src/app/knowledge/{Recently,Search,BrainMemory}Tab.tsx`
- Create: `apps/web-dashboard/src/components/CitationChip.tsx`
- Modify: `apps/web-dashboard/src/components/Nav.tsx`
- Modify: `apps/web-dashboard/src/lib/api.ts`

- [ ] **Step 1: Build each tab component.** Use SWR for data fetching (matches the rest of the dashboard's pattern).

- [ ] **Step 2: Vitest** (Testing Library) coverage of each tab's empty + populated states.

- [ ] **Step 3: Commit + push**

```bash
git push -u origin WARP-204
```

### Task 4.3: Live integration test

`tests/rag-knowledge.integration.test.ts` boots compose, seeds files, asserts both endpoints return the right shapes and respect the `userId` boundary.

---

## WARP-205 — Brain export + delete + cascade

**Branch:** `WARP-205` (after WARP-203)

### Task 5.1: Export route (zip stream)

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Test: `apps/orchestrator/src/__tests__/files-brain-export.test.ts`

- [ ] **Step 1: Implement using `archiver` (Node lib)**

```ts
import archiver from "archiver";

router.get("/files/brain/export", async (req, res, next) => {
  try {
    const user = (req as { user?: { username: string } }).user;
    if (!user) { res.status(401).json({ error: "auth_required" }); return; }
    const where = req.query.all === "1"
      ? { userId: user.username }
      : { userId: user.username, originatingChatId: String(req.query.chatId ?? "") };
    const items = await prisma.brainMemoryItem.findMany({ where });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="brain-memory-${req.query.chatId ?? "all"}.zip"`,
    });
    const zip = archiver("zip");
    zip.pipe(res);
    for (const item of items) {
      zip.file(item.storagePath, { name: `${item.id}/${item.filename}` });
    }
    zip.append(JSON.stringify(items, null, 2), { name: "manifest.json" });
    await zip.finalize();
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: DELETE route + tests** (cascades chunks via Prisma `deleteMany` + `purgeItem` from brain-memory.service).

- [ ] **Step 3: Wire `purgeUser(userId)` into `routes/auth.ts` user-deletion path.**

- [ ] **Step 4: Live integration test** at `tests/rag-brain-export.integration.test.ts`.

- [ ] **Step 5: Push**

```bash
git push -u origin WARP-205
```

---

## WARP-206 — End-to-end smoke + CI workflow

**Branch:** `WARP-206` (after WARP-202 + WARP-203 + WARP-204)

### Task 6.1: End-to-end test

**Files:**
- Create: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Implement** — boot full compose, upload PDF to Nextcloud, upload image via brain-upload, poll for indexedAt, send 2 chat requests via `/api/llm/chat`, assert both return non-empty responses with the right citation shape (source + path + non-empty snippet). 5-runs-in-a-row determinism.

- [ ] **Step 2: Commit**

### Task 6.2: CI workflow

**Files:**
- Create: `.github/workflows/rag-tests.yml`

```yaml
name: rag-tests

on:
  pull_request:
    paths:
      - 'services/file-indexer/**'
      - 'apps/orchestrator/src/routes/files*'
      - 'apps/orchestrator/src/services/file-search*'
      - 'apps/orchestrator/src/services/brain-memory*'
      - 'apps/orchestrator/prisma/schema.prisma'
      - 'apps/web-dashboard/src/app/knowledge/**'
      - 'tests/rag-*'
      - '.github/workflows/rag-tests.yml'

jobs:
  rag-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: package-lock.json }
      - name: Install
        run: npm ci
      - name: Compose up
        run: docker compose -f docker/docker-compose.yml up -d db cache broker ai-gateway file-indexer mcp-server orchestrator
      - name: Wait for healthy
        run: |
          for i in $(seq 1 60); do
            if curl -sf http://localhost:9090/health; then break; fi
            sleep 2
          done
      - name: Integration tests
        run: cd tests && npx vitest run rag-extractors.integration.test.ts rag-search.integration.test.ts rag-brain-upload.integration.test.ts rag-knowledge.integration.test.ts rag-brain-export.integration.test.ts rag-end-to-end.integration.test.ts
      - name: Compose down
        if: always()
        run: docker compose -f docker/docker-compose.yml down
```

- [ ] **Step 3: Add `scripts/test-rag.sh` runner + `docs/RAG_TESTING.md`**

- [ ] **Step 4: Push**

```bash
git push -u origin WARP-206
```

---

## Spec coverage cross-check

| Spec section | Implementing tasks |
|---|---|
| §2 Goals | WARP-201 (extractors) + WARP-202 (retrieval) + WARP-203 (brain memory) + WARP-204 (dashboard) |
| §3 Non-goals | WARP-197/198/199/200 deferred tickets enumerated in spec |
| §4 Architecture diagram | All tickets — each component is owned by a task |
| §5 Extractor architecture | WARP-201 Tasks 1.1–1.7 |
| §6 Brain memory data model | WARP-203 Tasks 3.1–3.4 |
| §7 Chat attachment UX | WARP-203 Tasks 3.3, 3.5 |
| §8 Retrieval + ranking | WARP-202 Tasks 2.2–2.4 |
| §9 `/knowledge` dashboard | WARP-204 Tasks 4.1–4.2 |
| §10 Phasing | All 6 tickets present + sequenced |
| §11 Testing strategy | WARP-201 Task 1.8, WARP-202 Task 2.5, WARP-203 Task 3.6, WARP-204 Task 4.3, WARP-205 Task 5.x, WARP-206 Tasks 6.1–6.2 |
| §12 RBAC | WARP-202 Task 2.4 (per-user filter), WARP-203 Task 3.3 (per-user upload), WARP-205 Task 5.x (per-user delete/export) |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tesseract installation flakiness in CI | Pin tesseract-ocr apt package; verify the Dockerfile builds in WARP-201 Task 1.6. |
| Cross-workspace gRPC import (orchestrator → mcp-server) | If awkward, duplicate the small `EmbeddingClient` class. Keep it tiny. |
| pgvector raw SQL fragments in `file-search.service` | Tests against a real Postgres in the integration suite; pure-vitest unit tests use mocked `$queryRaw`. |
| Multer file-size limit + multipart edge cases | Cover with supertest; matches the 50MB cap in the route handler. |
| MQTT bridge latency in dashboard chip update | Polling fallback if MQTT subscription fails — chip shows pending until next page load. Acceptable v1. |
| Prisma migration ordering on stacked branches | Each ticket uses the canonical timestamp `20260428000000_brain_memory`; later branches rebase onto WARP-203's migration. |
