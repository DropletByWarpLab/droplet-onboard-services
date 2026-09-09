"""
Droplet Doc-Render Service
==========================
Turns a document SPEC into .pdf / .docx / .xlsx bytes (WARP-2211).

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
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

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


class SheetSpec(BaseModel):
    name: str | None = None
    columns: list[Any] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)


class RenderRequest(BaseModel):
    format: Literal["pdf", "docx", "xlsx"]
    title: str = ""
    body_markdown: str = ""
    sheets: list[SheetSpec] = Field(default_factory=list)


app = FastAPI(
    title="Droplet Doc-Render Service",
    version="1.0.0",
    dependencies=[Depends(require_bearer)],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/render")
async def render(req: RenderRequest) -> Response:
    if len(req.title) > MAX_TITLE_CHARS:
        raise HTTPException(status_code=400, detail="title_too_long")
    if len(req.body_markdown) > MAX_BODY_CHARS:
        raise HTTPException(status_code=400, detail="body_too_long")

    try:
        if req.format == "xlsx":
            payload = renderers.render_xlsx([s.model_dump() for s in req.sheets])
        elif req.format == "docx":
            payload = renderers.render_docx(req.title, req.body_markdown)
        else:
            payload = renderers.render_pdf(req.title, req.body_markdown)
    except renderers.RenderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if len(payload) > MAX_OUTPUT_BYTES:
        raise HTTPException(status_code=413, detail="rendered_document_too_large")

    return Response(content=payload, media_type=renderers.MIME[req.format])
