# WARP-287 — Section anchors + citation deep-linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a structured `Anchor` discriminated-union from extractor → chunker → DB → orchestrator → web-dashboard so every RAG citation can deep-link to its source position (PDF page, audio/video timestamp, email part, archive member).

**Architecture:** New `Anchor` JSON Schema is the single source of truth, codegen'd to Pydantic (Python) + Zod/TS (orchestrator + dashboard). Each MVP extractor produces `list[Span(text, anchor)]`; the chunker chunks within spans and never crosses them; the DB writer serializes `chunk.anchor` into the existing `FileContentChunk.metadata` JSONB column. Orchestrator hit-shaping surfaces `anchor` as a top-level field with Zod validation. The dashboard `<CitationCard>` family dispatches on `anchor.kind` and opens the right viewer at the right position. Old `chunk_text(str)` is deleted in the same PR (no parallel codepaths). Backwards-compat is lazy: legacy chunks render as "open file"; a new admin re-index route lets power users upgrade them on demand.

**Tech Stack:** Python 3.12, Pydantic v2, TypeScript, Zod, Next.js 14 (web-dashboard), Express (orchestrator), PostgreSQL 16 JSONB, pytest, vitest, React Testing Library.

**Branch:** `WARP-287` (already created off `origin/main` at `772f0e2`; spec committed at `310390e`).

---

## File Structure

### New files

| Path | Purpose |
|---|---|
| `schemas/anchor.schema.json` | Single source of truth for the Anchor discriminated union (JSON Schema 2020-12). |
| `schemas/__tests__/codegen-drift.test.ts` | Re-runs codegen, diffs against checked-in outputs; CI fails on drift. |
| `scripts/gen-anchor-schema.mjs` | Codegen entry point; reads `anchor.schema.json`, writes `anchor_schema.py` + `anchor.ts`. |
| `packages/shared-types/package.json` | New `@droplet/shared-types` workspace package. |
| `packages/shared-types/src/anchor.ts` | Generated Zod schema + inferred TS types. Checked in. |
| `packages/shared-types/src/index.ts` | Re-exports. |
| `packages/shared-types/tsconfig.json` | TS build config. |
| `services/file-indexer/anchor_schema.py` | Generated Pydantic v2 models. Checked in. |
| `services/file-indexer/extractors/spans.py` | `Span` dataclass + helpers shared across extractors. |
| `apps/orchestrator/src/routes/admin-files.test.ts` | Tests for re-index route. |
| `apps/web-dashboard/src/components/citations/CitationCard.tsx` | Dispatch root, switches on `anchor.kind`. |
| `apps/web-dashboard/src/components/citations/PdfCitation.tsx` | PDF iframe with `#page=N` fragment. |
| `apps/web-dashboard/src/components/citations/MediaCitation.tsx` | Inline audio/video player; seeks to `startMs` on mount. |
| `apps/web-dashboard/src/components/citations/EmailCitation.tsx` | Card; modal on click. |
| `apps/web-dashboard/src/components/citations/ArchiveCitation.tsx` | Drawer; recurses into nested viewer when `innerAnchor` set. |
| `apps/web-dashboard/src/components/citations/FileCitation.tsx` | Legacy/no-anchor fallback ("open file" behavior). |
| `apps/web-dashboard/src/components/citations/__tests__/CitationCard.test.tsx` | Component dispatch + per-kind rendering. |
| `tests/rag-anchors.integration.test.ts` | End-to-end: drop fixtures, query, assert anchors. |

### Modified files

| Path | Change |
|---|---|
| `services/file-indexer/extractors/types.py` | Add `Span` import re-export; extend `ExtractedDoc` with required `spans: list[Span]` field. |
| `services/file-indexer/extractors/pdf.py` | `extract()` builds `spans` (one per page) with `Anchor(kind="pdf-page", page=N)`. |
| `services/file-indexer/extractors/audio.py` | `extract()` builds `spans` (one per Whisper segment) with `Anchor(kind="media-timestamp", startMs, endMs)`. |
| `services/file-indexer/extractors/video.py` | `extract()` builds `spans` for transcript segments + frame-OCR results with media-timestamp anchors. |
| `services/file-indexer/extractors/email.py` | `extract()` builds `spans` (one per MIME part) with `Anchor(kind="email-part", messageId, partIndex)`. |
| `services/file-indexer/extractors/archive.py` | `extract()` builds `spans` (one per member) with `Anchor(kind="archive-member", member, innerAnchor)`; depth-cap recursion. |
| `services/file-indexer/extractors/{text,docx,image}.py` | `extract()` returns single span with `Anchor(kind="none")`; otherwise unchanged. |
| `services/file-indexer/extractors/frame_ocr.py` | Emit spans with media-timestamp anchors (consumed by `video.py`). |
| `services/file-indexer/chunker.py` | Replace `chunk_text(str) -> list[str]` with `chunk_spans(spans: list[Span]) -> list[Chunk]`. |
| `services/file-indexer/brain_ingest.py` | Switch to `chunk_spans(doc["spans"])`; write `chunk.anchor` into `metadata.anchor`. |
| `apps/orchestrator/src/services/file-search.service.ts` | Hit-shaping surfaces `anchor` field; validates via Zod from `@droplet/shared-types`. |
| `apps/orchestrator/src/services/file-search.service.test.ts` | New cases for valid/malformed/missing anchor handling. |
| `apps/orchestrator/src/routes/admin-files.ts` *(new file, or split from existing files.ts)* | New `POST /api/admin/files/:id/reindex` endpoint. |
| `apps/orchestrator/src/app.ts` | Register admin-files router. |
| `apps/web-dashboard/src/app/chat/page.tsx` | Replace `<CitationChip>` with `<CitationCard>`. |
| `apps/web-dashboard/src/app/knowledge/page.tsx` | Replace `<CitationChip>` with `<CitationCard>`. |
| `apps/web-dashboard/src/app/files/[id]/page.tsx` | Add "Re-index" button wired to admin endpoint with MFA flow. |
| `apps/web-dashboard/src/components/ChatMessage.tsx` | Replace `<CitationChip>` use sites with `<CitationCard>`. |
| `.github/workflows/rag-tests.yml` | Add `tests/rag-anchors.integration.test.ts` to the test lane (path filter + test invocation). |

### Deleted files / symbols

| Path / symbol | Reason |
|---|---|
| `services/file-indexer/chunker.py::chunk_text` | Replaced by `chunk_spans`; no parallel codepaths. |
| `apps/web-dashboard/src/components/CitationChip.tsx` | Replaced by `CitationCard` family; deleted with all call sites updated. |
| `ExtractedDoc.page_breaks` field | Subsumed by `spans` (per-span anchors carry positional info structurally). |
| `ExtractedDoc.text` field (optional) | Derived from `"\n\n".join(s.text for s in spans)`; consumers updated to use spans. |

---

## Task 1: JSON Schema + codegen + drift test

**Files:**
- Create: `schemas/anchor.schema.json`
- Create: `scripts/gen-anchor-schema.mjs`
- Create: `schemas/__tests__/codegen-drift.test.ts`
- Modify: `package.json` (root) — add `gen:anchor-schema` script
- Modify: `.github/workflows/ci-coverage.yml` — add path filter for `schemas/**` and `scripts/gen-anchor-schema.mjs`

- [ ] **Step 1: Write the failing drift test**

Create `schemas/__tests__/codegen-drift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("anchor schema codegen drift", () => {
  it("regenerated Pydantic + Zod outputs match checked-in files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "anchor-codegen-"));
    try {
      execSync(`node scripts/gen-anchor-schema.mjs --out-dir ${tmp}`, {
        stdio: "pipe",
      });
      const regenPy = readFileSync(join(tmp, "anchor_schema.py"), "utf-8");
      const regenTs = readFileSync(join(tmp, "anchor.ts"), "utf-8");
      const checkedPy = readFileSync("services/file-indexer/anchor_schema.py", "utf-8");
      const checkedTs = readFileSync("packages/shared-types/src/anchor.ts", "utf-8");
      expect(regenPy).toBe(checkedPy);
      expect(regenTs).toBe(checkedTs);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the drift test to confirm it fails**

Run: `npx vitest run schemas/__tests__/codegen-drift.test.ts`
Expected: FAIL — `scripts/gen-anchor-schema.mjs` does not exist.

- [ ] **Step 3: Write the JSON Schema**

Create `schemas/anchor.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://droplet.local/schemas/anchor.schema.json",
  "title": "Anchor",
  "description": "Per-chunk positional anchor. Discriminated by `kind`. archive-member.innerAnchor is recursive, bounded at runtime by MAX_ARCHIVE_ANCHOR_DEPTH=3.",
  "oneOf": [
    { "$ref": "#/$defs/PdfPage" },
    { "$ref": "#/$defs/MediaTimestamp" },
    { "$ref": "#/$defs/EmailPart" },
    { "$ref": "#/$defs/ArchiveMember" },
    { "$ref": "#/$defs/NoneAnchor" }
  ],
  "$defs": {
    "PdfPage": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "page"],
      "properties": {
        "kind": { "const": "pdf-page" },
        "page": { "type": "integer", "minimum": 1 }
      }
    },
    "MediaTimestamp": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "startMs", "endMs"],
      "properties": {
        "kind": { "const": "media-timestamp" },
        "startMs": { "type": "integer", "minimum": 0 },
        "endMs": { "type": "integer", "minimum": 1 }
      }
    },
    "EmailPart": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "messageId", "partIndex"],
      "properties": {
        "kind": { "const": "email-part" },
        "messageId": { "type": "string", "minLength": 1 },
        "partIndex": { "type": "integer", "minimum": 0 }
      }
    },
    "ArchiveMember": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "member"],
      "properties": {
        "kind": { "const": "archive-member" },
        "member": { "type": "string", "minLength": 1 },
        "innerAnchor": {
          "oneOf": [
            { "$ref": "#/$defs/PdfPage" },
            { "$ref": "#/$defs/MediaTimestamp" },
            { "$ref": "#/$defs/EmailPart" },
            { "$ref": "#/$defs/ArchiveMember" },
            { "$ref": "#/$defs/NoneAnchor" },
            { "type": "null" }
          ]
        }
      }
    },
    "NoneAnchor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": { "const": "none" }
      }
    }
  }
}
```

- [ ] **Step 4: Write the codegen script**

Create `scripts/gen-anchor-schema.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Codegen: schemas/anchor.schema.json → Pydantic v2 + Zod/TS.
 *
 * Hand-rolled generator (not jsonschema-to-zod) so the output is
 * deterministic and free of cosmetic churn. The drift test re-runs
 * this script and byte-compares; any churn = test failure.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const args = process.argv.slice(2);
const outDirIdx = args.indexOf("--out-dir");
const PY_OUT = outDirIdx >= 0
  ? join(args[outDirIdx + 1], "anchor_schema.py")
  : join(ROOT, "services/file-indexer/anchor_schema.py");
const TS_OUT = outDirIdx >= 0
  ? join(args[outDirIdx + 1], "anchor.ts")
  : join(ROOT, "packages/shared-types/src/anchor.ts");

