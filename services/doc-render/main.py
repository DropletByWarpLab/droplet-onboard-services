"""
Droplet Doc-Render Service
==========================
Turns a document SPEC into .pdf / .docx / .xlsx / .pptx bytes (WARP-2211).

Why a service at all: the box's model holds a 16384-token window and can emit
at most 4096 tokens (apps/orchestrator/src/config.ts:150,
apps/orchestrator/src/routes/llm.ts:247). A minimum viable .xlsx is 2179 bytes
of ZIP before a single cell of content, and base64 inflates it 4/3 — so the
model cannot produce document bytes, now or at any plausible larger window.
It emits a spec; this renders it.

Why a SEPARATE service: the document libraries are Python (python-docx,
openpyxl, reportlab) and the orchestrator is TypeScript. `file-indexer` already
carries two of the three, but only to READ documents for the RAG index —
putting a writer there would invert that service's direction.

This process is stateless and credential-free. It never touches Nextcloud,
never holds a user token, and makes no outbound network calls: the orchestrator
owns auth, path validation and the upload, and hands over nothing but a spec.
That is what lets the container run with no storage access at all.
"""

import sys as _sys

# WARP-229 sibling idiom: env-gated FIPS 140-3 boot self-test. doc-render is
# NOT one of the six provider-carrying images — compose pins
# DROPLET_FIPS_REQUIRED=false for it, so this is a documented no-op kept for
# shape parity with web-fetch/routing/camera-discovery.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("doc-render")
except ImportError:
    # Helper not present (running outside the production Docker layout).
    pass

import hmac
import os
import base64
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, StrictFloat, StrictInt

import renderers

# Bearer shared with the orchestrator (docker-compose: DOC_RENDER_SERVICE_TOKEN).
# Read at import; require_bearer looks the module global up at call time so
# tests can monkeypatch it (web-fetch / routing precedent).
DOC_RENDER_SERVICE_TOKEN = os.getenv("DOC_RENDER_SERVICE_TOKEN", "").strip()

AUTH_EXEMPT_PATHS = frozenset({"/health"})

# Mirrors MAX_WRITE_BYTES in packages/tools-core/src/handlers/files/_paths.ts.
# Enforced here as well as at the route: a renderer that can be made to return
# 500 MB is a memory-exhaustion lever regardless of what the caller intended.
MAX_OUTPUT_BYTES = 10 * 1024 * 1024
MAX_BODY_CHARS = 200_000
MAX_TITLE_CHARS = 500


def require_bearer(request: Request) -> None:
    """Reject requests without a matching `Authorization: Bearer <token>`.

    Fails CLOSED when no token is configured: an unset DOC_RENDER_SERVICE_TOKEN
    (e.g. a failed secret injection at deploy) yields 503 on every non-/health
    route rather than leaving a document renderer open on the compose network.
    Same posture as web-fetch's require_bearer, deliberately WITHOUT an
    *_ALLOW_NO_AUTH dev escape.
    """
    if request.url.path in AUTH_EXEMPT_PATHS:
        return
    if not DOC_RENDER_SERVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="doc-render auth is not configured (DOC_RENDER_SERVICE_TOKEN unset)",
        )
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip(), DOC_RENDER_SERVICE_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


class FormulaSpec(BaseModel):
    model_config = {"extra": "forbid"}
    cell: str
    expression: str


class ChartSpec(BaseModel):
    model_config = {"extra": "forbid"}
    title: str = ""
    kind: Literal["bar", "line", "pie"]
    category_column: int = Field(strict=True)
    value_column: int | None = Field(default=None, strict=True)
    value_columns: list[StrictInt] | None = None


class CellFormatSpec(BaseModel):
    model_config = {"extra": "forbid"}
    range: str
    kind: Literal["number", "currency", "percent", "date"]
    precision: int = Field(default=2, strict=True)
    currency: str = "USD"


class SheetSpec(BaseModel):
    name: str | None = None
    table_name: str | None = None
    columns: list[Any] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    formulas: list[FormulaSpec] = Field(default_factory=list)
    chart: ChartSpec | None = None
    formats: list[CellFormatSpec] = Field(default_factory=list)


