# Creation and research in Droplet chat

These are capabilities inside the Droplet device application. The existing
agent loop, background agent runs and canonical `@droplet/tools-core` registry
remain the entry points. Models submit structured requests; local workers
create bytes. The orchestrator resolves the acting person, checks source ACLs
and saves new files with atomic refuse-to-overwrite writes. File cards use the
existing authenticated Open and Download routes.

## Delivery status

The first document-creation PR (#2727) merged into `stage` on 2026-10-08.
That establishes merged code, not installation on a particular device.
The broader suite below is implemented for review and remains unreleased.
Target-device deployment, GPU model inference, container runtime acceptance
and native-client behavior remain unverified. Image builds and other CI results
are tracked on [the suite PR](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/2733).

| Capability | Device tool / implementation | Status and deployment dependencies |
|---|---|---|
| PDF and editable Word | `create_pdf_report`, `create_word_document` | Existing writers; saved file cards merged into stage |
| PDF and editable PowerPoint | `create_slide_deck` | Basic decks merged into stage; paired exports, authorized images, rich layouts, charts, notes, themes and wider fonts implemented for review |
| Excel | `create_spreadsheet` | Basic formulas/charts merged into stage; cached calculations, conditionals, criteria functions, named tables, cross-sheet references, charts and formats implemented for review |
| Office inspection/revision | `office_file` | Implemented; local doc-render revision API, new copy only |
| Private data analysis | `analyze_data` | Implemented; local sandbox with Linux Landlock/seccomp, fails closed without support |
| Public-web research | `web_search`, `web_fetch` | Implemented; default-off web egress permission, audited screened edge; search also requires provisioned Brave key |
| Interactive HTML results | `create_artifact` | Implemented; downloadable HTML and dashboard preview with browser-enforced connection policy support check |
| Speech recordings | `create_audio` | Implemented; installed local Wyoming TTS voices; saves WAV without room playback |
| Images, image editing, short video | `generate_media` | Job API, local worker and deployment profile implemented; model/GPU inference unverified, profile remains off |
| Background research/work | Existing `start_agent_run` and workspace tools | Creation/research selection and saved-file handoff expanded; existing confirmation and execution rules apply |
| Live creation availability | Chat and Settings panels; `get_system_health` with `creation:true` | Implemented; caller-specific permissions, local service/model prerequisites and explicit unverified states |

Requests such as “produce PDF and PowerPoint from these notes”, “analyze this
spreadsheet and chart the result”, “revise this presentation”, “research these
public sources”, and “make a speech recording” now route to concrete tools.
Use authorized sources for facts, label assumptions, cite web URLs and treat
retrieved content as untrusted evidence. Never claim a file exists before a
successful storage acknowledgement. A pending media job is not a completed file.

## Slide decks

`create_slide_deck` accepts `path`, `title`, optional `theme` (droplet/light/dark),
and 1–60 `slides`. Set `both:true` to save identical content as PDF and editable
PowerPoint. The companion uses the acknowledged primary filename with the
other extension. Both writes refuse overwrite independently. The 55-second
total deadline bounds transport and response parsing. A confirmed primary
file remains in the result if the companion fails; `complete:false` and
`exportErrors` describe partial completion. An interrupted, unacknowledged
write has an unknown storage outcome: check that filename before retrying.

A slide has a title, optional subtitle and speaker notes, and exactly one
layout: bullets, two columns, a table, a bar/line/pie chart, or an image. PowerPoint uses
editable native text, tables and charts with embedded Excel data. PDF uses
vector layouts; notes are text annotations rather than extra presented pages.

Limits include 160 characters per slide title, 300 per subtitle, 4,000 per notes,
eight bullets per section (500 characters each), tables of at most six columns
and ten rows, charts with ten labels and four series (one for pie), and 50,000
total text characters. Measured layouts refuse content that cannot fit at
readable type sizes. Bundled OFL Noto Sans supports extended Latin, Greek and
Cyrillic; unsupported glyphs/shaping are refused. Custom templates, arbitrary
layouts and CJK/RTL shaping remain future work.

An `image` supplies exactly one File Store `path` or owned approved attachment
`item_id`, with optional `caption` and `alt`. Sources must be PNG/JPEG. The
orchestrator checks live caller access and hydrates bytes for the credential-free
worker; URLs and caller-supplied inline bytes are refused. Limits are 12 images,
3 MiB each, 12 MiB combined for both source and reconstructed bytes, 16 million
pixels per image and per deck, and 8,192 pixels per dimension. PNG text expansion
is capped at 64 KiB per chunk and 256 KiB combined. Full decoding and
re-encoding discard metadata and appended content. Images
retain their complete aspect ratio, with measured captions and native
PowerPoint picture alternative text. Access and destination membership are
rechecked before saving. Bounded bookkeeping cannot withhold an acknowledged save.

## Excel

Supplied grids preserve native numeric/boolean values and literal strings.
Formula-looking ordinary strings are escaped; only explicit `formulas`
create formulas. Targets and references must fit supplied grids.

The bounded grammar supports arithmetic, A1 cells/ranges, quoted or unquoted
supplied sheet names, scalar comparisons, quoted text, TRUE/FALSE, and SUM,
AVERAGE, MIN, MAX, COUNT, ROUND, ABS, IF, COUNTIF and SUMIF. IF evaluates only the
selected branch, while all branches undergo syntax, reference and cycle checks.
Criteria support numeric/comparison/text matching and case-insensitive `*`, `?`
and `~` wildcards. SUMIF requires equal-shaped criteria and sum ranges. Nesting,
cell reads, work and elapsed calculation time are bounded.
The local evaluator saves numeric, boolean, text and error caches while retaining formulas and requesting
recalculation on open. Circular dependencies across the workbook are refused;
Excel error results remain explicit. Arbitrary functions, external links,
macros, network functions and DDE are refused.

Each sheet supports one native editable chart: bar/line with one to eight
value columns, or a one-series pie. Choose `value_column` or `value_columns`.
Optional formats cover existing ranges with number/currency/percent/date
styles, precision 0–8 and bounded currency symbols. Headers are frozen and
filtered. Optional `table_name` creates a native styled table over the supplied
grid, with unique literal text headers and a workbook-wide unique valid name.
Formula or formatted headers that would violate native table rules are refused.
Table structured references, general Excel function parity, pivots and complex
chart types remain future work.

## Creation availability

Open Creation capabilities in chat, or the administrator Settings card, to check
local readiness before a task. `GET /api/capabilities/creation` and
`get_system_health` with `creation:true` return the same caller-specific status.
The bounded read-only check respects Files enablement, effective grants,
personal drive access and the default-off audited web policy. It probes fixed
local worker endpoints and installed Wyoming voices without rendering files,
running user code, downloading models, starting GPU inference or contacting a
public search provider. Tokens, worker errors, prompts and internal paths are
never included in the result.

Status distinguishes permission restrictions, disabled features, missing setup,
offline services, busy workers and unverified prerequisites. Installed media
models, kernel analysis eligibility and a configured search key remain
unverified until their respective execution paths prove successful. Browser
support for isolated HTML execution is checked separately by the preview.
Refreshing replaces the previous snapshot; status can change during a task.

## Revising Office files

`office_file` inspects a caller-accessible DOCX/XLSX/PPTX File Store path or an
owned approved chat attachment. Inspection returns bounded paragraph IDs or
sheet/cell structure and explicit truncation counts.

Revision accepts 1–200 existing cell edits or paragraph replacements from an
inspection. It saves a new personal-root filename with the same extension;
the original remains unchanged. Native charts, embedded chart workbooks,
images, tables and untouched package parts are preserved. Replacement text
retains the first text-run style; mixed style reconstruction is not supported.
Cell string edits are literal values. XLSX formula caches affected by revision
are cleared and recalculation requested.

Macros, legacy XLM execution, network/DDE formulas (including defined names,
validation and extension formulas), external Word field instructions, OLE,
unsafe external relationships, DTD/entities, encrypted/linked ZIP
parts and expansion bombs are refused. External hyperlinks in supplied Office
files are currently refused along with other external relationships. Nested or
malformed Word fields are unsupported; flat local fields such as PAGE are
preserved. The source ceiling is 10 MiB; aggregate edit JSON is limited to
1 MiB. Revisions recheck the
live acting person and File Store session before saving.

## Data analysis

`analyze_data` runs bounded offline Python with explicit JSON `inputs` and up to
four authorized CSV/XLSX sources. User code receives `tables`, a stdlib allowlist,
`print`, `emit_csv` and `emit_chart`. No pandas, pip install, arbitrary file
access, network access or subprocess tools are advertised.

Source limits: 3 MiB combined, ten XLSX sheets, 100,000 cells, 10,000 rows and
200 columns, plus ZIP expansion bounds. XLSX reads saved formula caches;
missing caches are null and are not silently recalculated. Results include
bounded JSON/stdout, source summaries and warnings. Up to eight CSV/SVG outputs
(maximum 512,000 bytes each) are saved in a fresh private Analysis directory.
The trusted parent validates every output after the child exits: CSV is parsed
and rewritten with formula-leading text escaped, while strict numeric negatives
remain numeric. SVG accepts only the bounded generated chart format, without
scripts, links, events or arbitrary styles. Invalid output rejects the response;
mutating the child's helper objects cannot bypass these checks.

Kernel Landlock limits filesystem access to read-only Python runtime and the
call's fresh scratch directory. Seccomp defaults to denial and permits only
required runtime/private-scratch syscalls; network, process control, metadata
inspection/mutation and unknown future calls are refused. Memory ceilings are
installed before sealing. This remains effective against Python object-introspection escapes;
the import guard alone is not a security boundary. Unsupported platforms,
kernels or container policies refuse execution. Tokens never enter user code.
Caller ACLs and approval holds are checked before reads; identity and session
revocation are checked before writes.

The sandbox API also installs an inherited Landlock filesystem policy before
starting workspace or extension code whenever a TLS identity is configured or
its raw key is mounted. It loads the TLS context first, removes only its marked
temporary key copies, protects key-holding processes from same-user inspection,
and excludes the raw TLS mount from child access. Workspace files, git, installed
Python/Node runtimes and sockets remain available. Missing kernel support stops
startup before serving customer code, including plaintext mode with mounted
keys. Native Linux probes verify this boundary; target container/kernel
acceptance remains required.

## Web research

Public HTTPS requests go through `web-fetch`, never directly from the model or
orchestrator. The existing default-off off-LAN permission, signed audit,
rate limits and credential/private-query screening apply. DNS results and each
redirect are checked; connections pin a public IP while retaining original TLS
SNI. Internal addresses, non-443 targets and unsafe destinations are refused.
Responses are bounded text/links with source URLs, not executable page content.

Search uses a provisioned Brave key inside web-fetch only. Fetching a public
page requires no search key. Neither tool sends stored private files to search.
Existing confirmed background agent runs can combine multiple source tools;
this change does not promise autonomous research quality or full browser use.

## HTML previews

`create_artifact` saves a new self-contained HTML/CSS/JS file (maximum 192 KiB).
Only explicit artifact media uses an executable preview; ordinary HTML files
remain file cards. Private markup is downloaded only after a trusted static
wrapper proves browser enforcement of its HTTP `Connection-Allowlist: ()`
policy through network and WebRTC probes. Unsupported browsers show the
download option and keep execution disabled.

Private markup travels through a dedicated MessagePort after a static,
non-sensitive port handshake with the trusted wrapper. The opaque sandbox
requires a wildcard target for that handshake only; generated content and file
URLs are never sent through window messages. The single scanner exception
requires explicit security-review acknowledgement before merging.

The content runs in a nested opaque-origin sandbox with restricted CSP, no
same-origin privilege, forms, workers, popups or parent storage access. The
trusted wrapper prevents self-navigation from escaping the network policy.
Probes and wrapper contain no user data. Browser tests covered inline
interaction, attempted HTTP/WebSocket/image/frame/form navigation, parent
access, and DNS prefetch. A hostile STUN attempt sent zero observed UDP packets
on Chrome 154 but crashed its renderer; this browser robustness limitation
remains. Proxy deployments must preserve Connection-Allowlist and CSP headers.
Downloaded HTML is an ordinary local file and does not inherit the app sandbox.

## Speech and generated media

Speech uses installed local Wyoming voices only; discovery never triggers a
model download. Text is limited to 2,000 characters, output to mono 16-bit WAV
of at most 180 seconds / 10 MiB. Two foreground calls are permitted. A total
55-second deadline stays inside the existing tool timeout. No room playback
or voice cloning is performed.

Media generation uses durable owner-scoped job metadata and quick foreground
submission, status/list/cancel tools and a polling dashboard card. Prompts,
source images and credentials are not stored in job metadata. One job runs at
a time; jobs are not queued. Cancellation ends before the atomic saving phase,
and cards appear only after a proven new-file write.

The internal-only `media` compose profile is default-off. Operators must
provision fixed, read-only Diffusers snapshots and a compatible runtime.
SDXL supports text-to-image, image-to-image and masked edits. Wan is the default
text-to-video engine; source-image video requires optional operator-selected
LTX. No chat-request model download, supplied model URL, remote code or cloud
fallback is accepted. Worker deadlines are 120 seconds for images and 300
seconds for video, with bounded dimensions, frames and output. See
[worker contracts and acceptance](../services/media-gen/README.md) for limits,
licenses, optional GPU overlay and outstanding hardware checks.

## Scope still to validate or build

These implementations substantially extend chat, but do not establish full
parity with any flagship service. Remaining work includes target-device
acceptance, model quality/latency, native iOS/Android/Windows/Linux card parity,
general browser automation, richer spreadsheet functions/pivots, templates,
advanced Office layout revisions, broader font shaping, and
provider-specific connector coverage. Existing memory, routines, integrations,
email/calendar and workspace tools are retained; their mere presence is not
proof that every provider and device flow works.

The connected GitHub adapter exposed nine repository metadata results and
readable core, WireGuard Apple and Windows-release sources. Several internal
repository README requests returned 404 through that connection. Those sources,
native implementations and deployment states remain unverified. Do not assume
that all Warp Lab repositories were accessible.

See [component map](COMPONENTS.md), [agent workflows](agentic-workflows.md),
[document renderer](../services/doc-render/README.md), and
[tool inventory](../packages/tools-core/INVENTORY.md).