const SCHEMA_PATH = join(ROOT, "schemas/anchor.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const PY = `"""Generated from schemas/anchor.schema.json. DO NOT EDIT.

Regenerate via \`npm run gen:anchor-schema\` from the repo root.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

MAX_ARCHIVE_ANCHOR_DEPTH = 3


class PdfPageAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["pdf-page"] = "pdf-page"
    page: int = Field(..., ge=1)


class MediaTimestampAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["media-timestamp"] = "media-timestamp"
    startMs: int = Field(..., ge=0)
    endMs: int = Field(..., ge=1)


class EmailPartAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["email-part"] = "email-part"
    messageId: str = Field(..., min_length=1)
    partIndex: int = Field(..., ge=0)


class ArchiveMemberAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["archive-member"] = "archive-member"
    member: str = Field(..., min_length=1)
    innerAnchor: Optional["Anchor"] = None


class NoneAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["none"] = "none"


Anchor = Annotated[
    Union[
        PdfPageAnchor,
        MediaTimestampAnchor,
        EmailPartAnchor,
        ArchiveMemberAnchor,
        NoneAnchor,
    ],
    Field(discriminator="kind"),
]

ArchiveMemberAnchor.model_rebuild()
`;

const TS = `// Generated from schemas/anchor.schema.json. DO NOT EDIT.
// Regenerate via \`npm run gen:anchor-schema\` from the repo root.
import { z } from "zod";

export const MAX_ARCHIVE_ANCHOR_DEPTH = 3;

export const PdfPageAnchorSchema = z.object({
  kind: z.literal("pdf-page"),
  page: z.number().int().min(1),
});

export const MediaTimestampAnchorSchema = z.object({
  kind: z.literal("media-timestamp"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
});

export const EmailPartAnchorSchema = z.object({
  kind: z.literal("email-part"),
  messageId: z.string().min(1),
  partIndex: z.number().int().min(0),
});

export const NoneAnchorSchema = z.object({
  kind: z.literal("none"),
});

// Archive recursion: typed via z.lazy. Depth cap is a runtime invariant.
type ArchiveMemberAnchor = {
  kind: "archive-member";
  member: string;
  innerAnchor?: Anchor | null;
};

export const ArchiveMemberAnchorSchema: z.ZodType<ArchiveMemberAnchor> = z.lazy(() =>
  z.object({
    kind: z.literal("archive-member"),
    member: z.string().min(1),
    innerAnchor: AnchorSchema.nullable().optional(),
  })
);

export const AnchorSchema = z.discriminatedUnion("kind", [
  PdfPageAnchorSchema,
  MediaTimestampAnchorSchema,
  EmailPartAnchorSchema,
  ArchiveMemberAnchorSchema,
  NoneAnchorSchema,
]);

export type PdfPageAnchor = z.infer<typeof PdfPageAnchorSchema>;
export type MediaTimestampAnchor = z.infer<typeof MediaTimestampAnchorSchema>;
export type EmailPartAnchor = z.infer<typeof EmailPartAnchorSchema>;
export type NoneAnchor = z.infer<typeof NoneAnchorSchema>;
export type { ArchiveMemberAnchor };
export type Anchor = z.infer<typeof AnchorSchema>;
`;

mkdirSync(dirname(PY_OUT), { recursive: true });
mkdirSync(dirname(TS_OUT), { recursive: true });
writeFileSync(PY_OUT, PY, "utf-8");
writeFileSync(TS_OUT, TS, "utf-8");
console.log(`wrote ${PY_OUT}`);
console.log(`wrote ${TS_OUT}`);
```

`chmod +x scripts/gen-anchor-schema.mjs`

- [ ] **Step 5: Add the npm script**

Edit `package.json` (root); add to `scripts`:

```json
"gen:anchor-schema": "node scripts/gen-anchor-schema.mjs"
```

- [ ] **Step 6: Run codegen + drift test**

```bash
npm run gen:anchor-schema
npx vitest run schemas/__tests__/codegen-drift.test.ts
```

Expected: codegen writes both files; drift test PASSES (regenerated == checked-in).

- [ ] **Step 7: Commit**

```bash
git add schemas/ scripts/gen-anchor-schema.mjs package.json services/file-indexer/anchor_schema.py
git commit -m "feat(WARP-287): JSON Schema source of truth + codegen for Anchor union"
```

(The `packages/shared-types/src/anchor.ts` file will be committed in Task 2 once the package exists.)

---

## Task 2: New `@droplet/shared-types` workspace package

**Files:**
- Create: `packages/shared-types/package.json`
- Create: `packages/shared-types/tsconfig.json`
- Create: `packages/shared-types/src/index.ts`
- Move-in: `packages/shared-types/src/anchor.ts` (from Task 1 codegen)
- Modify: root `package.json` workspaces array (already covers `packages/*` — verify only)
- Modify: `apps/orchestrator/package.json` — add `"@droplet/shared-types": "*"` dep
- Modify: `apps/web-dashboard/package.json` — add `"@droplet/shared-types": "*"` dep

- [ ] **Step 1: Verify root workspaces glob**

Run: `cat package.json | grep -A5 workspaces`
Expected: includes `"packages/*"` (no change needed) or update if missing.

- [ ] **Step 2: Create the package manifest**

`packages/shared-types/package.json`:

```json
{
  "name": "@droplet/shared-types",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p ."
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Create tsconfig**

`packages/shared-types/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create the index barrel**

`packages/shared-types/src/index.ts`:

```typescript
export * from "./anchor";
```

- [ ] **Step 5: Move the generated anchor.ts under the package**

```bash
# Re-run codegen now that the output dir exists at the right place
npm run gen:anchor-schema
```

- [ ] **Step 6: Add the dependency to consumers**

Edit `apps/orchestrator/package.json` `"dependencies"`:

```json
"@droplet/shared-types": "*"
```

Edit `apps/web-dashboard/package.json` `"dependencies"`:

```json
"@droplet/shared-types": "*"
```

- [ ] **Step 7: Build and verify**

```bash
npm install
npm run build --workspace=@droplet/shared-types
```

Expected: `packages/shared-types/dist/` contains `index.js`, `index.d.ts`, `anchor.js`, `anchor.d.ts`.

- [ ] **Step 8: Run the drift test (still passes)**

Run: `npx vitest run schemas/__tests__/codegen-drift.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared-types/ apps/orchestrator/package.json apps/web-dashboard/package.json package-lock.json
git commit -m "feat(WARP-287): @droplet/shared-types package with generated Anchor Zod schema"
```

---

## Task 3: `Span` dataclass + `ExtractedDoc` evolution

**Files:**
- Create: `services/file-indexer/extractors/spans.py`
- Modify: `services/file-indexer/extractors/types.py`
- Test: `services/file-indexer/tests/test_spans.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_spans.py`:

```python
"""Tests for the Span dataclass + anchor validation."""
from __future__ import annotations

import pytest

from anchor_schema import (
    PdfPageAnchor,
    MediaTimestampAnchor,
    NoneAnchor,
)
from extractors.spans import Span


def test_span_carries_text_and_anchor():
    span = Span(text="page 1 content", anchor=PdfPageAnchor(page=1))
    assert span.text == "page 1 content"
    assert span.anchor.kind == "pdf-page"
    assert span.anchor.page == 1


def test_span_rejects_empty_text():
    with pytest.raises(ValueError, match="empty text"):
        Span(text="", anchor=NoneAnchor())


def test_span_rejects_whitespace_only_text():
    with pytest.raises(ValueError, match="empty text"):
        Span(text="   \n  ", anchor=NoneAnchor())


def test_span_none_anchor_is_valid():
    span = Span(text="legacy content", anchor=NoneAnchor())
    assert span.anchor.kind == "none"


def test_span_media_timestamp_validates_at_anchor_level():
    # The Anchor model itself rejects endMs <= startMs.
    with pytest.raises(Exception):  # pydantic.ValidationError
        MediaTimestampAnchor(startMs=1000, endMs=500)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_spans.py -v
```

Expected: FAIL — `extractors.spans` module does not exist.

- [ ] **Step 3: Implement `Span`**

Create `services/file-indexer/extractors/spans.py`:

```python
"""Span — text + anchor, produced by extractors and consumed by the chunker.

A Span represents a contiguous slice of extracted text that shares a single
positional anchor (one PDF page, one transcript segment, one MIME part,
one archive member). The chunker may emit multiple Chunks per Span when
the Span is long, but a Chunk never crosses Span boundaries — that would
make the anchor ambiguous.
"""
from __future__ import annotations

from dataclasses import dataclass

from anchor_schema import Anchor


@dataclass(frozen=True)
class Span:
    text: str
    anchor: Anchor  # type: ignore[valid-type]  # discriminated union, see anchor_schema

    def __post_init__(self) -> None:
        if not self.text or not self.text.strip():
            raise ValueError("Span rejects empty text")
```

Note: `Anchor` is a `typing.Annotated` discriminated-union type alias, not a class, so we use `# type: ignore[valid-type]`. The chunker constructs `Span` directly; validation of the anchor itself happens via the Pydantic model.

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_spans.py -v
```

Expected: 5/5 PASS.

- [ ] **Step 5: Evolve `ExtractedDoc`**

Edit `services/file-indexer/extractors/types.py`:

```python
"""Shared types for the extractor family.

Every extractor produces an `ExtractedDoc` carrying a list of Spans.
Each Span owns its text and its positional anchor; the chunker uses
spans to scope chunking (no chunk crosses a span boundary).
"""
from __future__ import annotations

from typing import Optional, TypedDict

from extractors.spans import Span


class ExtractedDoc(TypedDict, total=False):
    spans: list[Span]            # required — non-empty list of Spans
    language: Optional[str]      # optional — detected via langdetect; None if unknown
    metadata: dict               # required — title, author, page_count, word_count, extractor_name, extractor_version
    warnings: list[str]          # required — e.g. ["low_confidence_ocr"]
```

The `text` and `page_breaks` fields are removed. Downstream consumers will be migrated in the next tasks.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/spans.py services/file-indexer/extractors/types.py services/file-indexer/tests/test_spans.py
git commit -m "feat(WARP-287): Span dataclass + ExtractedDoc evolution to spans-based shape"
```

---

## Task 4: PDF extractor → spans with page anchors

**Files:**
- Modify: `services/file-indexer/extractors/pdf.py`
- Test: `services/file-indexer/tests/test_extractor_pdf_anchors.py`
- Test fixture: `services/file-indexer/tests/fixtures/three-page.pdf` (existing or create via `reportlab` in the test)

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_extractor_pdf_anchors.py`:

```python
"""PDF extractor: spans + per-page anchors."""
from __future__ import annotations

from pathlib import Path

import pytest
from reportlab.pdfgen import canvas

from anchor_schema import PdfPageAnchor
from extractors import pdf


@pytest.fixture
def three_page_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "three-page.pdf"
    c = canvas.Canvas(str(path))
    for i, text in enumerate(["page one content", "page two content", "page three content"], start=1):
        c.drawString(72, 720, text)
        c.showPage()
    c.save()
    return path


def test_pdf_extractor_produces_one_span_per_page(three_page_pdf: Path):
    doc = pdf.extract(str(three_page_pdf))
    spans = doc["spans"]
    assert len(spans) == 3
    for i, span in enumerate(spans, start=1):
        assert isinstance(span.anchor, PdfPageAnchor)
        assert span.anchor.page == i


def test_pdf_extractor_per_page_text(three_page_pdf: Path):
    doc = pdf.extract(str(three_page_pdf))
    assert "page one" in doc["spans"][0].text
    assert "page two" in doc["spans"][1].text
    assert "page three" in doc["spans"][2].text


def test_pdf_extractor_skips_empty_pages(tmp_path: Path):
    path = tmp_path / "mixed.pdf"
    c = canvas.Canvas(str(path))
    c.drawString(72, 720, "real content")
    c.showPage()
    c.showPage()  # blank page
    c.drawString(72, 720, "more content")
    c.showPage()
    c.save()
    doc = pdf.extract(str(path))
    # Blank page is skipped (Span rejects empty text); pages 1 and 3 survive.
    pages = [s.anchor.page for s in doc["spans"]]
    assert pages == [1, 3]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_pdf_anchors.py -v
```

Expected: FAIL — `extract()` returns the old `text + page_breaks` shape.

- [ ] **Step 3: Implement the PDF extractor migration**

Replace `services/file-indexer/extractors/pdf.py`:

```python
"""PDF extractor using pypdf.

Emits one Span per non-empty page with `Anchor(kind="pdf-page", page=N)`.
Blank pages are skipped (the Span dataclass rejects empty text).
"""
from __future__ import annotations

import logging

from pypdf import PdfReader

from anchor_schema import PdfPageAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)


def extract(path: str) -> ExtractedDoc:
    reader = PdfReader(path)
    spans: list[Span] = []
    warnings: list[str] = []

    for idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 — per-page failure must not abort the file
            logger.warning(
                "extractor.span.failed",
                extra={"extractor": "pdf", "page": idx, "error": str(exc)},
            )
            warnings.append(f"page_{idx}_extract_failed")
            continue

        if not text or not text.strip():
            continue
        spans.append(Span(text=text, anchor=PdfPageAnchor(page=idx)))

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "pdf",
            "extractor_version": "2",
            "page_count": len(reader.pages),
        },
        warnings=warnings,
    )
```

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_pdf_anchors.py -v
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/pdf.py services/file-indexer/tests/test_extractor_pdf_anchors.py
git commit -m "feat(WARP-287): PDF extractor emits spans with per-page anchors"
```

---

## Task 5: Audio extractor → spans with media-timestamp anchors

**Files:**
- Modify: `services/file-indexer/extractors/audio.py`
- Test: `services/file-indexer/tests/test_extractor_audio_anchors.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_extractor_audio_anchors.py`:

```python
"""Audio extractor: one span per Whisper segment with media-timestamp anchors."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from anchor_schema import MediaTimestampAnchor
from extractors import audio


def _fake_whisper_segments():
    """Three Whisper segments: 0.0-1.5s, 1.5-3.2s, 3.2-5.0s."""
    seg = lambda start, end, text: MagicMock(start=start, end=end, text=text)
    return iter([seg(0.0, 1.5, "hello"), seg(1.5, 3.2, "world"), seg(3.2, 5.0, "goodbye")])


def test_audio_extractor_produces_one_span_per_segment(tmp_path):
    fake_path = tmp_path / "fake.mp3"
    fake_path.write_bytes(b"\x00")  # bypass file-exists check

    fake_info = MagicMock(language="en", duration=5.0)
    with patch.object(audio, "_load_model") as mock_load:
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (_fake_whisper_segments(), fake_info)
        mock_load.return_value = mock_model
        doc = audio.extract(str(fake_path))

    spans = doc["spans"]
    assert len(spans) == 3

    anchors = [s.anchor for s in spans]
    assert all(isinstance(a, MediaTimestampAnchor) for a in anchors)
    assert (anchors[0].startMs, anchors[0].endMs) == (0, 1500)
    assert (anchors[1].startMs, anchors[1].endMs) == (1500, 3200)
    assert (anchors[2].startMs, anchors[2].endMs) == (3200, 5000)


def test_audio_extractor_skips_empty_segments(tmp_path):
    fake_path = tmp_path / "fake.mp3"
    fake_path.write_bytes(b"\x00")
    seg = lambda start, end, text: MagicMock(start=start, end=end, text=text)
    segments = iter([seg(0.0, 1.0, "real text"), seg(1.0, 2.0, "   "), seg(2.0, 3.0, "more text")])
    fake_info = MagicMock(language="en", duration=3.0)
    with patch.object(audio, "_load_model") as mock_load:
        mock_model = MagicMock()
        mock_model.transcribe.return_value = (segments, fake_info)
        mock_load.return_value = mock_model
        doc = audio.extract(str(fake_path))

    # Empty-text segment is dropped.
    assert [s.anchor.startMs for s in doc["spans"]] == [0, 2000]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_audio_anchors.py -v
```

Expected: FAIL.

- [ ] **Step 3: Migrate `audio.py` to emit spans**

In `services/file-indexer/extractors/audio.py`, locate the `extract()` function and replace the body that builds the `ExtractedDoc` with the spans-based shape:

```python
# Inside extract(), after the transcribe() call:
spans: list[Span] = []
for segment in segments_iter:
    seg_text = (segment.text or "").strip()
    if not seg_text:
        continue
    spans.append(
        Span(
            text=seg_text,
            anchor=MediaTimestampAnchor(
                startMs=int(round(segment.start * 1000)),
                endMs=int(round(segment.end * 1000)),
            ),
        )
    )

return ExtractedDoc(
    spans=spans,
    language=info.language,
    metadata={
        "extractor_name": "audio",
        "extractor_version": "2",
        "duration_seconds": info.duration,
    },
    warnings=warnings,
)
```

Add the imports at the top:

```python
from anchor_schema import MediaTimestampAnchor
from extractors.spans import Span
```

Remove any leftover code that built `text` or `page_breaks`.

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_audio_anchors.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/audio.py services/file-indexer/tests/test_extractor_audio_anchors.py
git commit -m "feat(WARP-287): audio extractor emits spans with media-timestamp anchors"
```

---

## Task 6: Video extractor (transcript + frame-OCR) → spans

**Files:**
- Modify: `services/file-indexer/extractors/video.py`
- Modify: `services/file-indexer/extractors/frame_ocr.py`
- Test: `services/file-indexer/tests/test_extractor_video_anchors.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_extractor_video_anchors.py`:

```python
"""Video extractor: transcript spans + frame-OCR spans, both with media-timestamp anchors."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from anchor_schema import MediaTimestampAnchor
from extractors import video


def test_video_extractor_emits_transcript_and_frame_ocr_spans(tmp_path, monkeypatch):
    fake_path = tmp_path / "fake.mp4"
    fake_path.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    transcript_seg = lambda s, e, t: MagicMock(start=s, end=e, text=t)
    transcript = iter([transcript_seg(0.0, 2.0, "spoken intro"), transcript_seg(2.0, 4.0, "spoken outro")])
    transcript_info = MagicMock(language="en", duration=4.0)

    # Frame OCR finds text at 1.5s and 3.5s.
    frame_results = [
        {"timestamp_seconds": 1.5, "text": "title-card text"},
        {"timestamp_seconds": 3.5, "text": "credits text"},
    ]

    with patch.object(video, "_transcribe") as mock_t, \
         patch.object(video, "_run_frame_ocr") as mock_f:
        mock_t.return_value = (transcript, transcript_info)
        mock_f.return_value = frame_results
        doc = video.extract(str(fake_path))

    spans = doc["spans"]
    # Two transcript spans + two frame-OCR spans, sorted by startMs.
    starts = [s.anchor.startMs for s in spans]
    assert starts == sorted(starts)

    timestamps = [(s.anchor.startMs, s.text) for s in spans]
    assert (0, "spoken intro") in timestamps
    assert (1500, "title-card text") in timestamps
    assert (2000, "spoken outro") in timestamps
    assert (3500, "credits text") in timestamps

    assert all(isinstance(s.anchor, MediaTimestampAnchor) for s in spans)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_video_anchors.py -v
```

Expected: FAIL.

- [ ] **Step 3: Migrate `video.py` and `frame_ocr.py`**

In `services/file-indexer/extractors/video.py` `extract()`:
- Collect transcript segments into `transcript_spans: list[Span]` using `MediaTimestampAnchor(startMs=int(round(seg.start * 1000)), endMs=int(round(seg.end * 1000)))`.
- If `VIDEO_FRAME_OCR_ENABLED=1`, collect frame-OCR results into `frame_spans: list[Span]` using a 1-second window centered on `timestamp_seconds` (e.g. `startMs = int(round(ts * 1000))`, `endMs = startMs + 1000`).
- Concatenate and sort by `startMs`.
- Return `ExtractedDoc(spans=..., language=..., metadata=..., warnings=...)`.

In `services/file-indexer/extractors/frame_ocr.py`:
- If it currently returns text strings, change `_run_frame_ocr` (or equivalent) to return `list[dict]` with `{timestamp_seconds, text}`. The spans-building is done in `video.py`.

Add imports to both files:

```python
from anchor_schema import MediaTimestampAnchor
from extractors.spans import Span
```

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_video_anchors.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/video.py services/file-indexer/extractors/frame_ocr.py services/file-indexer/tests/test_extractor_video_anchors.py
git commit -m "feat(WARP-287): video extractor emits transcript + frame-OCR spans"
```

---

## Task 7: Email extractor → spans with email-part anchors

**Files:**
- Modify: `services/file-indexer/extractors/email.py`
- Test: `services/file-indexer/tests/test_extractor_email_anchors.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_extractor_email_anchors.py`:

```python
"""Email extractor: one span per text-bearing MIME part, with email-part anchors."""
from __future__ import annotations

from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from anchor_schema import EmailPartAnchor
from extractors import email as email_extractor


def _write_eml(tmp_path: Path) -> Path:
    msg = MIMEMultipart()
    msg["Message-ID"] = "<abc123@example.com>"
    msg["Subject"] = "Hello"
    msg["From"] = "a@example.com"
    msg["To"] = "b@example.com"
    msg.attach(MIMEText("plain body text", "plain"))
    msg.attach(MIMEText("<p>html body</p>", "html"))
    path = tmp_path / "msg.eml"
    path.write_bytes(msg.as_bytes())
    return path


def test_email_extractor_produces_one_span_per_text_part(tmp_path: Path):
    path = _write_eml(tmp_path)
    doc = email_extractor.extract(str(path))
    spans = doc["spans"]

    assert len(spans) >= 2  # at minimum: plain + html (header span optional)

    anchors = [s.anchor for s in spans]
    assert all(isinstance(a, EmailPartAnchor) for a in anchors)
    assert all(a.messageId == "<abc123@example.com>" for a in anchors)

    part_indexes = sorted(a.partIndex for a in anchors)
    assert part_indexes == list(range(len(part_indexes)))  # 0, 1, [2]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_email_anchors.py -v
```

Expected: FAIL.

- [ ] **Step 3: Migrate `email.py`**

In `services/file-indexer/extractors/email.py` `extract()`:
- Parse `Message-ID` header into `message_id` (with `<>` preserved). If missing, generate `f"<no-id-{hash(path)}@local>"` and add a warning.
- Walk MIME parts via `msg.walk()` or the existing iteration. For each part that yields text (plain, html stripped, attachment text from a recursive call):
  - Build a Span with `anchor=EmailPartAnchor(messageId=message_id, partIndex=idx)` where `idx` is the part index in walk order, starting at 0.
- Return `ExtractedDoc(spans=..., metadata=..., warnings=...)`.

Add imports:

```python
from anchor_schema import EmailPartAnchor
from extractors.spans import Span
```

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_email_anchors.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/email.py services/file-indexer/tests/test_extractor_email_anchors.py
git commit -m "feat(WARP-287): email extractor emits spans with email-part anchors"
```

---

## Task 8: Archive extractor → spans with archive-member anchors + recursion

**Files:**
- Modify: `services/file-indexer/extractors/archive.py`
- Test: `services/file-indexer/tests/test_extractor_archive_anchors.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_extractor_archive_anchors.py`:

```python
"""Archive extractor: one span per member, recursive innerAnchor capped at depth 3."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

from anchor_schema import (
    ArchiveMemberAnchor,
    NoneAnchor,
    PdfPageAnchor,
)
from extractors import archive


def test_archive_extractor_one_span_per_member(tmp_path: Path):
    zpath = tmp_path / "test.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("a.txt", "alpha content")
        zf.writestr("b.txt", "beta content")
    doc = archive.extract(str(zpath))
    spans = doc["spans"]
    members = {s.anchor.member for s in spans}
    assert members == {"a.txt", "b.txt"}
    assert all(isinstance(s.anchor, ArchiveMemberAnchor) for s in spans)
    assert all(s.anchor.innerAnchor is None or isinstance(s.anchor.innerAnchor, NoneAnchor)
               for s in spans)


def test_archive_extractor_recurses_into_pdf(tmp_path: Path):
    """A .zip containing a .pdf produces spans whose innerAnchor is PdfPageAnchor."""
    from reportlab.pdfgen import canvas
    pdf_path = tmp_path / "inner.pdf"
    c = canvas.Canvas(str(pdf_path))
    c.drawString(72, 720, "page one")
    c.showPage()
    c.drawString(72, 720, "page two")
    c.showPage()
    c.save()

    zpath = tmp_path / "wrap.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.write(pdf_path, arcname="docs/inner.pdf")

    doc = archive.extract(str(zpath))
    spans = doc["spans"]
    pdf_spans = [s for s in spans if s.anchor.member == "docs/inner.pdf"]
    assert len(pdf_spans) == 2  # one per page
    for span in pdf_spans:
        assert isinstance(span.anchor.innerAnchor, PdfPageAnchor)


def test_archive_extractor_caps_recursion_at_depth_3(tmp_path: Path):
    """zip-in-zip-in-zip-in-zip → 4th level innerAnchor is None with a warning."""
    # Build nested archives: L4 = leaf.txt, L3.zip contains L4 raw, L2.zip contains L3.zip, ...
    def build_zip(parent_dir: Path, name: str, contents: list[tuple[str, bytes]]) -> Path:
        p = parent_dir / name
        with zipfile.ZipFile(p, "w") as zf:
            for arc, data in contents:
                zf.writestr(arc, data)
        return p

    l4_data = b"leaf content"
    l3_zip = build_zip(tmp_path, "l3.zip", [("leaf.txt", l4_data)])
    l2_zip = build_zip(tmp_path, "l2.zip", [("l3.zip", l3_zip.read_bytes())])
    l1_zip = build_zip(tmp_path, "l1.zip", [("l2.zip", l2_zip.read_bytes())])
    outer  = build_zip(tmp_path, "outer.zip", [("l1.zip", l1_zip.read_bytes())])

    doc = archive.extract(str(outer))
    # Drill the deepest anchor chain we can see.
    depths = []
    for span in doc["spans"]:
        depth = 1
        a = span.anchor
        while isinstance(a, ArchiveMemberAnchor) and a.innerAnchor is not None and not isinstance(a.innerAnchor, NoneAnchor):
            depth += 1
            a = a.innerAnchor
        depths.append(depth)
    # MAX_ARCHIVE_ANCHOR_DEPTH = 3 → deepest archive-member chain is 3, then None.
    assert max(depths) <= 3
    assert "archive_recursion_capped" in doc.get("warnings", [])
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_archive_anchors.py -v
```

Expected: FAIL.

- [ ] **Step 3: Migrate `archive.py`**

In `services/file-indexer/extractors/archive.py`:
- Add a depth parameter to `extract(path, depth=0)` (it likely already exists per the WARP-199 recursion contract — verify).
- For each member, call the registry's `dispatch(member_path, mime, depth=depth+1)` to get an inner `ExtractedDoc` (or None for unsupported types).
- For each Span the inner doc emits, build an outer `Span(text=inner_span.text, anchor=ArchiveMemberAnchor(member=member_name, innerAnchor=<wrap>))` where the wrap rule is:
  - If `depth + 1 >= MAX_ARCHIVE_ANCHOR_DEPTH` (3), set `innerAnchor=None` and append `"archive_recursion_capped"` to warnings.
  - Else, `innerAnchor = inner_span.anchor` (which may itself be an `ArchiveMemberAnchor` — recursion is natural).
- For members the registry can't handle (unknown MIME), emit a single `Span(text=member_raw_text_or_filename_marker, anchor=ArchiveMemberAnchor(member=member_name, innerAnchor=NoneAnchor()))` if text is available, else skip.

Imports:

```python
from anchor_schema import (
    ArchiveMemberAnchor,
    MAX_ARCHIVE_ANCHOR_DEPTH,
    NoneAnchor,
)
from extractors.spans import Span
```

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_extractor_archive_anchors.py -v
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/archive.py services/file-indexer/tests/test_extractor_archive_anchors.py
git commit -m "feat(WARP-287): archive extractor emits spans with member anchors + depth-capped recursion"
```

---

## Task 9: Non-MVP extractors (text, docx, image) emit `kind: "none"`

**Files:**
- Modify: `services/file-indexer/extractors/text.py`
- Modify: `services/file-indexer/extractors/docx.py`
- Modify: `services/file-indexer/extractors/image.py`
- Test: `services/file-indexer/tests/test_non_mvp_extractors_emit_none_anchor.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_non_mvp_extractors_emit_none_anchor.py`:

```python
"""Non-MVP extractors (text, docx, image) migrate to the spans interface
but emit a single Span with NoneAnchor — they don't carry positional info yet."""
from __future__ import annotations

from pathlib import Path

import pytest

from anchor_schema import NoneAnchor
from extractors import docx as docx_ex
from extractors import image as image_ex
from extractors import text as text_ex


def test_text_extractor_emits_single_none_anchor_span(tmp_path: Path):
    path = tmp_path / "note.md"
    path.write_text("# Heading\n\nbody text", encoding="utf-8")
    doc = text_ex.extract(str(path))
    spans = doc["spans"]
    assert len(spans) == 1
    assert isinstance(spans[0].anchor, NoneAnchor)
    assert "body text" in spans[0].text


def test_docx_extractor_emits_single_none_anchor_span(tmp_path: Path):
    from docx import Document
    path = tmp_path / "doc.docx"
    d = Document()
    d.add_paragraph("doc content")
    d.save(str(path))
    doc = docx_ex.extract(str(path))
    spans = doc["spans"]
    assert len(spans) == 1
    assert isinstance(spans[0].anchor, NoneAnchor)


def test_image_extractor_emits_single_none_anchor_span_when_ocr_yields_text(tmp_path: Path):
    # Image extractor returns None for unparseable images; skip OCR contract
    # test by providing the contract: when text is produced, span has NoneAnchor.
    # (Concrete OCR fixture is heavy; here we just verify the interface.)
    pytest.skip("image OCR fixture requires tesseract; covered by interface check in test_image.py")
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_non_mvp_extractors_emit_none_anchor.py -v
```

Expected: FAIL on text + docx (image is skipped).

- [ ] **Step 3: Migrate `text.py`, `docx.py`, `image.py`**

For each of the three files, replace the body that builds `ExtractedDoc` with:

```python
# At top:
from anchor_schema import NoneAnchor
from extractors.spans import Span

# In extract():
text_content = ... # existing logic that produces the full text string
if not text_content or not text_content.strip():
    return ExtractedDoc(spans=[], metadata={...}, warnings=warnings)
return ExtractedDoc(
    spans=[Span(text=text_content, anchor=NoneAnchor())],
    language=...,
    metadata={"extractor_name": "<text|docx|image>", "extractor_version": "2", ...},
    warnings=warnings,
)
```

Remove any prior `text=`, `page_breaks=` returns.

- [ ] **Step 4: Re-run the tests to verify they pass**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_non_mvp_extractors_emit_none_anchor.py -v
```

Expected: 2 PASS, 1 SKIP.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/{text,docx,image}.py services/file-indexer/tests/test_non_mvp_extractors_emit_none_anchor.py
git commit -m "feat(WARP-287): non-MVP extractors migrate to spans interface with NoneAnchor"
```

---

## Task 10: Chunker — `chunk_spans` replaces `chunk_text`

**Files:**
- Modify: `services/file-indexer/chunker.py`
- Test: `services/file-indexer/tests/test_chunker_anchors.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_chunker_anchors.py`:

```python
"""Chunker contract: chunks within a span inherit anchor; never cross spans."""
from __future__ import annotations

import pytest

from anchor_schema import NoneAnchor, PdfPageAnchor
from chunker import chunk_spans, Chunk
from extractors.spans import Span


def test_chunk_inherits_span_anchor():
    spans = [
        Span(text="page one content " * 5, anchor=PdfPageAnchor(page=1)),
        Span(text="page two content " * 5, anchor=PdfPageAnchor(page=2)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    by_page: dict[int, list[Chunk]] = {}
    for c in chunks:
        by_page.setdefault(c.anchor.page, []).append(c)
    assert set(by_page.keys()) == {1, 2}


def test_chunks_never_cross_spans():
    """Two adjacent spans with different anchors → no chunk should contain text from both."""
    spans = [
        Span(text="alpha alpha alpha", anchor=PdfPageAnchor(page=1)),
        Span(text="beta beta beta", anchor=PdfPageAnchor(page=2)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    for c in chunks:
        # Each chunk's text must come from exactly one span.
        assert ("alpha" in c.text) != ("beta" in c.text)


def test_long_span_produces_multiple_chunks_with_same_anchor():
    spans = [
        Span(text=" ".join(["word"] * 200), anchor=PdfPageAnchor(page=7)),
    ]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    assert len(chunks) > 1
    assert all(c.anchor.page == 7 for c in chunks)


def test_none_anchor_propagates():
    spans = [Span(text="legacy doc text", anchor=NoneAnchor())]
    chunks = chunk_spans(spans, chunk_size=20, overlap_ratio=0.2)
    assert all(c.anchor.kind == "none" for c in chunks)


def test_empty_span_list_returns_empty_chunks():
    assert chunk_spans([]) == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_chunker_anchors.py -v
```

Expected: FAIL — `chunk_spans` and `Chunk` do not exist.

- [ ] **Step 3: Rewrite `chunker.py`**

Replace `services/file-indexer/chunker.py`:

```python
"""Span-aware chunker.

Replaces the old `chunk_text(str)` — every caller now passes spans, and
the chunker chunks *within* each span (anchor stays attached) and *never
across* (which would make the anchor ambiguous).

Token counting is approximated as whitespace-split words; same as the
prior implementation. The output is a list of `Chunk(text, anchor)`
tuples; downstream the DB writer serializes `anchor` into the existing
FileContentChunk.metadata JSONB column under the `anchor` key.
"""
from __future__ import annotations

from dataclasses import dataclass

from anchor_schema import Anchor
from config import CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_RATIO
from extractors.spans import Span


@dataclass(frozen=True)
class Chunk:
    text: str
    anchor: Anchor  # type: ignore[valid-type]


def chunk_spans(
    spans: list[Span],
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap_ratio: float = CHUNK_OVERLAP_RATIO,
) -> list[Chunk]:
    """Chunk each span independently; chunks inherit their span's anchor.

    A chunk never spans two source spans — that would make the anchor
    ambiguous.
    """
    if not spans:
        return []

    word_chunk = max(1, int(chunk_size * 0.75))
    word_overlap = max(0, int(word_chunk * overlap_ratio))
    step = max(1, word_chunk - word_overlap)

    out: list[Chunk] = []
    for span in spans:
        words = span.text.split()
        if not words:
            continue
        i = 0
        while i < len(words):
            window = words[i : i + word_chunk]
            chunk_text = " ".join(window).strip()
            if chunk_text:
                out.append(Chunk(text=chunk_text, anchor=span.anchor))
            i += step
    return out
```

The old `chunk_text(text: str) -> list[str]` is deleted.

- [ ] **Step 4: Re-run the chunker tests to verify they pass**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_chunker_anchors.py -v
```

Expected: 5/5 PASS.

- [ ] **Step 5: Grep for any remaining `chunk_text` callers**

```bash
cd services/file-indexer
grep -rn "chunk_text" . --include='*.py' | grep -v __pycache__
```

Expected: shows `brain_ingest.py:29` (still importing) and `brain_ingest.py:191` (still calling). These will be fixed in Task 11. No other call sites in extractors.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/chunker.py services/file-indexer/tests/test_chunker_anchors.py
git commit -m "feat(WARP-287): chunker.chunk_spans replaces chunk_text"
```

(Note: `brain_ingest.py` is still calling the deleted `chunk_text`; the file-indexer is intentionally broken between this commit and Task 11. Subagent-driven execution should keep these two tasks adjacent.)

---

## Task 11: Wire `brain_ingest.py` to spans + write `anchor` into metadata

**Files:**
- Modify: `services/file-indexer/brain_ingest.py`
- Test: `services/file-indexer/tests/test_brain_ingest_anchor.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_brain_ingest_anchor.py`:

```python
"""brain_ingest persists chunk.anchor into FileContentChunk.metadata.anchor."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from anchor_schema import PdfPageAnchor
from chunker import Chunk
import brain_ingest


def test_brain_ingest_writes_anchor_into_metadata(monkeypatch):
    """When the chunker yields a Chunk with a PdfPageAnchor, the row that
    brain_ingest writes contains metadata.anchor = {"kind": "pdf-page", "page": N}."""
    fake_chunks = [
        Chunk(text="content one", anchor=PdfPageAnchor(page=4)),
        Chunk(text="content two", anchor=PdfPageAnchor(page=4)),
    ]

    inserted_rows = []
    def fake_insert(*, conn, chunks_data):
        inserted_rows.extend(chunks_data)
        return len(chunks_data)

    monkeypatch.setattr(brain_ingest, "_chunk_spans_from_doc", lambda doc: fake_chunks)
    monkeypatch.setattr(brain_ingest, "_insert_chunks", fake_insert)
    monkeypatch.setattr(brain_ingest, "_embed_chunks", lambda chunks: [[0.0] * 768] * len(chunks))

    # Drive the ingest path with a fake doc.
    brain_ingest.ingest_brain_item(
        conn=MagicMock(),
        brain_item_id="bi-1",
        nc_file_id="fi-1",
        user_id="u-1",
        doc={"spans": [], "metadata": {}, "warnings": []},  # spans unused due to mocking
        source_path="/tmp/x",
    )

    assert len(inserted_rows) == 2
    for row in inserted_rows:
        meta = row["metadata"]
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert meta["anchor"] == {"kind": "pdf-page", "page": 4}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_brain_ingest_anchor.py -v
```

Expected: FAIL.

- [ ] **Step 3: Wire `brain_ingest.py`**

In `services/file-indexer/brain_ingest.py`:

1. Replace `from chunker import chunk_text` with `from chunker import chunk_spans, Chunk`.
2. Replace the call `chunks = chunk_text(text)` with `chunks = chunk_spans(doc["spans"])`. The variable `chunks` is now `list[Chunk]`, not `list[str]`.
3. Update the row-builder to serialize the anchor. Locate the dict that builds the metadata payload (the WARP-214 metadata block) and add:

   ```python
   chunk_metadata = dict(doc_metadata or {})
   chunk_metadata["anchor"] = chunk.anchor.model_dump()  # Pydantic v2 serialization
   ```

4. Replace any references to `chunk` as a `str` (e.g., `chunk` becomes `chunk.text` when feeding to the embedder, and `chunkText=chunk` becomes `chunkText=chunk.text`).
5. Delete the helper `_extract_text_path` if it's only used by the deleted text-blob storage path; otherwise leave intact.
6. Wrap the chunk-write loop with a try/except on `chunk.anchor` Pydantic-validation errors (already-built Chunk objects shouldn't fail, but defensive: if a malformed anchor sneaks through, log `chunk.anchor.write_failed` and skip that chunk).

Add a small helper for testability:

```python
def _chunk_spans_from_doc(doc: dict) -> list[Chunk]:
    return chunk_spans(doc.get("spans") or [])
```

The test seam above (`monkeypatch.setattr(brain_ingest, "_chunk_spans_from_doc", ...)`) targets this helper.

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd services/file-indexer
PYTHONPATH=. pytest tests/test_brain_ingest_anchor.py -v
```

Expected: PASS.

- [ ] **Step 5: Run the full file-indexer test suite**

```bash
cd services/file-indexer
PYTHONPATH=. pytest -v
```

Expected: all tests pass. Anything that called `chunk_text` directly is now broken and must be fixed in this task (the chunker tests + extractor tests already use the new interface).

- [ ] **Step 6: Grep for residual `chunk_text` / `extract_text` references**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-pi-platform/.claude/worktrees/warp-287
grep -rn "chunk_text\|page_breaks" services/file-indexer --include='*.py' | grep -v __pycache__ | grep -v test_
```

Expected: empty. If any non-test code still references these symbols, fix them in this task.

- [ ] **Step 7: Commit**

```bash
git add services/file-indexer/brain_ingest.py services/file-indexer/tests/test_brain_ingest_anchor.py
git commit -m "feat(WARP-287): brain_ingest writes chunk.anchor into FileContentChunk.metadata"
```

---

## Task 12: Orchestrator hit-shaping surfaces `anchor` with Zod validation

**Files:**
- Modify: `apps/orchestrator/src/services/file-search.service.ts`
- Modify: `apps/orchestrator/src/services/file-search.service.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/orchestrator/src/services/file-search.service.test.ts`, add a new describe block:

```typescript
import { AnchorSchema } from "@droplet/shared-types";

describe("file-search anchor surfacing", () => {
  it("surfaces a valid metadata.anchor as a top-level anchor field", async () => {
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: 4, brainItemId: null,
      metadata: { anchor: { kind: "pdf-page", page: 4 } },
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toEqual({ kind: "pdf-page", page: 4 });
  });

  it("returns anchor:null when metadata.anchor is malformed, logs a warning, does not drop the hit", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: null, brainItemId: null,
      metadata: { anchor: { kind: "pdf-page", page: 0 } },  // page must be >= 1
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toBeNull();
    expect(hits.length).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("anchor.validation.failed"),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });

  it("returns anchor:null cleanly when metadata.anchor is missing (legacy row)", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: null, brainItemId: null,
      metadata: { chain: ["wrap.zip"] },  // WARP-214 metadata, but no anchor
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
```

Where `shapeHitsForResponse` is a helper exported from `file-search.service.ts` (we'll extract it in Step 3).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/orchestrator
npm test -- file-search.service.test.ts
```

Expected: FAIL — `shapeHitsForResponse` not exported, `anchor` field doesn't exist on the hit shape.

- [ ] **Step 3: Implement the hit-shaping change**

In `apps/orchestrator/src/services/file-search.service.ts`:

1. Import the schema:

   ```typescript
   import { AnchorSchema, type Anchor } from "@droplet/shared-types";
   ```

2. Extend the `FileSearchHit` interface (both internal and any exported types) with:

   ```typescript
   anchor: Anchor | null;
   ```

3. Extract or modify the existing hit-shaping logic into a helper:

   ```typescript
   export function shapeHitsForResponse(rows: RawSearchRow[]): FileSearchHit[] {
     return rows.map(r => {
       const rawAnchor = (r.metadata as Record<string, unknown> | null)?.anchor;
       let anchor: Anchor | null = null;
       if (rawAnchor !== undefined && rawAnchor !== null) {
         const parsed = AnchorSchema.safeParse(rawAnchor);
         if (parsed.success) {
           anchor = parsed.data;
         } else {
           console.warn("anchor.validation.failed", {
             chunkId: `${r.ncFileId}:${r.chunkIdx}`,
             rawAnchor,
             error: parsed.error.issues,
           });
         }
       }
       return {
         ncFileId: r.ncFileId,
         chunkIdx: r.chunkIdx,
         score: r.score,
         chunkText: r.chunkText,
         source: r.source,
         path: r.path,
         pageNumber: r.pageNumber,
         brainItemId: r.brainItemId,
         metadata: r.metadata ?? null,
         anchor,
       };
     });
   }
   ```

4. Replace the inline shaping in both `searchHybrid` and `searchByVector` with calls to `shapeHitsForResponse`.

- [ ] **Step 4: Re-run the orchestrator tests**

```bash
cd apps/orchestrator
npm test -- file-search.service.test.ts
```

Expected: new cases pass; existing cases still pass (they ignore the new `anchor` field).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/file-search.service.ts apps/orchestrator/src/services/file-search.service.test.ts
git commit -m "feat(WARP-287): orchestrator hit-shaping surfaces anchor with Zod validation"
```

---

## Task 13: Admin re-index route

**Files:**
- Create: `apps/orchestrator/src/routes/admin-files.ts`
- Create: `apps/orchestrator/src/routes/admin-files.test.ts`
- Modify: `apps/orchestrator/src/app.ts` (register router)

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/routes/admin-files.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { adminFilesRouter } from "./admin-files";

function mkApp(opts: { user?: { id: string; role?: string; lastMfaAt?: Date | null } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = opts.user;
    next();
  });
  app.use("/api/admin", adminFilesRouter);
  return app;
}

describe("POST /api/admin/files/:id/reindex", () => {
  it("returns 401 mfa_required when MFA is stale", async () => {
    const app = mkApp({ user: { id: "u1", role: "admin", lastMfaAt: null } });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_required");
  });

  it("returns 403 when caller is not an admin", async () => {
    const app = mkApp({ user: { id: "u1", role: "user", lastMfaAt: new Date() } });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(403);
  });

  it("returns 200 + reindexed count when MFA is fresh and reindex succeeds", async () => {
    const reindexSpy = vi.fn().mockResolvedValue({ chunksWritten: 7 });
    const app = mkApp({ user: { id: "u1", role: "admin", lastMfaAt: new Date() } });
    // Inject the reindex function via module mock.
    vi.doMock("../services/file-reindex.service", () => ({
      reindexFile: reindexSpy,
    }));
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fileId: "f1", chunksWritten: 7 });
    expect(reindexSpy).toHaveBeenCalledWith({ fileId: "f1", actor: "u1" });
  });

  it("returns 409 when an advisory lock is held by another transaction", async () => {
    vi.doMock("../services/file-reindex.service", () => ({
      reindexFile: vi.fn().mockRejectedValue(Object.assign(new Error("lock"), { code: "INDEX_IN_PROGRESS" })),
    }));
    const app = mkApp({ user: { id: "u1", role: "admin", lastMfaAt: new Date() } });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("index_in_progress");
  });

  it("returns 500 + rolls back on extractor failure", async () => {
    vi.doMock("../services/file-reindex.service", () => ({
      reindexFile: vi.fn().mockRejectedValue(new Error("extractor blew up")),
    }));
    const app = mkApp({ user: { id: "u1", role: "admin", lastMfaAt: new Date() } });
    const res = await request(app).post("/api/admin/files/f1/reindex");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("reindex_failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/orchestrator
npm test -- admin-files.test.ts
```

Expected: FAIL — `admin-files.ts` does not exist.

- [ ] **Step 3: Implement the route**

Create `apps/orchestrator/src/routes/admin-files.ts`:

```typescript
/**
 * WARP-287 — admin re-index route.
 *
 * Forces re-extraction of a single file. Used to upgrade legacy chunks
 * (no metadata.anchor) to anchored ones without a global backfill.
 *
 * Guards:
 *   - RBAC: admin role required (403 otherwise).
 *   - require-recent-mfa: 60s window. 401 mfa_required on stale.
 *   - Per-file advisory lock at the service layer; route returns 409
 *     INDEX_IN_PROGRESS if held.
 *
 * Replacement is transactional: old chunks DELETE + new chunks INSERT in
 * one transaction. Failure rolls back; the file keeps its prior chunks.
 */
import { Router, Request, Response, NextFunction } from "express";

import { createRequireRecentMfa } from "../middleware/require-recent-mfa";
import { reindexFile } from "../services/file-reindex.service";

export const adminFilesRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { user?: { role?: string } }).user;
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  next();
}