class SlideColumnSpec(BaseModel):
    model_config = {"extra": "forbid"}
    title: str = ""
    bullets: list[str] = Field(default_factory=list)


class SlideTableSpec(BaseModel):
    model_config = {"extra": "forbid"}
    headers: list[str]
    rows: list[list[str]]


class SlideSeriesSpec(BaseModel):
    model_config = {"extra": "forbid"}
    name: str
    values: list[StrictInt | StrictFloat]


class SlideChartSpec(BaseModel):
    model_config = {"extra": "forbid"}
    kind: Literal["bar", "line", "pie"]
    labels: list[str]
    series: list[SlideSeriesSpec]


class SlideImageSpec(BaseModel):
    model_config = {"extra": "forbid"}
    content_base64: str = Field(max_length=4_194_304)
    caption: str = ""
    alt: str = ""


class SlideSpec(BaseModel):
    """Plain text and caller-authorized raster bytes; never remote resources."""

    model_config = {"extra": "forbid"}
    title: str
    bullets: list[str] = Field(default_factory=list)
    subtitle: str = ""
    columns: list[SlideColumnSpec] = Field(default_factory=list)
    table: SlideTableSpec | None = None
    chart: SlideChartSpec | None = None
    notes: str = ""
    image: SlideImageSpec | None = None


class RenderRequest(BaseModel):
    format: Literal["pdf", "docx", "xlsx", "pptx"]
    title: str = ""
    body_markdown: str = ""
    sheets: list[SheetSpec] = Field(default_factory=list)
    slides: list[SlideSpec] = Field(default_factory=list)
    theme: Literal["droplet", "light", "dark"] = "droplet"


class OfficeRequest(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["inspect", "revise"] = "inspect"
    format: Literal["docx", "xlsx", "pptx"]
    content_base64: str = Field(max_length=14_000_000)
    changes: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(
    title="Droplet Doc-Render Service",
    version="1.0.0",
    dependencies=[Depends(require_bearer)],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/capabilities")
async def capabilities():
    # Authenticated local metadata only; never render a sample or touch storage.
    return {"version": 1, "formats": ["pdf", "docx", "xlsx", "pptx"], "office": True}


@app.post("/office")
async def office(req: OfficeRequest):
    from office_files import OfficeError, inspect_office, revise_office
    try:
        raw = base64.b64decode(req.content_base64, validate=True)
        if req.action == "inspect":
            if req.changes: raise OfficeError("Inspection cannot contain revision operations")
            return await run_in_threadpool(inspect_office, raw, req.format)
        output = await run_in_threadpool(revise_office, raw, req.format, req.changes)
        return Response(content=output, media_type=renderers.MIME[req.format])
    except (OfficeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/render")
async def render(req: RenderRequest) -> Response:
    if len(req.title) > MAX_TITLE_CHARS:
        raise HTTPException(status_code=400, detail="title_too_long")
    if len(req.body_markdown) > MAX_BODY_CHARS:
        raise HTTPException(status_code=400, detail="body_too_long")
    if req.slides and req.format not in ("pdf", "pptx"):
        raise HTTPException(status_code=400, detail="slides_require_pdf_or_pptx")
    if (req.slides or req.format == "pptx") and (req.body_markdown or req.sheets):
        raise HTTPException(status_code=400, detail="slides_cannot_mix_with_body_or_sheets")

    try:
        if req.slides or req.format == "pptx":
            payload = renderers.render_slide_deck(
                req.title, [s.model_dump(exclude_none=True) for s in req.slides], req.format, req.theme
            )
        elif req.format == "xlsx":
            # Absence creates an ordinary worksheet; explicit null still reaches
            # the named-table validator and is refused. Preserve other defaults.
            payload = renderers.render_xlsx([
                s.model_dump(exclude={"table_name"} if "table_name" not in s.model_fields_set else None)
                for s in req.sheets
            ])
        elif req.format == "docx":
            payload = renderers.render_docx(req.title, req.body_markdown)
        else:
            payload = renderers.render_pdf(req.title, req.body_markdown)
    except renderers.RenderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if len(payload) > MAX_OUTPUT_BYTES:
        raise HTTPException(status_code=413, detail="rendered_document_too_large")

    return Response(content=payload, media_type=renderers.MIME[req.format])
