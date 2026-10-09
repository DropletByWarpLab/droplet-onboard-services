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
Bundled Noto Sans fonts support extended Latin, Greek and Cyrillic, with
composed accents preserved through NFC normalization. Unsupported glyphs,
control characters and scripts requiring shaping (such as Arabic/Hebrew)
are rejected explicitly. The unmodified OFL-licensed font files, pinned source
commit and SHA-256 hashes are in `fonts/`. Both output formats use the same
conservative wrapping and readable 32pt headings/22pt body.
The existing 10 MiB output ceiling applies to every format.

Optional `subtitle` (300 characters), `notes` (4,000 characters), and a deck
`theme` (`droplet`, `light`, `dark`) add presentation context and styling.
Notes become native PowerPoint speaker notes and PDF text annotations; they
do not add presented pages. Each slide chooses one content layout:

- `bullets`: the existing text layout.
- `columns:[{title?,bullets},{title?,bullets}]`: two sections with optional
  headings (100 characters) and up to eight bullets each.
- `table:{headers,rows}`: one to six headers and one to ten rows, with exactly
  one plain-text cell per header (at most 200 characters per cell). These
  become editable native PowerPoint tables and vector PDF tables.
- `chart:{kind,labels,series:[{name,values}]}`: native editable PowerPoint
  charts with embedded Excel data, and vector PDF charts. `kind` is `bar`,
  `line` or `pie`; one to ten labels and one to four named series are allowed.
  Labels/names contain at most 60 characters; every series must have one
  finite numeric value per label, between -1e12 and 1e12. Pie charts accept
  exactly one nonnegative series with a positive total.
- `image:{content_base64,caption?,alt?}`: trusted PNG/JPEG bytes hydrated by the
  orchestrator from a caller-authorized File Store path or owned approved
  attachment. Public requests use `{path|item_id,caption?,alt?}`; inline bytes
  and URLs are not accepted there. Images are aspect-fit pictures in PowerPoint
  and PDF, with measured captions and native PowerPoint alternative text.
  At most 12 images, 3 MiB each, 12 MiB combined for source and reconstructed
  bytes, 16 million pixels per image and per deck, and 8,192 pixels per dimension
  are allowed. PNG text expansion is capped at 64 KiB per chunk and 256 KiB
  combined. Pillow fully decodes and re-encodes a single frame, discarding
  metadata and appended bytes. In-place orientation handling avoids extra
  full-size rasters; target-container memory acceptance is still required.

Mixed content layouts are rejected. Measured table cells, columns, chart
labels and legends must fit at their readable font sizes; input ceilings do
not force dense content to fit. All spec text still counts toward the deck
text ceiling. Chart axis identifiers are normalized to schema-valid uint32
values, preserving their cross-references in the generated OOXML.

**Excel formulas and charts.** Ordinary string cells remain inert text, even
when they start with `=`. Explicit `formulas:[{cell, expression}]` opt into a
bounded grammar: arithmetic, comparisons, quoted text, booleans, A1 references
across supplied sheets, and `SUM`/`AVERAGE`/`MIN`/`MAX`/`COUNT`/`ROUND`/`ABS`/
`IF`/`COUNTIF`/`SUMIF`. IF evaluates only its selected branch; both branches
still undergo validation and dependency-cycle checks. Criteria support bounded
numeric/text matching and case-insensitive `*`, `?`, `~` wildcards. SUMIF ranges
must have equal shapes. Formula targets and references
must stay within supplied grids. External links, network functions and DDE
syntax are refused. A bounded local evaluator supplies cached numeric/boolean/text/error
results without replacing formulas. Recalculation is also requested on open;
cycles across the workbook are refused. Quoted sheet names are supported.

An optional `chart:{title, kind:"bar" | "line" | "pie", category_column, value_column}`
adds a native editable Excel chart. Column indices are 1-based. Charts require
a header row and data; the selected value column must contain numeric values
or explicit formulas. Bar/line can use `value_columns` instead for 1–8 series;
pie accepts one series. Optional `formats` set existing ranges to
number/currency/percent/date display formats with bounded precision/symbols.
Specs are validated before those features are applied.
Rows wider than the 256-column service ceiling are rejected instead of losing
cells. Headers are bold and frozen, columns have bounded readable widths,
and the populated grid has an autofilter.

Optional `table_name` creates a native styled Excel table over the supplied
grid. Literal nonblank text headers must be unique and cannot conflict with
header formulas or date formatting. Names must be valid and unique across
workbook tables and defined names; Excel cell references and reserved names
are refused. Structured-reference formulas and pivots are not supported.

**Read-only readiness.** Authenticated `GET /capabilities` returns versioned
format/Office support metadata without rendering a sample or accessing storage.
The orchestrator combines this with caller permissions, personal drive state
and other local service probes for the Creation capabilities panel.

**Existing Office files.** `POST /office` accepts
`{action:"inspect"|"revise", format:"docx"|"xlsx"|"pptx", content_base64, changes?}`.
The orchestrator exposes this through `office_file` and
`POST /api/files/office`: exactly one caller-ACL `source_path` or owned approved
attachment `item_id`. Inspection returns sheet names, existing cell values and
saved formula caches, or stable paragraph IDs for document body/tables,
headers/footers, slide text and speaker notes. It returns at most 200 items,
clips individual text/formulas at 4,000 characters, and explicitly marks
incomplete inspection. Inspection never executes Office or recalculates caches.

Revision accepts 1–200 `changes.cells:[{sheet,cell,value}]` for XLSX, or
`changes.text:[{id,text}]` for DOCX/PPTX, within a 1 MiB operation request.
It writes a new same-format personal-root file with atomic no-overwrite
semantics; the original is untouched. Cell targets must already exist,
strings remain literal, merged ranges require the anchor cell, and shared,
array or data-table formula ranges are refused. Formula/chart caches are
cleared and Excel recalculation is requested. Paragraph replacement preserves
the first text run's formatting, paragraph layout and surrounding native
parts; longer replacements need a layout review. Paragraphs containing
fields, images, objects or content controls cannot be replaced. Untouched
OOXML part content is copied byte-for-byte, preserving native charts,
images, styles and other slides/sheets.

All inputs pass a ZIP/XML guard before inspection or revision: 10 MiB input,
30 MiB total expanded content, 1,000 parts, 8 MiB per part, bounded compression
ratio, no unsafe paths/duplicate names/symlinks/encryption/DTD/entities,
macros, OLE/ActiveX, active/external SVG assets, external relationships,
external workbook links/data connections, network/DDE formulas or Word fields.
Formula screening also covers defined names, validation/table/extension formulas
and legacy XLM paths before a revision can request recalculation. Word field
instructions are joined across runs; external instructions and nested/malformed
fields are refused. Flat local fields such as PAGE can be preserved.
Native PowerPoint chart workbooks are accepted only when a chart references
them and their embedded XLSX passes the same guard. Other embedded objects
are refused. No storage credentials or paths enter this service and it makes
no outbound requests.

Tests: `python -m pytest` from this directory.