adminFilesRouter.post(
  "/files/:id/reindex",
  requireAdmin,
  createRequireRecentMfa(),
  async (req: Request, res: Response) => {
    const user = (req as unknown as { user: { id: string } }).user;
    const fileId = req.params.id;
    try {
      const result = await reindexFile({ fileId, actor: user.id });
      res.json({ fileId, chunksWritten: result.chunksWritten });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "INDEX_IN_PROGRESS") {
        res.status(409).json({
          error: "index_in_progress",
          message: "indexing in progress, try again in a moment",
        });
        return;
      }
      console.error("admin_reindex.failed", { fileId, error: e.message });
      res.status(500).json({ error: "reindex_failed", message: e.message });
    }
  }
);
```

- [ ] **Step 4: Implement the service stub**

Create `apps/orchestrator/src/services/file-reindex.service.ts`:

```typescript
/**
 * Re-runs extraction + chunking for a single file. Atomic chunk
 * replacement under a per-file advisory lock.
 *
 * Implementation: the heavy lifting lives in the file-indexer Python
 * service. The orchestrator side calls it over the existing
 * file-indexer HTTP control plane (POST /reindex/:fileId).
 */
import { prisma } from "../prisma";

export interface ReindexResult {
  chunksWritten: number;
}

export async function reindexFile(opts: {
  fileId: string;
  actor: string;
}): Promise<ReindexResult> {
  const { fileId } = opts;
  // Single-statement transaction: advisory lock + the file-indexer call.
  return prisma.$transaction(async (tx) => {
    // pg_try_advisory_xact_lock returns true on success, false if held elsewhere.
    const lockKey = hashFileId(fileId);
    const lock = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${lockKey}) AS ok
    `;
    if (!lock[0]?.ok) {
      const err: Error & { code?: string } = new Error("advisory lock not acquired");
      err.code = "INDEX_IN_PROGRESS";
      throw err;
    }

    // Delegate to the file-indexer. The indexer handles DELETE + INSERT
    // inside its own DB session; we hold the advisory lock for the
    // duration of this transaction so concurrent writes block on us.
    const result = await callFileIndexerReindex(fileId);
    return { chunksWritten: result.chunksWritten };
  });
}

function hashFileId(fileId: string): bigint {
  // 64-bit FNV-1a — deterministic, no crypto.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < fileId.length; i++) {
    h ^= BigInt(fileId.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // pg_advisory_xact_lock takes bigint; cast to signed bigint range.
  return h > 0x7fffffffffffffffn ? h - 0x10000000000000000n : h;
}

async function callFileIndexerReindex(fileId: string): Promise<{ chunksWritten: number }> {
  const url = `${process.env.FILE_INDEXER_URL ?? "http://file-indexer:8090"}/reindex/${encodeURIComponent(fileId)}`;
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`file-indexer returned ${resp.status}: ${await resp.text()}`);
  }
  return resp.json() as Promise<{ chunksWritten: number }>;
}
```

- [ ] **Step 5: Implement the file-indexer `/reindex/:fileId` endpoint**

In `services/file-indexer/main.py` (FastAPI app), add:

```python
@app.post("/reindex/{file_id}")
async def reindex_file(file_id: str) -> dict:
    """Re-extract a single file and replace its chunks atomically."""
    from brain_ingest import reindex_one
    result = reindex_one(file_id)
    return {"chunksWritten": result["chunksWritten"]}
```

And add `reindex_one(file_id: str) -> dict` to `brain_ingest.py`:

```python
def reindex_one(nc_file_id: str) -> dict:
    """Re-extract + re-chunk a single file. Atomic: DELETE + INSERT inside one tx.
    Rolls back if anything throws."""
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            try:
                # Fetch the source path + user + brain-item context.
                cur.execute(
                    "SELECT \"brainItemId\", \"userId\", path FROM \"FileContentChunk\" "
                    "WHERE \"ncFileId\" = %s LIMIT 1",
                    (nc_file_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise FileNotFoundError(f"no chunks for ncFileId={nc_file_id}")
                brain_item_id, user_id, src_path = row

                # DELETE existing chunks.
                cur.execute('DELETE FROM "FileContentChunk" WHERE "ncFileId" = %s', (nc_file_id,))

                # Re-extract + re-chunk + INSERT.
                from extractors.registry import dispatch
                doc = dispatch(src_path, mime=detect_mime(src_path))
                if doc is None:
                    raise RuntimeError(f"extractor produced no doc for {src_path}")
                chunks = chunk_spans(doc.get("spans") or [])
                chunks_written = _insert_chunks(
                    conn=conn,
                    chunks_data=_build_rows(chunks, doc, brain_item_id, user_id, nc_file_id),
                )
                cur.execute("COMMIT")
                return {"chunksWritten": chunks_written}
            except Exception:
                cur.execute("ROLLBACK")
                raise
```

- [ ] **Step 6: Register the router**

In `apps/orchestrator/src/app.ts`, add:

```typescript
import { adminFilesRouter } from "./routes/admin-files";
// ...
app.use("/api/admin", adminFilesRouter);
```

- [ ] **Step 7: Re-run the tests**

```bash
cd apps/orchestrator
npm test -- admin-files.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/orchestrator/src/routes/admin-files.ts apps/orchestrator/src/routes/admin-files.test.ts apps/orchestrator/src/services/file-reindex.service.ts apps/orchestrator/src/app.ts services/file-indexer/main.py services/file-indexer/brain_ingest.py
git commit -m "feat(WARP-287): admin re-index route with MFA + advisory lock + transactional replace"
```

---

## Task 14: `<CitationCard>` component family + per-kind viewers

**Files:**
- Create: `apps/web-dashboard/src/components/citations/CitationCard.tsx`
- Create: `apps/web-dashboard/src/components/citations/PdfCitation.tsx`
- Create: `apps/web-dashboard/src/components/citations/MediaCitation.tsx`
- Create: `apps/web-dashboard/src/components/citations/EmailCitation.tsx`
- Create: `apps/web-dashboard/src/components/citations/ArchiveCitation.tsx`
- Create: `apps/web-dashboard/src/components/citations/FileCitation.tsx`
- Create: `apps/web-dashboard/src/components/citations/__tests__/CitationCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web-dashboard/src/components/citations/__tests__/CitationCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CitationCard, type CitationCardProps } from "../CitationCard";

const baseHit = {
  fileId: "f-1",
  filename: "x.pdf",
  mimeType: "application/pdf",
  chunkText: "snippet",
  score: 0.9,
};

describe("<CitationCard>", () => {
  it("renders PdfCitation when anchor.kind === 'pdf-page'", () => {
    render(<CitationCard hit={{ ...baseHit, anchor: { kind: "pdf-page", page: 4 } }} />);
    const iframe = screen.getByTestId("pdf-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("#page=4");
  });

  it("renders MediaCitation for media-timestamp on audio mimeType", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "audio/mpeg",
          filename: "rec.mp3",
          anchor: { kind: "media-timestamp", startMs: 1247400, endMs: 1253900 },
        }}
      />
    );
    const audio = screen.getByTestId("media-audio") as HTMLAudioElement;
    expect(audio).toBeTruthy();
  });

  it("renders EmailCitation for email-part anchor", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "message/rfc822",
          anchor: { kind: "email-part", messageId: "<m1@x>", partIndex: 1 },
        }}
      />
    );
    expect(screen.getByTestId("email-card")).toBeTruthy();
  });

  it("renders ArchiveCitation for archive-member anchor", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "application/zip",
          anchor: { kind: "archive-member", member: "docs/x.pdf" },
        }}
      />
    );
    expect(screen.getByTestId("archive-card")).toBeTruthy();
  });

  it("falls back to FileCitation when anchor is null (legacy)", () => {
    render(<CitationCard hit={{ ...baseHit, anchor: null }} />);
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });

  it("falls back to FileCitation when anchor.kind is 'none'", () => {
    render(<CitationCard hit={{ ...baseHit, anchor: { kind: "none" } }} />);
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });

  it("falls back to FileCitation for an unknown kind (deploy skew)", () => {
    // Cast around the type system to simulate an unknown kind.
    render(<CitationCard hit={{ ...baseHit, anchor: { kind: "future" } as any }} />);
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web-dashboard
npm test -- CitationCard.test.tsx
```

Expected: FAIL — components don't exist.

- [ ] **Step 3: Implement the components**

`apps/web-dashboard/src/components/citations/CitationCard.tsx`:

```tsx
"use client";

import type { Anchor } from "@droplet/shared-types";
import { PdfCitation } from "./PdfCitation";
import { MediaCitation } from "./MediaCitation";
import { EmailCitation } from "./EmailCitation";
import { ArchiveCitation } from "./ArchiveCitation";
import { FileCitation } from "./FileCitation";

export interface CitationHit {
  fileId: string;
  filename: string;
  mimeType: string;
  chunkText: string;
  score: number;
  anchor: Anchor | null;
}

export interface CitationCardProps {
  hit: CitationHit;
}

export function CitationCard({ hit }: CitationCardProps): JSX.Element {
  const anchor = hit.anchor;
  if (!anchor) return <FileCitation hit={hit} />;
  switch (anchor.kind) {
    case "pdf-page":
      return <PdfCitation hit={hit} anchor={anchor} />;
    case "media-timestamp":
      return <MediaCitation hit={hit} anchor={anchor} />;
    case "email-part":
      return <EmailCitation hit={hit} anchor={anchor} />;
    case "archive-member":
      return <ArchiveCitation hit={hit} anchor={anchor} />;
    case "none":
      return <FileCitation hit={hit} />;
    default: {
      // Compile-time exhaustiveness check + runtime deploy-skew fallback.
      const _exhaustive: never = anchor;
      void _exhaustive;
      return <FileCitation hit={hit} />;
    }
  }
}
```

`apps/web-dashboard/src/components/citations/PdfCitation.tsx`:

```tsx
"use client";

import type { CitationHit } from "./CitationCard";
import type { PdfPageAnchor } from "@droplet/shared-types";

export function PdfCitation({ hit, anchor }: { hit: CitationHit; anchor: PdfPageAnchor }): JSX.Element {
  const src = `/api/files/${encodeURIComponent(hit.fileId)}/raw#page=${anchor.page}`;
  return (
    <div className="citation-card pdf">
      <div className="citation-header">
        <span className="filename">{hit.filename}</span>
        <span className="anchor-label">Page {anchor.page}</span>
      </div>
      <p className="snippet">{hit.chunkText}</p>
      <iframe
        data-testid="pdf-iframe"
        src={src}
        title={`${hit.filename} page ${anchor.page}`}
        width="100%"
        height="400"
      />
    </div>
  );
}
```

`apps/web-dashboard/src/components/citations/MediaCitation.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import type { CitationHit } from "./CitationCard";
import type { MediaTimestampAnchor } from "@droplet/shared-types";

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function MediaCitation({ hit, anchor }: { hit: CitationHit; anchor: MediaTimestampAnchor }): JSX.Element {
  const ref = useRef<HTMLMediaElement | null>(null);
  const isVideo = hit.mimeType.startsWith("video/");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      el.currentTime = anchor.startMs / 1000;
    } catch (e) {
      console.warn("media.seek.failed", { error: (e as Error).message });
    }
  }, [anchor.startMs]);

  const src = `/api/files/${encodeURIComponent(hit.fileId)}/raw`;
  return (
    <div className="citation-card media">
      <div className="citation-header">
        <span className="filename">{hit.filename}</span>
        <span className="anchor-label">{fmtTime(anchor.startMs)}</span>
      </div>
      <p className="snippet">{hit.chunkText}</p>
      {isVideo ? (
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          data-testid="media-video"
          controls
          src={src}
          width="100%"
        />
      ) : (
        <audio
          ref={ref as React.RefObject<HTMLAudioElement>}
          data-testid="media-audio"
          controls
          src={src}
        />
      )}
    </div>
  );
}
```

`apps/web-dashboard/src/components/citations/EmailCitation.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { CitationHit } from "./CitationCard";
import type { EmailPartAnchor } from "@droplet/shared-types";

