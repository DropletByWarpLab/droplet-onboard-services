# doc-render

Turns a document SPEC into `.pdf` / `.docx` / `.xlsx` / `.pptx` bytes (WARP-2211):
`POST /render` with `{format, title, body_markdown}` or
`{format: "xlsx", sheets:[{name, columns, rows, formulas?, chart?}]}`, or a
slide spec `{format: "pdf" | "pptx", title, slides:[{title, bullets}]}`, plus an
open `GET /health`.
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

**Licences.** `python-docx` MIT, `python-pptx` MIT, `openpyxl` MIT, `reportlab` BSD-3-Clause — all
permissive, because shipping the appliance is conveyance. `reportlab` is pure
Python, so no cairo/pango/HarfBuzz (LGPL) native layer enters the image;
WeasyPrint was rejected for exactly that, and wkhtmltopdf is LGPL outright.

**Markdown subset.** Headings (`#`/`##`/`###`), paragraphs, `-` bullets, `1.`
numbered lists, pipe tables, and inline `**bold**` / `*italic*`. Anything else
renders as plain text — a subset is honest when it degrades, not when it drops
input. `markdown_blocks.py` parses once and both the PDF and DOCX renderers
consume the same blocks, so the two formats cannot disagree about what a
document contains.

**Slide decks.** Each supplied slide becomes one landscape 16:9 PDF page or
one editable PowerPoint slide, with native text and shapes. The deck `title`
is metadata; include a title slide in `slides` when desired. `slides` and
`body_markdown`/`sheets` cannot be mixed. A normal PDF request without slides
keeps the existing portrait Markdown document behavior. Slide text is plain
text, so HTML and Markdown markers appear literally. No external media or
file resources are fetched.

Decks accept 1-60 slides, a deck title of at most 255 characters, slide titles
of at most 160 characters, up to 8 nonempty bullets per slide, at most 500
characters per bullet, and at most 50,000 total characters. These are input
ceilings rather than a guarantee that dense text fits: the measured layout
also refuses overcrowded slides with their slide number, asking the caller
to shorten or split the content. It never clips or silently discards text.
The built-in PDF font supports Latin/Windows-1252 characters; unsupported
glyphs and control characters are rejected explicitly. Both output formats
use the same conservative wrapping and readable 32pt headings/22pt body.
The existing 10 MiB output ceiling applies to every format.

**Excel formulas and charts.** Ordinary string cells remain inert text, even
when they start with `=`. Explicit `formulas:[{cell, expression}]` opt into a
bounded numeric grammar: arithmetic, local A1 references, and
`SUM`/`AVERAGE`/`MIN`/`MAX`/`COUNT`/`ROUND`/`ABS`. Formula targets and references
must stay within the existing sheet grid. External links, other sheets,
network functions, and DDE syntax are refused. Recalculation is requested on
open; this service does not evaluate or cache formula results.

An optional `chart:{title, kind:"bar" | "line", category_column, value_column}`
adds a native editable Excel chart. Column indices are 1-based. Charts require
a header row and data; the selected value column must contain numeric values
or explicit formulas. Specs are validated before those features are applied.
Rows wider than the 256-column service ceiling are rejected instead of losing
cells. Headers are bold and frozen, columns have bounded readable widths,
and the populated grid has an autofilter.

Tests: `python -m pytest` from this directory.
