# Creating deliverables in Droplet chat

Droplet's device agent uses the canonical `@droplet/tools-core` tools through
MCP. Models produce structured content; the local, stateless `doc-render`
service writes document bytes. The orchestrator authenticates the caller,
checks storage access and atomically creates a new file without overwriting
an existing one. Successful tools return a file card with the existing
authenticated Open and Download routes. Background agent runs also attach
the resulting files.

## Capability status

This document describes code capabilities, not proof that a particular device
has installed them. Check the device's release and module settings before
claiming availability.

| Capability | Existing stage code before this change | This change |
|---|---|---|
| PDF reports | `create_pdf_report`, Markdown headings/lists/tables | Returns a saved-file card directly in chat |
| Editable Word | `create_word_document` | Returns a saved-file card directly in chat |
| PDF slide decks | No dedicated layout/tool | `create_slide_deck`, 16:9, one page per slide |
| Editable PowerPoint | No PPTX renderer | Same deck tool, editable native text and shapes |
| Excel workbooks | `create_spreadsheet`, typed grids, multiple sheets, frozen headers | Explicit local formulas, filters, one bar/line chart per sheet, saved-file card |
| Creation-agent routing | Existing shared agent loop and background runs | Recognizes Excel/workbook/XLSX and PowerPoint/PPTX/deck language; source-grounded creation guidance |

The change is implemented for review. It is not deployed by opening its PR.

## Requests the agent should handle

- "Make a PDF report from these meeting notes."
- "Turn this plan into a slide deck and give me both PDF and PowerPoint."
- "Create an Excel budget with totals and a bar chart."
- "Use the files I attached to produce a quarterly report."

Use supplied content or authorized source tools for facts. Label assumptions;
do not invent results or claim success before the creation tool succeeds.
Use only the returned download URLs for links. Creating both deck formats
requires two calls with identical slide content and distinct filenames.
An existing filename returns `ALREADY_EXISTS`; choose another name.

## Deck specification

`create_slide_deck` accepts `path`, `title`, and `slides`:

```json
{
  "path": "/Documents/quarterly-review.pptx",
  "title": "Quarterly review",
  "slides": [
    {"title": "Quarterly review", "bullets": ["Prepared from the supplied figures"]},
    {"title": "Next steps", "bullets": ["Confirm budget", "Assign owners"]}
  ]
}
```

Use a `.pdf` path for the corresponding PDF. Both formats use the same measured
layout and slide content. Limits: 60 slides, 8 bullets per slide, 160 characters
per slide title, 500 per bullet, 255 for the deck title and 50,000 total text
characters. Content must also fit at readable type sizes; an overcrowded slide
returns its number so the agent can split it. This first layout supports Latin
text, titles and bullets. Images, embedded slide charts, speaker notes, custom
templates and broader font coverage remain future work. Text is never fetched
or interpreted as HTML.

## Excel specification

The existing `sheets` objects accept optional `formulas` and `chart`:

```json
{
  "path": "/Documents/budget.xlsx",
  "sheets": [{
    "name": "Budget",
    "columns": ["Item", "Amount"],
    "rows": [["Supplies", 120], ["Travel", 80], ["Total", null]],
    "formulas": [{"cell": "B4", "expression": "SUM(B2:B3)"}],
    "chart": {"kind": "bar", "title": "Budget", "category_column": 1, "value_column": 2}
  }]
}
```

Numbers and booleans remain native values; identifiers such as `"01234"`
remain strings. Ordinary formula-looking strings are still escaped as text.
Only explicit `formulas` create formulas. They accept local A1 cells/ranges,
numeric literals, arithmetic and SUM, AVERAGE, MIN, MAX, COUNT, ROUND and ABS.
Targets and references must fit the supplied grid; put a placeholder in a cell
before assigning its formula. Each sheet accepts up to 1,000 formulas, with
circular dependencies refused. External links, other sheets, macros and arbitrary
functions are not accepted. Excel recalculates on open; the renderer does not
evaluate formulas or supply cached results.

Charts use two distinct 1-based columns, a header and all supplied data rows.
Choose `bar` or `line`. Multi-series charts, cross-sheet formulas, server-side
calculation and editing an existing workbook remain future work.

## Broader flagship-tool direction

The product goal is broad LLM-tool functionality inside the device's chat.
The following is a capability map and staged backlog, not a claim of parity
with any named product or a release commitment.

| Area | Verified foundation in the core repository | Remaining work to validate or build |
|---|---|---|
| Sources and research | File search, document reading, cloud file search, summaries, citations | Multi-source research workflow and coverage evaluations |
| Documents and data | PDF/DOCX/XLSX writers, this deck writer, calculation/conversion tools | Rich templates, artifact revisions, reliable recalculation and visual fidelity evaluations |
| Code and execution | `workspace_*` tool family and background `agent_runs` | Validate execution isolation, previews and artifact handoff end to end |
| Integrations and actions | Runtime MCP catalogs, email/calendar/business tools | Guided connection flows, permissions and per-provider completeness |
| Memory and repeated work | Memory tools, routines and background runs | Validate durable personalization, scheduling and failure recovery |
| Images, audio and video | Camera tools and separately documented media/voice services | Inventory generation/editing workflows and native-client parity before promising support |
| Interactive artifacts | Existing dashboard media/file cards | Editable artifacts, richer previews and embedded interactive results |
| Device experience | Shared API/tool registry | Validate each native client and the web dashboard against a common capability checklist |

Keep one device agent and canonical registry. Add purpose-specific tools and
guidance rather than another orchestration service for each format. Measure
schema and prompt budgets on every addition: tool selection already limits
advertised domains, and broad capability growth must fit the appliance model's
context window.

Research used the connected GitHub adapter. Public core sources were readable;
several internal repositories returned 404 through that connection. Their
source code and deployment status were not verified. Local repository files
were used for implementation after checking current `origin/stage`.

See [component map](COMPONENTS.md), [agent workflows](agentic-workflows.md),
[document renderer](../services/doc-render/README.md), and
[tool inventory](../packages/tools-core/INVENTORY.md).