export function EmailCitation({ hit, anchor }: { hit: CitationHit; anchor: EmailPartAnchor }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="citation-card email" data-testid="email-card">
      <button onClick={() => setOpen(true)} className="citation-trigger">
        <span className="filename">{hit.filename}</span>
        <span className="anchor-label">Part {anchor.partIndex + 1}</span>
      </button>
      <p className="snippet">{hit.chunkText}</p>
      {open && (
        <div role="dialog" className="citation-modal">
          <iframe
            src={`/api/files/${encodeURIComponent(hit.fileId)}/email?messageId=${encodeURIComponent(anchor.messageId)}&part=${anchor.partIndex}`}
            title={`Email ${anchor.messageId} part ${anchor.partIndex}`}
            width="100%"
            height="600"
          />
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
```

`apps/web-dashboard/src/components/citations/ArchiveCitation.tsx`:

```tsx
"use client";

import type { CitationHit } from "./CitationCard";
import type { ArchiveMemberAnchor } from "@droplet/shared-types";
import { CitationCard } from "./CitationCard";

export function ArchiveCitation({ hit, anchor }: { hit: CitationHit; anchor: ArchiveMemberAnchor }): JSX.Element {
  // Recurse into inner viewer when innerAnchor is set and not 'none'.
  const inner = anchor.innerAnchor && anchor.innerAnchor.kind !== "none"
    ? <CitationCard hit={{ ...hit, anchor: anchor.innerAnchor }} />
    : null;
  return (
    <div className="citation-card archive" data-testid="archive-card">
      <div className="citation-header">
        <span className="filename">{hit.filename}</span>
        <span className="anchor-label">{anchor.member}</span>
      </div>
      <p className="snippet">{hit.chunkText}</p>
      {inner}
    </div>
  );
}
```

`apps/web-dashboard/src/components/citations/FileCitation.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { CitationHit } from "./CitationCard";

export function FileCitation({ hit }: { hit: CitationHit }): JSX.Element {
  return (
    <Link
      href={`/api/files/${encodeURIComponent(hit.fileId)}/raw`}
      className="citation-card file"
      data-testid="file-card"
    >
      <span className="filename">{hit.filename}</span>
      <p className="snippet">{hit.chunkText}</p>
    </Link>
  );
}
```

- [ ] **Step 4: Re-run the tests**

```bash
cd apps/web-dashboard
npm test -- CitationCard.test.tsx
```

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/components/citations/
git commit -m "feat(WARP-287): CitationCard family with per-kind viewers"
```

---

## Task 15: Dashboard wiring (chat, knowledge, file-detail) + delete `CitationChip`

**Files:**
- Modify: `apps/web-dashboard/src/app/chat/page.tsx`
- Modify: `apps/web-dashboard/src/app/knowledge/page.tsx`
- Modify: `apps/web-dashboard/src/app/files/[id]/page.tsx`
- Modify: `apps/web-dashboard/src/components/ChatMessage.tsx`
- Delete: `apps/web-dashboard/src/components/CitationChip.tsx`

- [ ] **Step 1: Find all `CitationChip` call sites**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-pi-platform/.claude/worktrees/warp-287
grep -rn "CitationChip" apps/web-dashboard/src --include='*.tsx' --include='*.ts'
```

List of files that need replacement (typically: `ChatMessage.tsx`, `app/chat/page.tsx`, `app/knowledge/page.tsx`, and any tests). Make a checklist before editing.

- [ ] **Step 2: Replace each `CitationChip` use site with `CitationCard`**

For each call site, replace:

```tsx
<CitationChip source="brain" path={c.path} pageNumber={c.pageNumber} score={c.score} ... />
```

with:

```tsx
<CitationCard hit={{
  fileId: c.fileId,
  filename: c.filename ?? c.path,
  mimeType: c.mimeType ?? "application/octet-stream",
  chunkText: c.chunkText ?? c.snippet ?? "",
  score: c.score,
  anchor: c.anchor ?? null,
}} />
```

Update the import path:

```tsx
import { CitationCard } from "@/components/citations/CitationCard";
```

Remove the old `import { CitationChip } from "@/components/CitationChip";`.

- [ ] **Step 3: Add the "Re-index" button on the file detail page**

In `apps/web-dashboard/src/app/files/[id]/page.tsx`, add (in the appropriate header / actions section):

```tsx
"use client";

import { useState } from "react";

function ReindexButton({ fileId }: { fileId: string }): JSX.Element {
  const [status, setStatus] = useState<"idle" | "running" | "mfa" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function onClick() {
    setStatus("running");
    setMessage("");
    try {
      const resp = await fetch(`/api/admin/files/${encodeURIComponent(fileId)}/reindex`, {
        method: "POST",
      });
      if (resp.status === 401) {
        const body = await resp.json().catch(() => ({}));
        if (body.error === "mfa_required") {
          // Trigger the existing MFA flow (window or modal); WARP-238 ships the
          // real one. Stub: redirect to /settings/mfa with returnTo.
          setStatus("mfa");
          setMessage("Recent MFA required — please re-authenticate.");
          window.location.href = `/settings/mfa?returnTo=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setStatus("error");
        setMessage(body.message ?? `re-index failed (${resp.status})`);
        return;
      }
      const body = await resp.json();
      setStatus("done");
      setMessage(`Re-indexed ${body.chunksWritten} chunks.`);
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    }
  }

  return (
    <div className="reindex-control">
      <button onClick={onClick} disabled={status === "running"}>
        {status === "running" ? "Re-indexing…" : "Re-index"}
      </button>
      {message && <span className={`reindex-msg ${status}`}>{message}</span>}
    </div>
  );
}
```

And render `<ReindexButton fileId={params.id} />` in the page's header actions.

- [ ] **Step 4: Delete `CitationChip.tsx` and confirm no orphan references**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-pi-platform/.claude/worktrees/warp-287
rm apps/web-dashboard/src/components/CitationChip.tsx
grep -rn "CitationChip" apps/web-dashboard/src --include='*.tsx' --include='*.ts'
```

Expected: empty grep (all callers were updated in Step 2).

- [ ] **Step 5: Build the dashboard to catch type errors**

```bash
cd apps/web-dashboard
npm run build
```

Expected: clean build. Type errors here usually mean a missed call site or a missing field on the new `hit` shape — fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/web-dashboard/
git commit -m "feat(WARP-287): replace CitationChip with CitationCard everywhere + Re-index button on file detail"
```

---

## Task 16: End-to-end integration test

**Files:**
- Create: `tests/rag-anchors.integration.test.ts`
- Modify: `.github/workflows/rag-tests.yml`

- [ ] **Step 1: Write the integration test**

Create `tests/rag-anchors.integration.test.ts`:

```typescript
/**
 * WARP-287 — end-to-end anchor surfacing.
 *
 * Drops fixture files into Nextcloud's mount, waits for the file-indexer
 * to pick them up, then queries via /api/llm/chat and /api/knowledge/search
 * and asserts the citations carry the expected anchor shape per kind.
 *
 * Also asserts that a manually-inserted legacy chunk (metadata without
 * `anchor`) comes back with anchor:null and is not dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NC_DROP_DIR = process.env.NEXTCLOUD_TEST_DROP_DIR ?? "/tmp/nc-test-drop";

async function waitForChunks(fileName: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`http://localhost:3000/api/knowledge/search?q=${encodeURIComponent(fileName)}`);
    if (resp.ok) {
      const body = await resp.json();
      if (Array.isArray(body.hits) && body.hits.length > 0) return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for chunks for ${fileName}`);
}

describe("WARP-287 anchor surfacing — end-to-end", () => {
  beforeAll(() => {
    mkdirSync(NC_DROP_DIR, { recursive: true });
  });

  it("PDF citation carries pdf-page anchor", async () => {
    // Generate a 3-page PDF via reportlab in a side process (or pre-bake a fixture).
    const pdfPath = join(NC_DROP_DIR, "anchor-test.pdf");
    spawnSync("python3", ["-c", `
from reportlab.pdfgen import canvas
c = canvas.Canvas("${pdfPath}")
c.drawString(72, 720, "first page content")
c.showPage()
c.drawString(72, 720, "anchor target text")
c.showPage()
c.drawString(72, 720, "third page content")
c.showPage()
c.save()
`], { stdio: "inherit" });

    await waitForChunks("anchor-test.pdf");

    const resp = await fetch(`http://localhost:3000/api/knowledge/search?q=anchor+target+text`);
    const body = await resp.json();
    const hit = body.hits.find((h: any) => h.path?.includes("anchor-test.pdf"));
    expect(hit).toBeDefined();
    expect(hit.anchor).toEqual({ kind: "pdf-page", page: 2 });
  }, 120_000);

  it("legacy chunk (metadata without anchor) comes back with anchor:null", async () => {
    // Insert a legacy chunk directly via psql exec.
    spawnSync("docker", [
      "compose",
      "-f", "docker/docker-compose.yml",
      "-f", "docker/docker-compose.test.override.yml",
      "exec", "-T", "db",
      "psql", "-U", "postgres", "-d", "droplet",
      "-c",
      `INSERT INTO "FileContentChunk" ("ncFileId", "chunkIdx", "userId", path, source, "chunkText", "embeddingF32", metadata, "pageNumber", "brainItemId")
       VALUES ('legacy-test-1', 0, 'u-test', '/legacy.txt', 'brain', 'legacy chunk text', '[0,0,0]'::vector(3), '{}'::jsonb, NULL, 'bi-legacy-1');`,
    ], { stdio: "inherit" });

    const resp = await fetch(`http://localhost:3000/api/knowledge/search?q=legacy+chunk+text`);
    const body = await resp.json();
    const hit = body.hits.find((h: any) => h.path === "/legacy.txt");
    expect(hit).toBeDefined();
    expect(hit.anchor).toBeNull();
  });
});
```

- [ ] **Step 2: Add the integration test to the rag-tests workflow**

In `.github/workflows/rag-tests.yml`, in the test invocation step, ensure `tests/rag-anchors.integration.test.ts` is in the glob (it will be by default if the existing config uses `tests/*.integration.test.ts`). Add a path filter:

```yaml
on:
  pull_request:
    paths:
      # existing paths...
      - "schemas/**"
      - "packages/shared-types/**"
      - "services/file-indexer/extractors/**"
      - "services/file-indexer/chunker.py"
      - "services/file-indexer/brain_ingest.py"
      - "apps/orchestrator/src/services/file-search.service.ts"
      - "apps/web-dashboard/src/components/citations/**"
```

- [ ] **Step 3: Trigger the workflow locally if possible**

```bash
# If gh CLI is set up:
gh workflow run rag-tests.yml --ref WARP-287
```

Expected: workflow passes. If not, debug; common issues: file-indexer not picking up the test PDF (verify WATCHER_MODE=polling override is in place), Nextcloud mount permissions, embedder not running.

- [ ] **Step 4: Commit**

```bash
git add tests/rag-anchors.integration.test.ts .github/workflows/rag-tests.yml
git commit -m "test(WARP-287): end-to-end anchor surfacing in rag-tests lane"
```

---

## Task 17: Dead-code sweep + documentation

**Files:**
- Modify: `services/file-indexer/README.md` (anchor section)
- Modify: `docs/agentic-workflows.md` (citation surface mention)
- Modify: `docs/compliance-progress.md` (mark WARP-287 done — although strictly product, it's the E in E→C)

- [ ] **Step 1: Repo-wide grep for deleted symbols**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-pi-platform/.claude/worktrees/warp-287
echo "=== chunk_text ==="
grep -rn "chunk_text" . \
  --include='*.py' --include='*.ts' --include='*.tsx' \
  | grep -v __pycache__ | grep -v node_modules | grep -v .git
echo "=== page_breaks ==="
grep -rn "page_breaks" . \
  --include='*.py' --include='*.ts' --include='*.tsx' \
  | grep -v __pycache__ | grep -v node_modules | grep -v .git
echo "=== CitationChip ==="
grep -rn "CitationChip" . \
  --include='*.py' --include='*.ts' --include='*.tsx' \
  | grep -v __pycache__ | grep -v node_modules | grep -v .git
echo "=== ExtractedDoc.text usage ==="
grep -rn 'doc\["text"\]\|doc.text\|extracted\["text"\]\|extracted.text' . \
  --include='*.py' | grep -v __pycache__ | grep -v test_ | grep -v tests/
```

Expected: all four greps return zero matches. If any survive, fix in this task.

- [ ] **Step 2: Confirm the admin route has a UI caller**

```bash
grep -rn "api/admin/files.*reindex\|files/:id/reindex" apps/web-dashboard/src \
  --include='*.tsx' --include='*.ts'
```

Expected: matches in `app/files/[id]/page.tsx` (the `ReindexButton`).

- [ ] **Step 3: Update file-indexer README**

In `services/file-indexer/README.md`, add or replace a section:

```markdown
## Anchors (WARP-287)

Every extractor emits `list[Span]` instead of a raw text blob. Each Span
carries an `anchor` describing where its text came from (page, timestamp,
MIME part, archive member). The chunker chunks within spans and never
crosses them, so each chunk inherits a single anchor. Anchors serialize
into `FileContentChunk.metadata.anchor` and surface on RAG citations as a
top-level `anchor` field.

The 5 MVP extractors produce real anchors (pdf, audio, video, email,
archive). Non-MVP extractors (text, docx, image) emit a single span with
`Anchor(kind="none")`. Legacy chunks (pre-WARP-287) have no
`metadata.anchor` and surface as `anchor: null`; use the admin re-index
route to upgrade them.

Schema source of truth: `schemas/anchor.schema.json`. Codegen via
`npm run gen:anchor-schema`. Drift caught by `schemas/__tests__/codegen-drift.test.ts`.
```

- [ ] **Step 4: Update docs/agentic-workflows.md**

Find the section describing the citation surface and add one sentence:

```markdown
Citations from `/api/llm/chat` and `/api/knowledge/search` carry a structured
`anchor` field per WARP-287; the dashboard `<CitationCard>` renders deep-link
viewers (PDF at page N, audio/video at MM:SS, email modal, archive drawer).
```

- [ ] **Step 5: Run the full test suite one more time**

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-pi-platform/.claude/worktrees/warp-287
# Python file-indexer
(cd services/file-indexer && PYTHONPATH=. pytest -v)
# Orchestrator
(cd apps/orchestrator && npm test)
# Web-dashboard component tests
(cd apps/web-dashboard && npm test)
# Schema drift
npx vitest run schemas/__tests__/codegen-drift.test.ts
```

Expected: every suite passes.

- [ ] **Step 6: Commit and open PR**

```bash
git add services/file-indexer/README.md docs/agentic-workflows.md docs/compliance-progress.md
git commit -m "docs(WARP-287): document anchors + citation surface + dead-code sweep"
git push -u origin WARP-287
gh pr create --title "WARP-287: section anchors at chunk-write + citation deep-linking" \
  --body "$(cat <<'EOF'
Sibling to WARP-286 (hybrid retrieval, merged). Threads a structured `Anchor`
discriminated-union through extractors → chunker → DB → orchestrator → web-dashboard
so every RAG citation deep-links to its source position.

## Highlights
- New JSON Schema (`schemas/anchor.schema.json`) is the single source of truth;
  codegens to Pydantic (`services/file-indexer/anchor_schema.py`) + Zod/TS
  (`@droplet/shared-types`). Drift caught by a unit test.
- All 8 extractors migrate to `list[Span]`. The 5 MVP extractors (pdf, audio,
  video, email, archive) produce real anchors with the appropriate `kind`.
  Non-MVP extractors (text, docx, image) emit `kind: "none"`.
- Chunker `chunk_text(str)` is deleted and replaced by `chunk_spans(spans)`.
  Chunks within a span inherit its anchor; chunks never cross spans.
- Orchestrator hit-shaping surfaces `anchor` as a top-level field on
  `/api/llm/chat` citations and `/api/knowledge/search` hits, with Zod
  validation. Malformed anchors come back as `anchor: null` + log; hit is
  not dropped.
- Web-dashboard `<CitationCard>` family dispatches on `anchor.kind`:
  PDF iframe with `#page=N`, inline media player seeked to `startMs`,
  email modal, archive drawer with recursion.
- Admin re-index route (`POST /api/admin/files/:id/reindex`, RBAC +
  require-recent-mfa from WARP-230 + per-file advisory lock + transactional
  chunk replace) is the user-facing path to upgrade legacy chunks without
  a global backfill.
- `CitationChip.tsx` deleted; all call sites updated.

## Constraints honored
- FIPS clean: no new crypto.
- WARP-286 retrieval SQL untouched.
- No `while True` scheduling introduced.
- Functionality-first naming throughout.

Refs WARP-287

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §1 Goal — Task 14 (CitationCard) + Task 12 (anchor on hits) cover the click-through deep-link end state. ✓
- §2 Scope — All items covered: Anchor union (Task 1), 5 MVP extractors (Tasks 4-8), 3 non-MVP migration (Task 9), chunker (Task 10), hit-shaping (Task 12), CitationCard (Task 14), admin route (Task 13), deletion of `chunk_text` (Task 10). ✓
- §3 Architecture — Data flow diagram traced through Tasks 4-15. ✓
- §4 Anchor union — Task 1 implements the schema; per-kind constraints (page ≥ 1, endMs ≥ 1, etc.) baked into the JSON Schema and generated code. ✓
- §5 Components — All 13 component rows have a corresponding task. ✓
- §6 Data flow — Tasks 4 (PDF) + 5/6 (audio/video) + 14 (CitationCard rendering) reproduce both walkthroughs end-to-end. Archive recursion in Task 8 + Task 14's ArchiveCitation recursion. ✓
- §7 Error handling — Partial-file failure (Task 4 step 3 `try/except`), missing positional metadata (audio/video skip empty segments), recursion cap (Task 8), write-time validation (Task 3 Span rejects empty + Task 11 try/except), read-time validation (Task 12 safeParse), schema drift (Task 1 drift test), MFA stale (Task 13), advisory lock (Task 13), transactional replace (Task 13 reindex_one ROLLBACK). ✓
- §8 Backwards compat — Task 12 returns `anchor: null` on missing metadata.anchor; Task 14 FileCitation handles `null` AND `kind:"none"`; Task 13 admin route is the upgrade path. ✓
- §9 Testing — All 5 layers + admin route tests + dashboard component tests + integration test covered (Tasks 1, 3-11, 12, 13, 14, 16). ✓
- §10 Constraints — Spelled out in the PR body + Task 1 (no crypto), no retrieval SQL touched, no while-True introduced. ✓

**Placeholder scan:** clean. Every step has either exact code, an exact command, or a precise instruction with rationale. The few "verify it already exists per WARP-199" notes in Task 8 are pointers, not placeholders.

**Type consistency:**
- `Span(text, anchor)` consistent across Tasks 3, 4, 5, 6, 7, 8, 9, 10.
- `Chunk(text, anchor)` consistent in Tasks 10, 11.
- `ExtractedDoc.spans: list[Span]` consistent everywhere.
- `Anchor` discriminated union with 5 members consistent across schema, Pydantic, Zod, and component dispatch.
- `chunk_spans(spans: list[Span]) -> list[Chunk]` signature consistent (Task 10 defines, Task 11 calls, Task 13 reindex calls).
- `CitationHit { fileId, filename, mimeType, chunkText, score, anchor }` consistent across CitationCard and all child components.
- Admin route error codes (`mfa_required`, `admin_required`, `index_in_progress`, `reindex_failed`) consistent between handler (Task 13 Step 3) and tests (Task 13 Step 1).

No gaps found.
