# doc-render

Turns a document SPEC into `.pdf` / `.docx` / `.xlsx` bytes (WARP-2211):
`POST /render` with `{format, title, body_markdown}` or
`{format: "xlsx", sheets:[{name, columns, rows}]}`, plus an open `GET /health`.
Everything else requires `Authorization: Bearer $DOC_RENDER_SERVICE_TOKEN` and
fails CLOSED when the token is unset.

**Why a service.** The box's model holds a 16384-token window and can emit at
most 4096 tokens. A minimum viable `.xlsx` is 2179 bytes of ZIP before a single
cell of content, and base64 inflates it 4/3 — so the model cannot produce
document bytes at any plausible window. It emits a spec; this renders it.
Python, because the writers are (`python-docx`, `openpyxl`, `reportlab`) and
the orchestrator is TypeScript. `file-indexer` already carries two of the
three, but only to READ documents for the RAG index — putting a writer there
would invert that service's direction.

**Stateless and credential-free.** No Nextcloud access, no user token, no
outbound network. The orchestrator's `POST /api/files/render` owns auth, path
validation, the refuse-to-overwrite check and the upload, and hands over
nothing but a spec. That is what lets this container run with no storage access
at all.

**Licences.** `python-docx` MIT, `openpyxl` MIT, `reportlab` BSD-3-Clause — all
permissive, because shipping the appliance is conveyance. `reportlab` is pure
Python, so no cairo/pango/HarfBuzz (LGPL) native layer enters the image;
WeasyPrint was rejected for exactly that, and wkhtmltopdf is LGPL outright.

**Markdown subset.** Headings (`#`/`##`/`###`), paragraphs, `-` bullets, `1.`
numbered lists, pipe tables, and inline `**bold**` / `*italic*`. Anything else
renders as plain text — a subset is honest when it degrades, not when it drops
input. `markdown_blocks.py` parses once and both the PDF and DOCX renderers
consume the same blocks, so the two formats cannot disagree about what a
document contains.

Tests: `python -m pytest` from this directory.
