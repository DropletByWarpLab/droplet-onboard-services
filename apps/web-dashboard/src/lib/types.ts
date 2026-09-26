import type { ScoreKind } from "./relevance";

/**
 * One LLM tool dispatch surfaced inline on an assistant message. Built
 * from the `tool_call` + `tool_result` SSE events emitted by the
 * orchestrator's MCP-backed agent loop. `status === "confirmation_required"`
 * is the Tier-2 confirmation passthrough — the dashboard renders an
 * approval chip when that lands.
 */
export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // Result fields — populated when the matching `tool_result` event arrives.
  // Until then `ok` is undefined and the chip can show a spinner.
  ok?: boolean;
  data?: unknown;
  status?: string;
  message?: string;
  /**
   * WARP-640 — one-click re-issue handle for a confirmation the chat chip can
   * complete itself (e.g. `run_scene`). When present, the chip renders an
   * "Approve & run" button that re-POSTs with the single-use token to finish
   * the action. Absent for tools confirmed on a dedicated dashboard surface.
   */
  /**
   * WARP-2469 — `kind: "tool_confirmation"` is a WARP-2305 interceptor
   * challenge, rendered as an in-chat approval prompt. It carries a
   * `challengeId` and, deliberately, NO token: the interceptor's secret
   * never leaves the orchestrator, so holding the SSE stream is not the
   * same as holding the approval. Every other `kind` is the pre-existing
   * WARP-640 one-click handle and still carries `confirmationToken` —
   * read that field only after checking `kind`.
   */
  confirmation?: {
    kind: string;
    sceneId?: string;
    confirmationToken?: string;
    challengeId?: string;
    tool?: string;
    status?: string;
    /** Epoch ms. Past this the prompt renders as expired. */
    expiresAt?: number;
    /** PHI-free argument summary; never an argument VALUE. */
    summary?: {
      tool: string;
      fields: { key: string; kind: string; detail: string; value?: boolean }[];
      truncatedFields: number;
    };
  };
  /**
   * Local approve-button state: undefined = idle, then running →
   * ran/failed. WARP-2469 adds `denied` and `expired`, which are decided
   * states rather than in-flight ones: a denied prompt must not read as
   * a failure the user should retry.
   */
  confirmState?: "running" | "ran" | "failed" | "denied" | "expired";
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** Tool dispatches surfaced on this assistant turn (if any). */
  toolCalls?: ChatToolCall[];
  /**
   * WARP-458 — concatenated deep-reasoning trace for this assistant
   * turn. Accumulated live from `reasoning_step` SSE events and carried
   * through loadConversation from the persisted row.
   *
   * WARP-1602/WARP-1605 — this is a FLATTENED LIST, not free text: one entry
   * per agent iteration that produced thinking, joined with the orchestrator's
   * `REASONING_STEP_SEPARATOR` (mirrored in
   * `@/components/chat/reasoning-trace`). Use `splitReasoningSteps()` to read
   * it; never render the raw string. Both sources agree on the shape, so a
   * live turn and the same turn after reload split identically. A trace with
   * no separator — every pre-WARP-1602 row and every single-iteration turn —
   * is simply a one-entry list.
   *
   * A non-empty trace promotes the turn's thinking into its own message row
   * (`<ThinkingMessage>`) above the answer bubble; the trace itself stays
   * collapsed behind the "Thought process" disclosure (harmony analysis text
   * must not be shown to users unbidden).
   */
  reasoning?: string;
  /** WARP-844 — thumbs rating on an assistant turn (null/absent = unrated). */
  feedback?: "up" | "down" | null;
  /**
   * WARP-904 — the model/provider this specific turn actually ran on.
   * Populated from the persisted row via `loadConversation`; absent on a
   * live-streaming message (the composer already knows its own
   * selection) and on rows persisted before this column existed.
   */
  model?: string | null;
  provider?: string | null;
  /**
   * Set on an assistant message when the turn failed (network error,
   * ai-gateway down, MCP child crashed, model returned `stop_reason:
   * "error"`). The UI renders a friendly message + retry button rather
   * than the raw error string. `retryPrompt` is the user prompt that
   * drove this turn — clicking retry re-sends it.
   */
  error?: { message: string; retryPrompt: string };
  /**
   * Set on an assistant message when the user clicked the Stop button
   * mid-stream (WARP-295). Distinct from `error`: stopping is intentional,
   * the partial content is kept verbatim, and the UI tags the bubble with
   * a plain "Stopped by you" marker rather than an error chrome.
   */
  stopped?: boolean;
  /**
   * Citations attached to this assistant turn — extracted from
   * retrieval-tool results during the stream (WARP-295). Rendered as
   * `<CitationChip>` chips below the message bubble.
   */
  citations?: ChatCitation[];
  /**
   * Set when an assistant message rehydrated from history did not finish
   * cleanly. Drives the FailureChip variant in <ChatMessage>.
   *   - "failed"       — server-side error (status=failed)
   *   - "aborted"      — user-cancelled mid-stream (status=aborted)
   *   - "interrupted"  — server died mid-stream (status=streaming on load)
   *   - "missing"      — synthetic placeholder for a tail-orphan user turn
   *                      whose assistant row was never persisted
   * Live-streaming turns continue to use `error` / `stopped`; this field
   * is populated exclusively by `loadConversation`.
   */
  failureKind?: "failed" | "aborted" | "interrupted" | "missing";
  /**
   * WARP-859 — files attached on a user turn. Snapshotted from the
   * composer at send time so the file rides visibly onto the message it
   * was sent with (and leaves the input). Display-only; the live status
   * is frozen at send. Absent on assistant turns and on rehydrated
   * history (server doesn't link brain items to individual messages —
   * the conversation-scoped list drives SessionHeader instead).
   */
  attachments?: ChatAttachment[];
  /**
   * WARP-903 — set on the streaming assistant placeholder while the
   * orchestrator cold-loads the selected model (from the `model_loading`
   * SSE event, emitted before the agent loop); cleared by the NEXT event
   * on the stream — once the model produces anything it is resident.
   * Drives the "Loading <model> (<size> GB)…" copy on the pre-first-token
   * thinking indicator so a 30-60 s cold load is never a silent gap.
   * `sizeGb` is decimal gigabytes (one decimal) or null when the
   * orchestrator couldn't report a size. Live-streaming only — never
   * persisted, never set by loadConversation.
   */
  modelLoading?: { model: string; sizeGb: number | null };
}

/**
 * One retrieval source surfaced by an MCP retrieval tool (brain search,
 * file search). Mirrors the shape `CitationChip` already consumes in
 * `/knowledge/SearchTab`, so the same component is reused without
 * adapter code on the chat surface.
 */
export interface ChatCitation {
  source: "nextcloud" | "brain";
  path: string;
  pageNumber?: number | null;
  score?: number;
  /**
   * WARP-1611 — the scale `score` is in, as reported by the producer.
   * Optional at every layer: absent means "infer" (`inferScoreKind`), so an
   * older payload renders exactly as it did before the tag existed.
   */
  scoreKind?: ScoreKind;
  brainItemId?: string | null;
  snippet?: string;
  mimeType?: string;
}

/**
 * One chat-attached file (WARP-203). Backed by a BrainMemoryItem row
 * on the orchestrator. `status` flips from "pending" → "ready" / "failed"
 * via the per-user MQTT topic `droplet/files/<user>/brain/indexed` that
 * the WS bridge forwards to the dashboard.
 */
export interface ChatAttachment {
  /** Locally-generated id used as the React key while the upload is in flight. */
  localId: string;
  /** BrainMemoryItem.id once the upload route returns 202. */
  itemId?: string;
  filename: string;
  bytes: number;
  /** MIME type (from the picked File, or the rehydrated item) — drives the
   *  chip's leading icon (image vs document). */
  mimeType?: string;
  /** The picked File, kept in-memory only (never serialized) so the composer
   *  chip can render a local thumbnail for images. Absent on rehydrated chips. */
  file?: File;
  status: "pending" | "uploading" | "indexing" | "ready" | "failed";
  /** Error message when status="failed" — surfaced on the chip. */
  error?: string;
}

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
  /** WARP-174: skip /chat history persistence for throwaway turns
   * (setup wizard "Ask the AI" probe, health checks). Default false. */
  ephemeral?: boolean;
  /** Brain-memory items attached to this conversation (WARP-203). Sent
   * on every turn; the orchestrator verifies ownership and injects the
   * extracted content as a system message so the model actually sees
   * what the user attached. */
  attachments?: { itemId: string }[];
  /** WARP-458 — ask the orchestrator to emit `reasoning_step` SSE events
   * before the answer. Persistence of the trace happens server-side
   * regardless; this only gates the live wire. */
  captureReasoning?: boolean;
  /** Client-minted draft chat id, sent on the FIRST turn so the server
   * adopts draft-phase brain uploads into the new conversation. */
  draftChatId?: string;
  /** WARP-845 — file a newly-created conversation under this project
   * (first turn only; ownership-validated server-side). */
  projectId?: string;
  /** WARP-1041 — explicit tool allow-list for the orchestrator's agent
   * loop. `[]` advertises ZERO tool schemas (the wizard's curated sample
   * probes need none — cuts ~11k tokens of prefill); OMIT the key
   * entirely to get the role-default registry. The server distinguishes
   * `[]` from absent, so only send `[]` when zero tools is meant. */
  allowed_tools?: string[];
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  context_window: number | null;
  /** Modalities the model supports (from the ai-gateway). `vision` drives the
   *  picker's vision marker so users can tell which models can see images. */
  capabilities?: { vision?: boolean; tools?: boolean };
}

export interface ModelsResponse {
  models: ModelInfo[];
  /** WARP-1284 (additive): true when the orchestrator can't vouch for the
   *  list — the ai-gateway was unreachable, or the gateway reported its
   *  local Ollama provider failed during listing. An empty list WITH
   *  `degraded` means "can't reach the AI service right now", NOT "no
   *  model pulled yet" — the setup wizard renders the two differently. */
  degraded?: boolean;
  /** WARP-1112 (additive): the installed local model the box answers with by
   *  default (`ai.model.chat`, set from /models). null when unset / no longer
   *  installed. The chat picker defaults to this instead of "the first one". */
  defaultModel?: string | null;
}

// ── WARP-836: read-only Models surface (`/models`) ──
//
// Wire shape of `GET /api/models` — the status page payload, distinct from
// `/api/llm/models` (the chat model selector above). Mirrors the orchestrator
// `models-summary.service.ts` types 1:1. Many fields are intentionally
// null/0 today: they are DOCUMENTED PLACEHOLDERS for metrics ai-gateway
// doesn't expose yet (gbOnDisk, role, tokensPerSec, diskBarPct, gpu,
// avgLatencyMs) — never fabricated by the dashboard. The page renders them
// as an honest "—"/"Unavailable" and `cloudSpendUsd` as "$0.00".

/** One local LLM served on the box. */
export interface LocalModelRow {
  /** WARP-2882 — the runtime id ("docker.io/ai/gpt-oss:20B-F16"): what every
   *  write and probe sends. Optional only for an orchestrator that predates
   *  the field; then `name` doubles as the id, exactly as before. */
  id?: string;
  /** Display name ("Gpt-oss 20B F16") — for reading, never for sending. */
  name: string;
  family: string;
  provider: string;
  contextLength: number | null;
  /** WARP-2882 (additive; optional so an older orchestrator still parses) —
   *  the context length the model was TRAINED with. Display only: the window
   *  the box actually serves is an operator setting, not this. */
  trainedContextLength?: number | null;
  /** GB on disk — null until ai-gateway exposes per-model disk usage. */
  gbOnDisk: number | null;
  /** "chat" | "embed" | "vision" | … — null until ai-gateway tags models. */
  role: string | null;
  /** Lifecycle of the model in the runtime. Drives the status chip. */
  status: "ready" | "loading" | "error";
  /** Sustained tokens/sec; null until a benchmark surface exists (no honest
   *  at-rest source today) — renders "—", never fabricated. */
  tokensPerSec: number | null;
  /** 0–100 fill for the on-disk usage meter (this model's share of the store);
   *  null until real disk sizes are known. */
  diskBarPct: number | null;
  // WARP-836 honest metrics (additive/optional), measured from Ollama:
  /** Parameter count, e.g. "20.9B". */
  parameterSize?: string | null;
  /** Quantization level, e.g. "MXFP4" / "Q4_K_M". */
  quantization?: string | null;
  /** True when the model is resident in memory right now. */
  loaded?: boolean;
  /** Graphics memory the resident model uses (GB); null when not loaded. */
  vramGb?: number | null;
  /** ISO timestamp of the last throughput benchmark (drives tokensPerSec);
   *  null when never measured. */
  benchmarkedAt?: string | null;
  // WARP-1749 honest metrics, part two: WHY a number is missing.
  /** `measured` → the value next to it is real. `unreported` → this box's AI
   *  runtime can report the field but didn't for this model (render "—"; it
   *  may arrive on a later poll). `unsupported` → this runtime has no way to
   *  report it, so waiting won't help and the card SAYS so rather than leaving
   *  the reader to guess what a dash means. Optional: an orchestrator that
   *  predates the flag omits it and the card falls back to today's rendering. */
  gbOnDiskState?: MetricState;
  /** Same three-way for `vramGb`. `unsupported` on a Docker-Model-Runner box:
   *  its /api/ps never populates `size_vram` on any accelerator, so per-model
   *  graphics memory is genuinely unobtainable there — printing "0 GB" would
   *  be a confident wrong number on a page whose point is honesty. */
  vramState?: MetricState;
  // WARP-1827 placement (additive/optional): where a LOADED model sits.
  /** min(1, size_vram/size), 3 decimals, or null when unknowable. */
  gpuFraction?: number | null;
  /** "gpu" / "partial" / "cpu". Null when not loaded or the runtime can't
   *  say — absence of data is NOT health, so the page only warns on an
   *  explicit "cpu"/"partial", never on a missing value. */
  placement?: ModelPlacement | null;
  /** Why `placement` is null, when it is; null itself for an unloaded row. */
  placementState?: MetricState | null;
}

/** Why a metric has no number. Mirrors the orchestrator's `MetricState`
 *  (model-metrics.service.ts) 1:1 — state is stated on the wire, never
 *  inferred by the dashboard from the absence of a value. */
export type MetricState = "measured" | "unreported" | "unsupported";

/** WARP-1827 — where a LOADED local model's weights actually sit. Mirrors the
 *  orchestrator's `ModelPlacement`; the arithmetic (min(1, size_vram/size),
 *  0.9 GPU threshold) matches the appliance-side enforcement (WARP-1825). */
export type ModelPlacement = "gpu" | "partial" | "cpu";

// ── WARP-1827: pull-from-catalog (`/api/models/catalog` + pull) ──

/** One eligible catalog entry, as the box's inference-manager reports it via
 *  the orchestrator proxy. Every descriptive field is nullable — a gap the
 *  sidecar didn't fill stays a gap, never fabricated. */
export interface CatalogModelEntry {
  /** Catalog identity — also what POST /api/models/:name/pull takes. */
  name: string;
  /** The runtime tag the sidecar will pull (may differ from `name`). */
  pull_tag: string | null;
  min_vram_gb: number | null;
  /** Sidecar's size class, e.g. "flagship" / "compact". */
  class: string | null;
  /** True for the catalog's default recommendation at this VRAM tier. */
  default: boolean;
  display_name: string | null;
  maker: string | null;
  description: string | null;
  capabilities: string[];
  roles: string[];
  /** Approximate download size in GB, when the catalog knows it. */
  disk_gb: number | null;
  /** True when the model is already installed on this box. */
  pulled: boolean;
}

/** Wire shape of `GET /api/models/catalog` — the ELIGIBLE set (VRAM-gated,
 *  decided appliance-side by the inference-manager) with `pulled` flags. */
export interface ModelsCatalogPayload {
  /** null = the box couldn't measure it. */
  detected_vram_gb: number | null;
  /** WARP-3048 — where `detected_vram_gb` came from (`override`,
   *  `device_bridge`, `dgpu_sysfs`, `unified_memory`; null when unknown).
   *  Its presence is what makes a 0 a measurement. Optional: an older
   *  orchestrator drops it. */
  vram_source?: string | null;
  models: CatalogModelEntry[];
  /** WARP-3048 — the sidecar couldn't list what's installed, so `pulled`
   *  can't be trusted (and downloads are refused). Optional: an older
   *  orchestrator drops the flag. */
  tags_unreachable?: boolean;
  /** WARP-3048 — the box's model list file couldn't be read; the catalog
   *  is last-known-good or empty. Optional, as above. */
  degraded_manifest?: boolean;
}

/** One opt-in cloud provider on the Models page. WARP-2871 — the page is the
 *  ONE place for cloud models: the escape switch and the keys live here. */
export interface CloudProviderRow {
  /** WARP-2871: gemini removed — no gateway provider exists for it. */
  provider: "anthropic" | "openai";
  /** Box-wide usable: `escapeEnabled && hasKey === true`. `null` = withheld
   *  from a guest (WARP-3082). */
  enabled: boolean | null;
  /** WARP-2871: null = the gateway could not be asked (render "Unknown",
   *  never "Not set up" — absence of an answer is not absence of a key). */
  hasKey: boolean | null;
  /** ISO timestamp of the last cloud-escape call, or null. */
  lastUsedAt: string | null;
  /** Cumulative spend this billing period; 0 until egress aggregation lands. */
  spendUsd: number;
}

/** WARP-2871 — the workspace `cloud_model_escape` channel as the caller sees
 *  it. `allowedForYou` is the caller's EFFECTIVE verdict (escape && role);
 *  null = unknown, and the page must not guess. */
export interface CloudAccessInfo {
  escapeEnabled: boolean;
  escapeChangedBy: string | null;
  /** ISO */
  escapeChangedAt: string | null;
  allowedForYou: boolean | null;
}

/**
 * GPU stats block — the host device-bridge's reading (WARP-1861), null only
 * when no card resolved at all. Mirrors the orchestrator's `GpuInfo`
 * (services/models-summary.service.ts).
 */
export interface ModelsGpuInfo {
  name: string;
  // WARP-1861: EVERY counter is nullable, because the bridge legitimately
  // cannot always read each one and they fail independently. When nothing
  // holds the card, amdgpu runtime-SUSPENDS it and the sysfs reads return
  // EBUSY rather than a number — so on an idle appliance that is the common
  // case, not an edge case. `0` would be a lie a threshold check would
  // happily pass.
  //
  // GiB, not GB: the conversion behind these is binary (1024³), which is how
  // VRAM is sized, and the tile labels them to match.
  /** Total VRAM. Null on a BRIDGE_GPU_CARD-pinned node whose
   *  mem_info_vram_total is unreadable — the card is still present. */
  vramGiB: number | null;
  /** VRAM in use. Distinct from `utilPct`, which is COMPUTE utilisation and
   *  says nothing about how full the card is. */
  vramUsedGiB: number | null;
  utilPct: number | null;
  tempC: number | null;
}

/**
 * WARP-1861 — why `gpu` is null, when it is. Mirrors the orchestrator's
 * `GpuReason` (services/models-summary.service.ts).
 *
 * `no_card` is a MEASUREMENT: the device-bridge answered and resolved no card.
 * `unreachable` is not — the orchestrator couldn't ask (no token, bridge down,
 * timeout, non-2xx, malformed body), which says nothing about the customer's
 * hardware. Rendering both as "No accelerator detected" is how a box with a
 * working dGPU tells its owner the card is missing because a host unit didn't
 * restart. The two get different copy.
 */
export type ModelsGpuReason = "unreachable" | "no_card" | null;

/** WARP-2883 — one round-trip per inference endpoint, ms; null = no answer. */
export interface EndpointLatencyMs {
  local: number | null;
  anthropic: number | null;
  openai: number | null;
}

export interface ModelsPagePayload {
  local: LocalModelRow[];
  cloud: CloudProviderRow[];
  /** WARP-2871 — escape state + the caller's verdict, for the Cloud section. */
  cloudAccess: CloudAccessInfo;
  gpu: ModelsGpuInfo | null;
  /** WARP-1861 (additive; optional so an older orchestrator that predates the
   *  field still parses). Absent ⇒ we know nothing about why, and the tile
   *  must not guess — see `ModelsGpuReason`. */
  gpuReason?: ModelsGpuReason;
  /** WARP-2883: mean round-trip over the enabled inference endpoints, ms;
   *  0 = nothing answered (render "—", never "0 ms"). */
  avgLatencyMs: number;
  /** WARP-2883 (additive; optional so an older orchestrator still parses):
   *  the per-endpoint samples behind `avgLatencyMs`. null per endpoint =
   *  did not answer; null/absent overall = the gateway could not be asked. */
  endpointLatencyMs?: EndpointLatencyMs | null;
  cloudSpendUsd: number;
  /** WARP-1112 (additive): the installed local model the box answers with by
   *  default (`ai.model.chat`). null when unset or the stored tag is no longer
   *  installed. `PATCH /api/models/active` changes it; the selector on this
   *  page reflects + edits it. Names one of `local[].name`. */
  activeModel?: string | null;
  /** WARP-1289 (additive; optional so an older orchestrator that predates
   *  the flag still parses): true when `local` can't be trusted as complete —
   *  the orchestrator couldn't reach the ai-gateway, or the gateway reported
   *  its local Ollama provider failed during listing. An empty `local` WITH
   *  `degraded` means "can't reach the AI service right now", NOT "no local
   *  models" — the page renders the two differently (same honesty pattern
   *  as the wizard's WARP-1284 model-degraded note). */
  degraded?: boolean;
}

// WARP-311: legacy session types removed alongside the orchestrator
// proxy routes. New persistence shape is `PersistedConversation` in
// `lib/api.ts` (WARP-304).

export interface DeviceInfo {
  id: string;
  deviceId: string;
  hostname: string;
  hardwareRev: string;
  networkMode: string;
  ip: string | null;
  lastSeen: string;
}

// --- File types ---

/**
 * A file or folder as every listing endpoint returns it. `path` is always
 * HOME-relative — groupfolders mount inside each member's home, so a library
 * file's path is "/Finance/Q1/plan.xlsx", not a separate namespace.
 *
 * WARP-1549 deliberately did NOT add a `space`/`spaceName` field here. Which
 * library a path belongs to is derived at render time from the caller's own
 * space list (`lib/space-attribution.ts`), so it can never keep asserting a
 * library after the membership behind it is revoked. The rationale, and what
 * a backend-populated field would still be good for (MCP and mobile, which
 * have no `useSpaces()`), is written up at the top of that module.
 */
export interface FileEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mimeType: string | null;
  modifiedAt: string;
  /**
   * WARP-1683 — Nextcloud numeric fileId (oc:fileid), surfaced by the
   * orchestrator's listing/search parsers so the Messages forward picker
   * can address a file by the stable id the server-side space gate keys
   * on. Optional: older orchestrators (and entries whose PROPFIND
   * response omitted the prop) don't carry it.
   */
  ncFileId?: number;
}

/** WARP-882 — document-server availability for the gated "Edit" affordance. */
export interface DocsStatus {
  state: "ready" | "unavailable";
  engine: string;
}

/** WARP-882 — payload that opens the in-browser editor (server-decided mode). */
export interface DocEditorSession {
  editorUrl: string;
  accessToken: string;
  accessTokenTtl: number;
  ncFileId: number;
  mode: "edit" | "view";
  documentKey: string;
}

// WARP-883 (ADR-027 WS-5) — Files spaces (My Files / shared Household).
// WARP-1261: extended with DB-driven departments/teams.
export type FileSpaceId = string; // "personal", "shared", "dept:<uuid>"

/** A browsable Files space as reported by GET /api/files/spaces. */
export interface FileSpace {
  id: FileSpaceId;
  /** Display name ("My Files", "Household", or department/team name). */
  name: string;
  /** For departments/teams: the `dept:<uuid>` reference; for household: spaceRef='dept:<uuid>' for v2 routing. */
  spaceRef?: string;
  /** Home-relative root path for the space ("/" or mount point). */
  root: string;
  /** The effective right the caller has in this space (personal→undefined, dept→'reader'|'contributor'|'manager'). */
  right?: string;
  /** Space kind — the documented wire values (WARP-1809 narrowed this from
   *  `string` so a typo'd comparison is a type error, not a silent false). */
  kind?: "personal" | "household" | "department" | "team";
  /** Provision state (active, pending, failed, archiving, archived). */
  state?: string;
  /**
   * WARP-1267: true when the caller holds an actual membership row on this
   * space. Owner/admin see every active department/team via see-all even
   * without one — this flag is how the UI distinguishes "I'm a member here"
   * from "I'm an admin visiting a library I don't belong to" (drives the
   * admin foreign-library banner, brief §2). Undefined for personal/household.
   */
  isMember?: boolean;
  /**
   * WARP-1267: for kind='team' only — the parent department's display name.
   * NC mounts team libraries flat; the dashboard owns the hierarchy illusion
   * for the Files breadcrumb and the Spaces menu's nested team rows.
   */
  parentName?: string;
}

export interface FileSpacesResponse {
  sharedAvailable: boolean;
  spaces: FileSpace[];
}

// ── WARP-1270 (T18): Departments & teams tab, invite grants, company files ──

/** One word per person per library (design brief §0.2) — neutral, text-first. */
export type DepartmentRight = "reader" | "contributor" | "manager";

export type DepartmentKind = "HOUSEHOLD" | "DEPARTMENT" | "TEAM";

export type DepartmentState =
  | "pending"
  | "provisioning"
  | "active"
  | "failed"
  | "archiving"
  | "archived";

/** A row from GET /api/departments (list) or the `department` slice of
 *  GET /api/departments/:id. BigInt fields are string-encoded. `myRight`
 *  is the CALLER's own membership right on this unit, or null — never
 *  derived from role (admin see-all is separate from holding a row). */
export interface Department {
  id: string;
  name: string;
  slug: string;
  kind: DepartmentKind;
  parentId: string | null;
  description: string | null;
  state: DepartmentState;
  /** WARP-1507: read-only failure reason for the `failed` ("Needs attention")
   *  state, so the panel can explain WHAT failed. Truncated server-side to
   *  300 chars; null when no failure is recorded. */
  provisionError: string | null;
  quotaBytes: string | null;
  aclVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  memberCount: number;
  teamCount: number;
  myRight: DepartmentRight | null;
  /** Best-effort bytes used, read from the discovered NC groupfolder (one
   *  batch lookup for the whole list). Null on any read failure or before
   *  discovery — never a fabricated 0. */
  usedBytes: string | null;
  /**
   * WARP-2976 (ADR-059 §2.2) — the row's OWN profile summary. `null` is a
   * real state: the department is not set up yet, and the UI says so rather
   * than guessing a template from the name. Optional because the key is
   * absent (not null) on rows the server did not load it for — team
   * summaries inside a detail read, or an orchestrator older than P1 — and
   * absent must never be read as "not set up".
   */
  profile?: DepartmentProfileSummary | null;
}

// ── WARP-2976 (ADR-059 P1): department profiles ──

/** The seven templates. A template is data — default nav hrefs, default home
 *  widgets and a headline figure (`lib/departments/templates.ts`). */
export type DepartmentTemplate =
  | "security"
  | "sales"
  | "finance"
  | "operations"
  | "front_desk"
  | "it"
  | "custom";

export type DepartmentWidgetSize = "s" | "m" | "l";

/** One tile on a department home. `widget` is validated for SHAPE only on the
 *  server; the dashboard skips an id its widget registry does not know. */
export interface DepartmentHomeWidget {
  widget: string;
  size: DepartmentWidgetSize;
}

/** What GET /api/departments carries per row: enough to label the switcher. */
export interface DepartmentProfileSummary {
  template: DepartmentTemplate;
  /** A lucide icon name (kebab-case); unknown names render a fallback glyph. */
  icon: string;
}

/** The full profile — GET/PUT /api/departments/:id/profile. It ARRANGES what a
 *  department shows; it grants nothing (ADR-059 §2.5). */
export interface DepartmentProfile extends DepartmentProfileSummary {
  departmentId: string;
  /** Ordered nav hrefs. An href that is not in NAV_GROUPS never renders. */
  navHrefs: string[];
  homeWidgets: DepartmentHomeWidget[];
  updatedBy: string;
  updatedAt: string;
}

export interface DepartmentProfileResponse {
  profile: DepartmentProfile | null;
  /** Set for a TEAM: the parent department whose profile this is. */
  inheritedFrom: string | null;
  /** Owner/admin, or a manager of this department (or of its parent). */
  canEdit: boolean;
}

export interface PutDepartmentProfilePayload {
  template: DepartmentTemplate;
  icon: string;
  navHrefs: string[];
  homeWidgets: DepartmentHomeWidget[];
}

// ── WARP-2981 (ADR-059 P6, DS-003): the active department, on the server ──

/** The department a person's shell is arranged around, as the box answers it:
 *  enough to label the switcher, nothing more. */
export interface ActiveDepartmentView {
  id: string;
  slug: string;
  name: string;
  /** `null` is a real state: the department is not set up yet. */
  profile: DepartmentProfileSummary | null;
}

/** GET/PUT /api/me/active-department. `scope` is explicit, never read off a
 *  null: `unset` — the person has never chosen, on any device (the shell shows
 *  Whole business, the default for everyone, and a choice this browser kept
 *  from before P6 stands); `whole_business` — chosen; `department` — chosen,
 *  and `department` is set then and only then. */
export type ActiveDepartmentResponse =
  | { scope: "unset"; department: null }
  | { scope: "whole_business"; department: null }
  | { scope: "department"; department: ActiveDepartmentView };

export type DepartmentSyncState = "pending" | "synced" | "failed" | "removing";

/** One row of GET /api/departments/:id's `members` array — no email (the
 *  member table doesn't need it and the column is encrypted-at-rest). */
export interface DepartmentMember {
  userId: string;
  displayName: string;
  right: DepartmentRight;
  syncState: DepartmentSyncState;
  /** WARP-1507: read-only failure reason for a member stuck "Retrying"
   *  (syncState=failed). Truncated server-side to 300 chars; null when
   *  synced/clean. */
  syncError: string | null;
}

export interface DepartmentDetail {
  department: Department;
  /** Best-effort bytes used, read from the discovered NC groupfolder.
   *  Null on any read failure or before discovery — never a fabricated 0. */
  usedBytes: string | null;
  members: DepartmentMember[];
  /** Child TEAM summaries, populated only when `department.kind` is DEPARTMENT. */
  teams: Department[];
}

export interface CreateDepartmentPayload {
  name: string;
  description?: string;
  /** Decimal-string bytes (BigInt wire contract). */
  quotaBytes?: string;
}

/** GET /api/departments/:id/members row → membership-write payload. */
export interface DepartmentMembership {
  id: string;
  departmentId: string;
  userId: string;
  right: DepartmentRight;
  syncState: DepartmentSyncState;
  ncPermissionMask: number | null;
}

export interface TrashItemInfo {
  /** Nextcloud-assigned name used as restore key (e.g. "photo.jpg.d1712860391") */
  name: string;
  /** Original filename before deletion */
  originalName: string;
  /** Original parent directory (e.g. "/Photos") */
  originalLocation: string;
  size: number;
  /** ISO timestamp of when the item was trashed */
  deletedAt: string;
  isDirectory: boolean;
}

export interface FileVersionInfo {
  versionId: string;
  size: number;
  modifiedAt: string;
}

// --- WARP-881 / WS-3 (ADR-027): native file comments + tags ---

/** A Droplet-owned comment on a file (keyed on the NC fileid server-side). */
export interface FileCommentInfo {
  id: string;
  ncFileId: number;
  /** Local User UUID of the author (matches AuthUser.id). */
  authorUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** A Droplet-owned tag on a file. File-scoped — every reader sees every tag. */
export interface FileTagInfo {
  id: string;
  ncFileId: number;
  label: string;
  /** Local User UUID of whoever first added the tag (provenance only). */
  addedByUserId: string;
  createdAt: string;
}

export interface BulkOperationResult {
  path: string;
  ok: boolean;
  error?: string;
}

/** View mode for the file manager — list or grid */
export type FileViewMode = "list" | "grid";

// --- Phase 3: device clients + pairing ---

export interface DeviceClientInfo {
  id: string;
  deviceName: string;
  deviceType: "desktop" | "mobile";
  platform: "macos" | "windows" | "linux" | "ios" | "android" | "other";
  appVersion: string | null;
  lastSeen: string;
  status: "active" | "revoked";
  createdAt: string;
}

export interface PairingCodeInfo {
  code: string;
  expiresAt: string;
  /** `droplet://pair?server=...&code=...` URL the dashboard encodes as a QR */
  pairUrl: string;
}

export interface PairingCodeStatus {
  code: string;
  used: boolean;
  expired: boolean;
  expiresAt: string;
  claimedBy: string | null;
}

// --- Remote Access (WireGuard VPN) ---

export interface VpnPeerInfo {
  id: string;
  userId: string;
  deviceLabel: string;
  publicKey: string;
  assignedIp: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string | null;
  /** WARP-1763 — how this peer came to exist. `"overlay"` is a device the
   *  owner linked by scanning the dashboard QR; those rows carry the synthetic
   *  `userId: "overlay"`, so this is the only field that identifies them. */
  kind?: "static" | "overlay";
  /** Link-token provenance, present only on QR-linked devices. */
  linkTokenLabel?: string | null;
  linkTokenEnrolledBy?: string | null;
  enrolledAt?: string | null;
  /** WARP-1763 — read from the ROUTER, not from the database. The two are not
   *  read the same way and the difference is load-bearing:
   *
   *  `provisioned` is read from the interface's CONFIGURATION (UCI). False
   *  means the row is active but nothing was ever written for this peer on the
   *  router — the WARP-1757 `tunnel_ready: false` case. True means configured,
   *  which is NOT the same as loaded in the running interface; a config change
   *  that never got applied still reads true.
   *
   *  `lastHandshakeAt` is a runtime reading of the running interface: `null`
   *  when it reports a peer that has never handshaken, and ABSENT when the
   *  observation could not be made at all. Never collapse the two: absent
   *  means unknown, and rendering it as "never connected" is the bug this
   *  field replaced. Both are absent whenever `liveStateAvailable` is false. */
  provisioned?: boolean;
  lastHandshakeAt?: string | null;
}

/** Snapshot the dashboard polls before deciding whether to enable the
 *  "Add device" button. `endpointConfigured` is the most user-actionable
 *  signal — when false, the orchestrator will refuse to mint peers. */
export interface VpnStatusInfo {
  configured: boolean;
  endpointConfigured: boolean;
  endpointHost?: string | null;
  /** ADR-023: the publicly-trusted per-device FQDN `d-<hmac>.devices.warp-lab.ai`.
   *  The one address that works at home AND over the tunnel with a green padlock.
   *  Null until the box learns it from HQ. Safe to show to any user (it is
   *  published to Certificate Transparency anyway, carries no PII, has no A record). */
  publicFqdn?: string | null;
  /** WARP-993: is the minted WireGuard conf actually reachable from OUTSIDE
   *  the home LAN? False while the box is FQDN-only (split-horizon, no public
   *  A record — ADR-023 §3) until the ADR-025 relay lands. Every
   *  "from anywhere" surface gates its copy on this; missing ⇒ treat as false
   *  (never over-promise against an older orchestrator). */
  offLanReachable?: boolean;
  /** WARP-1391: the box's discovered home-facing LAN IP — the Endpoint a
   *  HOME-mode peer dials directly. Discovered dynamically (DHCP, never
   *  hardcoded — resolveHomeEndpointHost on the orchestrator); null/absent when
   *  it can't be discovered yet, in which case a home-mode mint 503s. Every
   *  user-facing mint surface gates on this: missing ⇒ treat as "not reachable
   *  at home yet" and show guidance instead of minting a dead config (mirrors
   *  the WARP-993 offLanReachable never-over-promise convention). */
  homeEndpointHost?: string | null;
  /** WARP-2689: does the router's KERNEL hold the wg0 device, as opposed to
   *  merely a uci section for it? `false` is an observation — the router has
   *  no WireGuard support and no conf minted against it can handshake, so the
   *  page must say so and stop offering to add devices. `null`/absent = the
   *  router could not say (older routing build, no ubus grant); treat exactly
   *  like "no information", never like false. */
  interfaceLive?: boolean | null;
  /** WARP-2689: peers the kernel actually holds (vs `peerCount`, the uci
   *  intent). Null when the router cannot say. */
  livePeerCount?: number | null;
  listenPort?: number;
  serverPublicKey?: string;
  addresses?: string[];
  peerCount?: number;
  message?: string;
}

/** Response from POST /api/vpn/peers. The `conf` field is one-shot —
 *  subsequent GETs do NOT include it. The dashboard renders it as a QR
 *  and offers a download, then forgets it on dialog close. */
export interface VpnPeerCreatedInfo {
  peer: VpnPeerInfo;
  /** Full WireGuard .conf text. Contains the peer's private key. */
  conf: string;
  /** WARP-993: same honest reachability signal as VpnStatusInfo, echoed on
   *  the create response so the QR step can gate its copy without a refetch. */
  offLanReachable?: boolean;
}

// ── WARP-1475: overlay QR-enroll (ADR-030) ──

/**
 * One-shot response from `POST /api/vpn/overlay/link-tokens` (owner/admin).
 * The plaintext `token` is returned exactly ONCE — the box persists only its
 * hash. The dashboard encodes {server, token, box_name} into the
 * `droplet://overlay-enroll` QR, shows it, and forgets it on dialog close.
 * Minting again supersedes (expires) the prior token.
 */
export interface OverlayLinkToken {
  /** Plaintext link token (base64url). Shown once; NEVER logged. */
  token: string;
  /** The endpoint host a scanning device redeems the token against. */
  server: string;
  /** Human box name to display in the app while enrolling. */
  box_name: string;
  /** ISO-8601 expiry (~5 min TTL). */
  expires_at: string;
}

/** Lifecycle of a staged overlay enrollment, mirrored from the orchestrator. */
export type OverlayEnrollmentState =
  | "pending"
  | "approving"
  | "approved"
  | "denied"
  | "expired";

/**
 * A staged, awaiting-owner-review overlay enrollment, from
 * `GET /api/vpn/overlay/pending-enrollments` (owner/admin).
 *
 * `label` is DEVICE-PRESENTED (the scanning phone self-reports it at redeem
 * time) — it is untrusted input and MUST render as text, never as HTML.
 * `conflict:true` marks a security event: a second, different device redeemed
 * the same link token (the box flags it for the owner to review, not a benign
 * expiry).
 */
export interface PendingOverlayEnrollment {
  id: string;
  /** Device-presented label — untrusted; render as text only. */
  label: string | null;
  /** First 8 hex of sha256(device sign-key PEM) — the owner eyeball-matches this. */
  fingerprint_short: string;
  /** ISO-8601 timestamp the device presented the token. */
  presented_at: string;
  state: OverlayEnrollmentState;
  /** True when a different device redeemed the same token — a security event. */
  conflict: boolean;
}

/** Response from the approve endpoint on success (200). */
export interface OverlayApproveResult {
  state: "approved";
  /** HQ device ref for the newly-enrolled overlay device; null if not yet known. */
  device_id: string | null;
}

// ── WARP-1036: Voice assistant ──

/** Snapshot of the voice-io wake pipeline, relayed verbatim by the
 *  orchestrator's `/api/voice/status` proxy (snake_case keys are the
 *  voice-io FastAPI response model). The wizard's voice step polls this
 *  while the customer tries "hey droplet": a `last_wake_at` change is the
 *  wake confirmation; `last_transcript` / `last_response` land afterwards
 *  as STT and the reply complete. `state === "no_mic"` drives the
 *  plug-in-a-mic panel (hot-plug recovery needs no restart). */
export interface VoiceStatusInfo {
  /** WARP-1599 — the admin kill switch, relayed verbatim. `false` means
   *  the wake pipeline is not running at all: no detector, no capture
   *  stream, nothing listening. This is the AUTHORITATIVE field for
   *  "is voice on?" — `state` only reports "off" when the pipeline is
   *  absent, so an out-of-band edit of the on-box flag file can leave
   *  `state: "listening"` on a switched-off box. Key the UI on this. */
  enabled: boolean;
  state: string;
  listening: boolean;
  wake_loaded: boolean;
  wake_model?: string | null;
  requested_wake_word?: string | null;
  using_wake_fallback?: boolean;
  threshold: number;
  last_wake_at?: number | null;
  last_wake_score?: number | null;
  last_wake_model?: string | null;
  error_message?: string | null;
  stt_loaded?: boolean;
  last_transcript?: string | null;
  last_transcript_at?: number | null;
  tts_loaded?: boolean;
  last_response?: string | null;
  last_response_at?: number | null;
  llm_loaded?: boolean;
  /** WARP-1037/#818 — input-level telemetry on `/voice/status`, relayed
   *  verbatim by the proxy. `input_rms_dbfs` is a rolling mic RMS over
   *  ~2 s measured INSIDE the pipeline's own frame handler (safe to drive
   *  a live level meter — never a second capture stream on the held hw
   *  device, which would EBUSY). `input_flatlined` is the wedged-DSP /
   *  dead-mic signature: input sat at/near digital zero for the flatline
   *  window while `state === "listening"`. The wizard uses it (WARP-1050)
   *  to say "the mic isn't picking up sound" instead of letting the
   *  customer conclude wake-word detection is broken. `last_audio_at` is
   *  the wall-clock time a frame last carried real signal (null = never). */
  input_rms_dbfs?: number | null;
  last_audio_at?: number | null;
  input_flatlined?: boolean;
  /** WARP-1059 — true while the wizard's calibration mode is live on the
   *  box (wakes counted for the step-3 ticker but not handled — no
   *  STT/LLM/TTS). `calibration_mode_expires_at` is the fail-safe TTL
   *  expiry the wizard renews; null/absent when the mode is off. */
  calibration_mode?: boolean;
  calibration_mode_expires_at?: number | null;
}

/** Result of the wizard's speaker test (`POST /api/voice/say`). */
export interface VoiceSayResult {
  ok: boolean;
  duration_s?: number;
  sample_rate?: number | null;
}

// --- WARP-1055: /voice surface — calibration + wizard measurements ---

/**
 * Persisted mic calibration (`GET /api/voice/calibration`). Written by
 * the wizard's single write (`POST /api/voice/calibration`) and stored
 * on the box; `{calibrated: false}` when no calibration exists yet.
 */
export interface VoiceCalibrationInfo {
  calibrated: boolean;
  /** Epoch seconds of the last applied calibration. */
  calibrated_at?: number | null;
  input_gain?: number | null;
  wake_threshold?: number | null;
  noise_floor_dbfs?: number | null;
  speech_peak_dbfs?: number | null;
  wake_detections?: number | null;
  echo_ok?: boolean | null;
  flags?: string[];
}

/**
 * WARP-1058 — one row of the /voice "Recent voice activity" feed
 * (§3.4). Sourced from `GET /api/activity?kind=voice&limit=5`; `what`
 * is the §3.4 outcome copy ("Answered" / "Missed wake word" / …) the
 * orchestrator wrote into the signed row, and `person` is the wake
 * rows' attribution ("Guest" until voice enrollment lands) — absent on
 * self-heal rows (§6.3: DSP wedge/recovery, processor restarts,
 * calibration applies).
 */
export interface VoiceActivityItem {
  id: string;
  /** Epoch seconds (converted from the API's ISO timestamp). */
  atS: number;
  what: string;
  severity: "ok" | "warn" | "err" | "info";
  person: string | null;
}

/** Payload of the wizard's single write (`POST /api/voice/calibration`). */
export interface VoiceCalibrationApply {
  input_gain?: number;
  wake_threshold?: number;
  noise_floor_dbfs: number;
  speech_peak_dbfs: number;
  wake_detections: number;
  echo_ok: boolean;
  flags: string[];
}

/** One wizard capture (`POST /api/voice/measure`). */
export interface VoiceMeasureResult {
  rms_dbfs: number;
  peak_dbfs: number;
  duration_s: number;
  kind?: string;
}

/** Speaker→mic loop check (`POST /api/voice/echo-check`). */
export interface VoiceEchoCheckResult {
  heard: boolean;
  tone_dbfs: number;
  floor_dbfs: number;
}

/**
 * WARP-1057 — DSP reboot issued (`POST /api/voice/restart-processor`).
 * `restarted_at` anchors the health card's "wait for audio to return"
 * window (~10 s while the XVF3800 re-enumerates).
 */
export interface VoiceRestartResult {
  ok: boolean;
  method: string;
  restarted_at: number;
}

/**
 * WARP-1059 — calibration-mode toggle result (`POST`/`DELETE`
 * `/api/voice/calibration-mode`). `expires_at` is the fail-safe TTL
 * expiry (epoch seconds) after an enter/renew; null after an exit.
 */
export interface VoiceCalibrationModeResult {
  active: boolean;
  expires_at?: number | null;
}

// --- WARP-1056: per-person voiceprints (Flow B enrollment) ---

/**
 * One enrolled voiceprint (`GET /api/voice/profiles`). Metadata ONLY —
 * the embedding never leaves the box. `display_name` /
 * `confused_with_name` are joined by the orchestrator from the local
 * user directory; `learning` is the §5 step-3 honest fallback
 * ("recognition isn't reliable yet — improves with use / re-record"),
 * `confused_with` is the §7.6 hard-to-distinguish sibling.
 */
export interface VoiceProfileInfo {
  user_id: string;
  display_name: string | null;
  enrolled_at: number;
  updated_at: number;
  last_recognized_at?: number | null;
  learning: boolean;
  confused_with?: string | null;
  confused_with_name?: string | null;
  lines: number;
  voice_model: string;
}

/** `GET /api/voice/profiles` — §3.3 listing. `speaker_model_available`
 *  false = the box can't enroll (weights absent): entry points disable
 *  rather than launching a wizard that cannot succeed (§7.2 rule). */
export interface VoiceProfilesResult {
  speaker_model_available: boolean;
  profiles: VoiceProfileInfo[];
}

/** `POST /api/voice/enroll/start` — a Flow B session on the box. */
export interface VoiceEnrollStartResult {
  session_id: string;
  lines_required: number;
}

/** One scripted-line capture (`POST /api/voice/enroll/capture`).
 *  `quality` is the §5/§7.5 capture guard verdict. */
export interface VoiceEnrollCaptureResult {
  quality: "good" | "too_quiet" | "crosstalk";
  captured: number;
  required: number;
}

/** The no-script proof (`POST /api/voice/enroll/verify`). Confidence is
 *  a plain word — the wire carries no percentage, ever (§5 step 3). */
export interface VoiceEnrollVerifyResult {
  quality: "good" | "too_quiet" | "crosstalk";
  matched: boolean;
  confidence?: "high" | "good" | null;
}

/** `POST /api/voice/enroll/commit` — the ONE write of Flow B. */
export interface VoiceEnrollCommitResult {
  saved: boolean;
  profile: VoiceProfileInfo;
}

// ── WARP-446: Coverage extender APs ──

/** State machine values mirrored from the Prisma `ApDeviceStatus` enum.
 *  Kept as a string-literal union so the dashboard's renderers can do
 *  exhaustive switch checks at the type-system level. */
export type ApDeviceStatus =
  | "DISCOVERED"
  | "AWAITING_APPROVAL"
  | "PROVISIONING"
  | "ONLINE"
  | "FAILED"
  | "DECOMMISSIONED";

/** Onboarding backend that owns this AP's discovery + provisioning,
 *  mirrored from the Prisma `ApOnboardBackend` enum (ADR-024 §1). The
 *  dashboard uses it only to derive a vendor label when `vendor` is
 *  null — the approve flow is identical across all three (§4). */
export type ApOnboardBackend = "DROPLET_IMAGE" | "EASYMESH" | "UNIFI";

export interface ApDeviceInfo {
  mac: string;
  displayName: string | null;
  model: string | null;
  serial: string | null;
  version: string | null;
  lastIp: string | null;
  hostname: string | null;
  status: ApDeviceStatus;
  // ADR-024: which onboarding ecosystem this row belongs to + a human
  // vendor label. `backend` always present (schema default
  // DROPLET_IMAGE); `vendor` is null for the Droplet-image extender and
  // for any backend that hasn't reported a brand string yet.
  backend: ApOnboardBackend;
  vendor: string | null;
  failureReason: string | null;
  approvedSsid: string | null;
  firstSeen: string;
  lastSeen: string;
  approvedAt: string | null;
  approvedBy: string | null;
  decommissionedAt: string | null;
  lastOperationId: string | null;
}

/**
 * WARP-979 — response from GET /api/setup/box-name/check. `available` is the
 * best-effort answer; `authoritative` is false until the HQ device-authed
 * registry check lands (coupled fleet-hq follow-up), so the UI stays honest.
 * `reason` + `message` are present only when the name is invalid.
 */
export interface BoxNameCheckResult {
  available: boolean;
  slug: string;
  fqdn: string;
  authoritative: boolean;
  reason?: string;
  message?: string;
}

/**
 * WARP-979 — response from POST /api/setup/box-name.
 *
 * WARP-980 — the persist now also drives a device-auth HQ name CLAIM, so the
 * response carries the AUTHORITATIVE result: `authoritative` is true only when HQ
 * device-auth-confirmed the name belongs to this box (false = persisted but fell
 * back to opaque/bootstrap issuance, e.g. the device isn't registered yet).
 * `taken` + `suggestions` accompany a 409 when HQ says the name is taken.
 */
export interface BoxNameSetResult {
  ok: boolean;
  slug: string;
  fqdn: string;
  /** WARP-980 — HQ device-auth-confirmed the name (present on the 2xx path). */
  authoritative?: boolean;
  /** WARP-980 — true on a 409 name-taken body. */
  taken?: boolean;
  /** WARP-980 — alternate names HQ offered on a 409 name-taken. */
  suggestions?: string[];
}

/**
 * WARP-1039 — response from GET /api/setup/box-name: the CURRENTLY saved box
 * name (normalized slug) + its fqdn, both null when no name has been chosen
 * yet. Read by the AddressStep to rehydrate its input on re-entry and by the
 * VpnStep precheck to render the honest "address is being set up" blocked
 * view instead of bouncing the customer back to a step they already finished.
 */
export interface BoxNameCurrentResult {
  name: string | null;
  fqdn: string | null;
}

/**
 * WARP-1109 — response from POST /api/setup/box-name/rename. Same shape as
 * BoxNameSetResult: the rename RELEASES the current name at HQ then claims the
 * new one, so `authoritative` is true only when HQ device-auth-confirmed the new
 * name (false = the new name was persisted but issuance fell back to
 * opaque/bootstrap and re-claims on the next tick). A 409 name-taken on the NEW
 * name surfaces as a thrown error carrying `code: "BOX_NAME_TAKEN"` + suggestions.
 */
export type BoxNameRenameResult = BoxNameSetResult;
// --- Auth types ---

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
}

/** A row from GET /auth/users. Carries `userId` (the local User UUID, or null
 *  when the Nextcloud account has no matching local row) IN ADDITION to `id`,
 *  which is the Nextcloud username — a DIFFERENT namespace (WARP-947). Self /
 *  identity checks must compare `userId` against the caller's local id, never
 *  `id` against a local username. */
export interface RosterUser extends AuthUser {
  userId: string | null;
  /** WARP-1532 (RBAC v2 T8) — the person's enforcement tier. OPTIONAL until
   *  the T3/T7 roster extension lands server-side: absent means "not sent
   *  yet", and the UI renders no chip rather than fabricating one. */
  role?: AccessTier | null;
  /** WARP-1532 — assigned custom role id (null = plain built-in tier).
   *  Optional for the same parallel-build reason as `role`. */
  accessRoleId?: string | null;
  /** Directory account state, mirrored from Nextcloud's
   *  `/cloud/users/details`. The roster used to drop this, so a deactivated
   *  person looked identical to an active one and the only affordance on the
   *  row was Disable — there was no way back. Optional: a box running an
   *  orchestrator older than this field sends nothing, and `undefined` must
   *  read as enabled rather than painting the whole roster deactivated. */
  enabled?: boolean;
  /** WARP-2984 — where the account comes from. `local`/`sso`/`scim` read the
   *  local row's explicit provisionSource; `nextcloud` is a Nextcloud user
   *  with no local row. Optional: an older orchestrator sends nothing, and the
   *  UI then renders no source chip rather than guessing. */
  source?: RosterSource;
  /** WARP-2984 — false when the account has no Nextcloud user, i.e. no file
   *  storage: storage/upload limits don't apply. Optional for the same
   *  reason; only an explicit false hides the storage controls. */
  hasStorage?: boolean;
}

/** WARP-2984 — see RosterUser.source. */
export type RosterSource = "local" | "sso" | "scim" | "nextcloud";

/** WARP-2984 — roster chip copy per source. */
export const ROSTER_SOURCE_LABEL: Record<RosterSource, string> = {
  local: "Local",
  sso: "SSO",
  scim: "SCIM",
  nextcloud: "Nextcloud only",
};

/** WARP-2984 / WARP-2858 — the IdP owns the credential: the box refuses to set
 *  a local password (409 SSO_MANAGED_ACCOUNT), so the UI never offers one. */
export function isIdpManaged(u: { source?: RosterSource }): boolean {
  return u.source === "sso" || u.source === "scim";
}

// ── WARP-217 invite types ──
export type InviteRole = "user" | "admin";

/** WARP-1042: canonical role vocabulary for direct account creation —
 *  mirrors the orchestrator `Role` enum minus `service` (same shape as
 *  `TeamInviteRole` below). New code must send these canonical values;
 *  the legacy `InviteRole` "user" alias only exists so the server's
 *  one-deploy-window "user"→"family" preprocess can eventually retire.
 *  Follow-up: canonicalize `InviteRole` itself across the invite modal. */
export type CreateUserRole = "owner" | "admin" | "family" | "guest";

export interface InviteCreateRequest {
  email: string;
  displayName?: string;
  /** WARP-1533: the invite modal now sends CANONICAL enum values (the
   *  role picker's tier, or a custom role's startingPoint). The legacy
   *  `InviteRole` "user" alias remains server-accepted for older builds
   *  but is no longer sent. */
  role?: CreateUserRole | InviteRole;
  ttlHours?: number;
  /** WARP-1270 (T18) — optional department/team grants, converted to
   *  DepartmentMembership rows at accept time (orchestrator WARP-1265). */
  departments?: Array<{ departmentId: string; right?: DepartmentRight }>;
  /** WARP-1533 (RBAC v2 T9) — optional custom access role granted by this
   *  invite. Rank-capped server-side via the role's startingPoint; must
   *  agree with `role` (the picker guarantees it by construction). */
  accessRoleId?: string;
}

// ── WARP-1271 (T19a): per-user usage settings ──

/** BigInt fields string-encoded (ADR-029 §8 wire contract). */
export interface UsagePolicy {
  userId: string;
  storageQuotaBytes: string | null;
  quotaSyncState: "pending" | "synced" | "failed" | "removing";
  maxUploadSizeMb: number | null;
  updatedBy: string;
  updatedAt: string;
}

/** GET /api/people/:id/usage response — `usedBytes` is display-only, read
 *  live from Nextcloud; `null` when unknown (no NC account yet, or the read
 *  failed) rather than a fabricated 0. */
export interface UsageWithMeta {
  policy: UsagePolicy | null;
  usedBytes: string | null;
}

/** One row of GET /api/admin/files/usage's `users` array. `"—"` on any
 *  field means the per-user quota read failed — render it verbatim, don't
 *  treat it as a number. */
export interface AdminUsageUserRow {
  userId: string;
  displayName: string;
  quota: string | null;
  used: string;
  free: string | null;
  /** WARP-1270 (T18) — UserUsagePolicy.maxUploadSizeMb override; null =
   *  system default, no override set. */
  largestUploadMb: number | null;
  /** WARP-1270 (T18) — always null today (no per-user activity tracking
   *  yet); render "—", never a fabricated date. */
  lastActive: string | null;
}

export interface AdminUsageDepartmentRow {
  id: string;
  name: string;
  kind: string;
  sizeBytes: string;
  quotaBytes: string | null;
}

export interface AdminFilesUsageResponse {
  users: AdminUsageUserRow[];
  departments: AdminUsageDepartmentRow[];
}

export interface InviteCreateResponse {
  token: string;
  url: string;
  expiresAt: string;
}

// ── WARP-1532 (RBAC v2 T8): Access & Roles wire types ──
// Contract-driven off ADR-032 (ACCESS-AND-ROLES-ARCHITECTURE-BRIEF §2/§5)
// and the MERGED T1 schema (WARP-1525). BigInt fields are STRING-encoded on
// the wire (ADR-029 §8 convention); absence of a grant row = OFF, never
// inferred. The backend routes (T3+) build in parallel — these shapes are
// the fixed contract both sides code against.

/** The full Role pgEnum (display label for `family` is "Staff", §0.1). */
export type AccessTier = "owner" | "admin" | "family" | "guest" | "service";

/** Custom-role starting point — never owner/service (ADR-032 §2 CHECK). */
export type AccessStartingPoint = "admin" | "family" | "guest";

/** §9 catalog action levels (FeatureAccessLevel pgEnum). */
export type FeatureAccessLevel = "view" | "act" | "manage";

/** Per-tool-domain level (ToolAccessLevel pgEnum). */
export type ToolAccessLevel = "view" | "use";

/** Per-connector level (ConnectorAccessLevel pgEnum). Absence = none. */
export type ConnectorAccessLevel = "read" | "read_write";

/** Sync state carried by NC-affecting responses → the "Saved. Applying…"
 *  pattern. Mirrors the shipped NcSyncState vocabulary. */
export type AccessSyncState = "pending" | "synced" | "failed";

export type AccessRoleState = "active" | "archived";

/** The gateable App-Modules vocabulary (ModuleId pgEnum) — ONE feature
 *  vocabulary shared with the module registry; no parallel list to drift. */
export type AccessModuleId =
  | "chat"
  | "knowledge"
  | "files"
  | "docs"
  | "email"
  | "calendar"
  | "projects"
  | "voice"
  | "cameras"
  | "smart_home"
  | "network"
  | "managed_switch"
  | "team_chat"
  | "contacts"
  | "crm"
  /** WARP-2581 — invoices and bills landed from a cloud ledger. */
  | "money"
  /** WARP-2977 — the Security command center (ADR-059). */
  | "security";

export interface AccessRoleFeatureGrant {
  moduleId: AccessModuleId;
  level: FeatureAccessLevel;
}

export interface AccessRoleToolGrant {
  /** ToolDomain value from the tools-core catalog (TS union, not a pgEnum). */
  domain: string;
  level: ToolAccessLevel;
}

export interface AccessRoleConnectorGrant {
  /** IntegrationConnection.provider ("eaglesoft"). */
  provider: string;
  level: ConnectorAccessLevel;
}

/** A custom role as it travels on the wire (GET /api/access/roles[/:id]). */
export interface AccessRole {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startingPoint: AccessStartingPoint;
  state: AccessRoleState;
  /** BigInt → decimal string; null = no limit (box default). */
  storageQuotaBytes: string | null;
  maxUploadSizeMb: number | null;
  llmDailyMessageCap: number | null;
  cloudModelsAllowed: boolean;
  mayOperateLocks: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** How many people currently hold this role (list + detail responses). */
  peopleCount: number;
  /** Present where the mutation cascades to NC / session revocation. */
  syncState?: AccessSyncState;
  featureGrants: AccessRoleFeatureGrant[];
  toolGrants: AccessRoleToolGrantWithState[];
  connectorGrants: AccessRoleConnectorGrant[];
}

/**
 * WARP-2897 — a tool grant as GET /api/access/roles serves it: the row plus
 * whether it reaches anything. `dead` + `not_provided` = a runtime domain no
 * attached tool carries (its extension disabled); `dead` + `empty_domain` =
 * a compiled landing slot (crm/pm) with no tool yet. Optional so older boxes
 * (and hand-built fixtures) still type-check; never sent back on a write.
 */
export interface AccessRoleToolGrantWithState extends AccessRoleToolGrant {
  state?: "live" | "dead";
  deadReason?: "empty_domain" | "not_provided" | null;
}

/** WARP-2897 — GET /api/access/tool-domains. */
export interface AccessToolDomainsResponse {
  /** The compiled grantable domains (server GRANTABLE_TOOL_DOMAINS). */
  compiled: string[];
  /** One entry per runtime-only domain some attached tool carries. */
  runtime: Array<{
    domain: string;
    /** `runtime:<serverId>` per contributing server. */
    sources: string[];
    tools: number;
    populated: boolean;
    /** Holds a tool classified read — reachable for Staff/Guest-based roles. */
    readable: boolean;
  }>;
}

/** POST/PATCH body for /api/access/roles — §2 shape flattened. */
export interface AccessRolePayload {
  name: string;
  description: string | null;
  startingPoint: AccessStartingPoint;
  storageQuotaBytes: string | null;
  maxUploadSizeMb: number | null;
  llmDailyMessageCap: number | null;
  cloudModelsAllowed: boolean;
  mayOperateLocks: boolean;
  featureGrants: AccessRoleFeatureGrant[];
  toolGrants: AccessRoleToolGrant[];
  connectorGrants: AccessRoleConnectorGrant[];
}

// ── WARP-2738: role templates (ADR-032's missing starting points) ──
//
// There is no shared access types package: every type in this block is a HAND
// MIRROR of the server. The source of truth is
// `apps/orchestrator/src/services/access-role-templates.ts` (the catalogue and
// its grant shapes), projected onto the wire by `serializeRoleTemplate` in
// `apps/orchestrator/src/routes/access.ts`. Change either and this block has to
// move with it.
//
// A template is NOT a role and deliberately does not share {@link AccessRole}'s
// shape: it has no database id, no people, no state and no timestamps. It is
// what a card renders from and posts back as `{ templateId }` — the row it
// produces is ordinary and fully editable from the moment it lands, and nothing
// on that row remembers which template made it (provenance lives only in the
// creation Activity's `refs`).

/** The gateable half of the feature vocabulary — the server's
 *  `GateableModuleId`, which is `ModuleId` minus `chat`. Chat is always-on and
 *  a hard 400 on the grant axis, so no template can name it. Derived by
 *  exclusion, so a new module id reaches this type for free. */
export type AccessGateableModuleId = Exclude<AccessModuleId, "chat">;

/** A template's feature grant. Same shape as {@link AccessRoleFeatureGrant},
 *  with `chat` excluded at the type level rather than by convention. */
export interface RoleTemplateFeatureGrant {
  moduleId: AccessGateableModuleId;
  level: FeatureAccessLevel;
}

/**
 * One starting point in the code-resident catalogue
 * (GET /api/access/role-templates).
 *
 * Grants are ADDITIVE FROM ZERO, which is why every axis is enumerated rather
 * than defaulted: a role that carries grants resolves to chat@act plus ONLY its
 * explicit grants — the tier's full catalogue is used exclusively for people on
 * a plain built-in tier. Anything absent here is not held.
 */
export interface RoleTemplate {
  /** Stable kebab-case identifier ("front-desk"), posted back as `templateId`.
   *  Typed as `string`, NOT a union of the eight shipped ids: the catalogue
   *  lives on the box and this app must render whatever it is served, including
   *  a template added after this build shipped. The server owns the vocabulary
   *  and answers 404 for an id it does not know. */
  id: string;
  /** Becomes AccessRole.name. The slug is ALWAYS derived server-side. */
  name: string;
  /** Operator-facing prose (≤ 500 chars) — what the profile is for and, where a
   *  grant is a policy choice rather than a tier limit, that it is one. */
  description: string;
  startingPoint: AccessStartingPoint;
  featureGrants: RoleTemplateFeatureGrant[];
  toolGrants: AccessRoleToolGrant[];
  /** ALWAYS empty. Provider slugs are per-box, so a template naming one this
   *  box has not configured would store dead config that the roles list then
   *  advertises as reach; connector access is added after creating, in the
   *  builder, against the providers actually connected. */
  connectorGrants: AccessRoleConnectorGrant[];
  /** False on every shipped template. */
  cloudModelsAllowed: boolean;
  /** True on exactly one template, and legal there only because that same
   *  payload grants `smart_home` — the server ANDs this away otherwise. */
  mayOperateLocks: boolean;
  /** All three usage caps are null on every template, deliberately: the daily
   *  message cap is stored and rendered but never enforced, so a template
   *  shipping one would advertise a limit the box does not keep. */
  storageQuotaBytes: string | null;
  maxUploadSizeMb: number | null;
  llmDailyMessageCap: number | null;
}

/** GET /api/access/role-templates. Owner/admin only; served with
 *  `Cache-Control: private, max-age=300` (the catalogue is static code, and
 *  identical on every box). */
export interface RoleTemplatesResponse {
  /** In PRESENTATION order — the array order IS the product order. Render as
   *  given; never sort. */
  roleTemplates: RoleTemplate[];
  /**
   * THE HONESTY FIELD, and the reason this is an endpoint rather than a
   * constant bundled into this app. Derived server-side from the layer-2 gate
   * roster (`FEATURE_GATED_MODULES`), which has moved twice already.
   *
   * Treat it as a SET, read from the response — never hardcoded, never sorted
   * into meaning. A feature grant on a module IN this set genuinely narrows what
   * the person reaches: the route answers 404 `module_disabled`. A grant on any
   * module NOT in it is nav-only — the menu entry hides and the API still
   * answers.
   *
   * Copy rule for anything rendered off this: "they will not see it", NEVER
   * "they will be told they lack permission". The denial is byte-identical to
   * the box-wide module toggle, so the person cannot tell the two apart — and
   * neither can this dashboard.
   */
  enforcedModuleIds: AccessModuleId[];
}

/** One per-person exception row (feature axis only in v1 — O-3). */
export interface AccessExceptionInput {
  moduleId: AccessModuleId;
  effect: "allow" | "deny";
  /** Required when effect = allow (service-enforced). */
  level?: FeatureAccessLevel | null;
}

/** GET /api/people/:id/effective-access — the ADR-032 §3 resolver output.
 *  Field names follow the resolver pseudo-code; unknown extras are ignored
 *  by the renderer so a T3 refinement stays non-breaking. */
export interface EffectiveAccess {
  tier: AccessTier;
  features: Array<{ moduleId: AccessModuleId; level: FeatureAccessLevel }>;
  toolDomains: string[];
  locks: boolean;
  cloud: boolean;
  connectors: Record<string, ConnectorAccessLevel>;
  usage: {
    storageQuotaBytes: string | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
    /** Where the effective value came from (T7 "roster shows source"). */
    source?: "person" | "role" | "default";
  };
  /** Read-only reference — ADR-029 owns these; never merged into grants.
   *  `kind` is WARP-1809-additive (optional: an older orchestrator omits it)
   *  — the drawer renders HOUSEHOLD entries kind-keyed as "Workspace" via
   *  `orgUnitDisplayName`, falling back to the raw name when absent. */
  deptRights: Array<{ id: string; name: string; kind?: DepartmentKind; right: DepartmentRight }>;
  exceptions?: Array<AccessExceptionInput & { id?: string }>;
}

/** Mirror of `findInviteByToken` projection used by the public lookup endpoint. */
export interface InvitePublicInfo {
  username: string;
  displayName: string | null;
  /** WARP-1566 — see the note on {@link InviteListItem.role}. */
  role: AccessTier;
  /** WARP-1566 — the custom role this invite grants; null = plain tier. */
  accessRoleId: string | null;
  expiresAt: string;
}

export interface InviteListItem {
  token: string;
  username: string;
  displayName: string | null;
  email: string | null;
  /** WARP-1566 — the server's `UserInvite.role` column is the Prisma `Role`
   *  pgEnum, so this was NEVER the legacy `InviteRole` ("user" | "admin").
   *  The mistyping was load-bearing: the pending-invites row rendered
   *  `role === "admin" ? "admin" : "user"`, which is only exhaustive under
   *  the wrong type, and it silently collapsed Staff, Guest and every
   *  custom-role invite into the single word "user". Typed as the full
   *  tier enum, that ternary no longer type-checks as a complete mapping
   *  and the label has to be resolved properly. */
  role: AccessTier;
  /** WARP-1566 — the custom access role this invite grants, null for a
   *  plain built-in tier. Resolve id → name against the role catalog
   *  (`listAccessRoles`) the same way the roster does; the server sends the
   *  reference, never a denormalised name that could go stale on rename. */
  accessRoleId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface ShareInfo {
  id?: number;
  url: string;
  token: string;
  shareType?: number;
  permissions?: number;
}

// --- Phase 2 share types ---

/** Nextcloud OCS share record as returned by /api/files/share and friends. */
export interface ShareDetail {
  id: number;
  url: string | null;
  token: string | null;
  shareType: number;          // 0=user, 1=group, 3=public link
  permissions: number;        // bitmask: 1=read, 2=update, 4=create, 8=delete, 16=share
  path: string;
  expireDate: string | null;  // "YYYY-MM-DD"
  hasPassword: boolean;
  note: string | null;
  shareWith: string | null;
  shareWithDisplayName: string | null;
  uidOwner: string | null;
  ownerDisplayName: string | null;
  stime: number | null;
}

export interface ShareCreateOptions {
  /** 0=user, 1=group, 3=public link */
  shareType: number;
  permissions?: number;
  expireDate?: string;
  password?: string;
  note?: string;
  shareWith?: string;
}

export interface ShareUpdateOptions {
  permissions?: number;
  password?: string;
  expireDate?: string;
  note?: string;
}

/**
 * WARP-879 / WS-1 — a household member the internal-sharing picker can
 * target. Returned by GET /api/files/share-recipients. `shareWith` is the
 * member's Nextcloud user id (the OCS shareWith value for a shareType:0
 * named-member share); `email` is null when the member has none on file.
 */
export interface ShareRecipient {
  shareWith: string;
  displayName: string;
  email: string | null;
}

// --- Storage types ---

/** The four-scalar storage shape (GET /api/storage). WARP-2098: the top-level
 *  quadruple is now the box's DATA drives — the OS/boot disk excluded — and the
 *  same shape appears again under `cloud` for the Nextcloud account quota that
 *  the top level used to carry. */
export interface StorageStats {
  used: number;       // bytes
  total: number;      // bytes
  available: number;  // bytes
  percentage: number; // 0-100
}

/** GET /api/storage. The headline quadruple describes the data drives; the
 *  install disk and the Nextcloud quota are reported alongside it rather than
 *  mixed into it. */
export interface StorageOverview extends StorageStats {
  /** Provenance for the quadruple above; null when the device-bridge said
   *  nothing (unreachable, or no data drives). */
  totals: DataStorageTotals | null;
  /** The box's own install disk. Absent when the bridge doesn't report it. */
  system_disk?: SystemDiskInfo;
  /** The signed-in user's Nextcloud account quota — a cloud-account figure,
   *  NOT a description of the box's disks. null when it can't be read. */
  cloud: StorageStats | null;
}

export interface DriveInfo {
  device: string;
  /** WARP-827: whole-disk kernel name backing `device` (e.g. "sda",
   *  "nvme0n1"), set by the device-bridge. Lets the UI group the partitions of
   *  one physical disk together and act on the whole disk (reclaim/pool wipe the
   *  disk, not a single partition). Absent on an older bridge — callers derive
   *  it from `device` instead. */
  parent_disk?: string;
  mount: string;
  /** FS-provided label from the bridge (e.g. "TOSHIBA EXT") — different
   *  from the customer-chosen displayName below. */
  label: string;
  uuid: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  mounted: boolean;
  /** WARP-612: read-only enrichment from the device-bridge. `bus`
   *  (nvme/usb/mmc/disk) is always present — the orchestrator derives it as a
   *  fallback; `fs` + `readonly` are best-effort and may be absent on an
   *  older bridge. */
  bus?: string;
  fs?: string;
  readonly?: boolean;
  /** WARP-612: SMART health ("PASSED"/"FAILED") + temperature °C. Present only
   *  when the bridge has DRIVE_SMART_ENABLED and smartctl can read the device;
   *  the UI hides the chips when absent. */
  smart?: string | null;
  temp_c?: number | null;
  /** WARP-612: hot-plug auto-mounted (ejectable) vs installed storage —
   *  bus-agnostic (ADR-011). The Eject action is gated on this, not on bus. */
  removable?: boolean;
  /** WARP-174: customer's friendly name from the setup wizard's Storage
   *  step. `null` until a Drive row is upserted via
   *  PATCH /api/storage/drives/:uuid. */
  displayName?: string | null;
  icon?: string | null;
  notes?: string | null;
  /** WARP-1339: bare md array name (e.g. "md127" — PoolInfo.device's exact
   *  join key) when this mounted filesystem lives on an md node or a
   *  partition of one; `null` for a standalone drive. The panels merge a
   *  pool-backed drive INTO its pool's card/tile instead of rendering it as
   *  an anonymous GUID drive. Absent on an older orchestrator — callers fall
   *  back to the anchored md-device matcher (drivePoolName). */
  pool?: string | null;
}

/** WARP-174: response shape for PATCH /api/storage/drives/:uuid. */
export interface DriveLabel {
  uuid: string;
  displayName: string;
  icon: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** WARP-936: explicit whole-disk state from the device-bridge's lsblk walk.
 *  The UI branches on this enum — never on a guess or a mount-gated omission:
 *    in_use      — the disk, a partition, or an md it backs is mounted
 *    pool_member — carries a RAID-member signature (`md` names the array)
 *    foreign     — has data from another system, nothing mounted
 *    available   — no filesystem signature at all */
export type DiskState = "in_use" | "pool_member" | "foreign" | "available";

/** WARP-936: one WHOLE physical disk (including present-but-unmounted ones
 *  the mounted `drives` list is blind to). Read-only inventory — every
 *  destructive action stays behind the tier-3 confirm-token flow. */
export interface DiskInfo {
  /** Whole-disk kernel name, e.g. "sda" / "nvme0n1". */
  name: string;
  size_bytes: number;
  state: DiskState;
  fstype?: string;
  bus?: string;
  model?: string;
  serial?: string;
  /** md array name (e.g. "md127") when state is pool_member. */
  md?: string;
}

/** WARP-2098: the appliance's OWN system/install disk — the disk the Droplet
 *  boots from, runs its software on, and (because the docker data-root lives
 *  there) stores uploaded files on.
 *
 *  Deliberately NOT a `DriveInfo` and NOT a member of `drives`/`disks`. Those
 *  arrays feed the rename/eject/browse cards, the setup wizard's poolable and
 *  reclaimable lists, and the Settings reformat picker; the system disk must
 *  never appear in any of them (WARP-827 keeps it out, and that stays). A
 *  distinct type is the guardrail: nothing that iterates drives can pick this
 *  up by accident, and passing it where a DriveInfo is expected won't compile. */
export interface SystemDiskInfo {
  /** Whole-disk kernel name, e.g. "nvme0n1". */
  name: string;
  /** The PHYSICAL disk. `used_bytes` sums `filesystems`, so unallocated LVM
   *  extents count as free rather than disappearing. */
  size_bytes: number;
  /** null whenever the bridge could not publish an honest total — see
   *  `measurement` for which case. Render the capacity with no meter; 0 would
   *  claim an empty disk. */
  used_bytes: number | null;
  free_bytes: number | null;
  /** Why the pair above is or is not a number — the bridge's explicit state,
   *  never re-derived from the nulls (a "partial" and an "unavailable" disk
   *  both carry null, and the owner should be told which).
   *    complete    — every filesystem measured; the pair is real.
   *    partial     — some measured (listed in `filesystems`), not all; a
   *                  total would undercount, so the pair is null.
   *    unavailable — nothing measurable; the pair is null and `filesystems`
   *                  is empty. */
  measurement: "complete" | "partial" | "unavailable";
  model: string;
  serial: string;
  bus: string;
  /** Every mounted filesystem on the disk, one per backing device. `role` is
   *  assigned server-side so no surface pattern-matches host paths. */
  filesystems: SystemDiskFilesystem[];
}

export interface SystemDiskFilesystem {
  mount: string;
  role: "root" | "boot" | "data";
  fs: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
}

/** WARP-2098: the box's real data-storage figure — summed over the SAME
 *  post-filter `drives` array the response carries, so the OS disk is excluded
 *  by construction and a pool contributes its one mounted filesystem rather
 *  than its raw members.
 *
 *  Never label this pool capacity. ADR-019 deleted a client-side "Total pooled
 *  storage" byte-sum precisely because it described no disk that existed, and
 *  drives-panel.pools.test.tsx still guards the phrase. */
export interface DataStorageTotals {
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  drive_count: number;
  source: "data_drives";
}

export interface DrivesResponse {
  drives: DriveInfo[];
  count: number;
  /** WARP-2098: totals over the returned data drives. `null` means "there is
   *  nothing to total" (no data drives, or the bridge is unreachable) — render
   *  the empty state, never a 0 B meter. ABSENT means an older orchestrator
   *  that predates the field, which callers treat the same way. */
  totals?: DataStorageTotals | null;
  /** WARP-936: whole-disk inventory. Absent on an older orchestrator/bridge —
   *  callers treat that as an empty list. */
  disks?: DiskInfo[];
  /** WARP-2098: the box's own install disk. Absent on an older bridge, or when
   *  the bridge could not identify the disk — the UI then omits the System
   *  drive card entirely rather than rendering an empty one. */
  system_disk?: SystemDiskInfo;
  snapshot_at?: string;
  error?: string;
  reason?: string;
}

/** BUG-3 / ADR-019: one mdadm software-RAID pool as the bridge reports it,
 *  joined with the owner's chosen displayName / notes. `status` / `level` are
 *  the explicit ADR-019 enum values (never raw mdstat). */
export interface PoolInfo {
  /** md device name without /dev/ (e.g. "md0"). */
  device: string;
  level: "raid0" | "raid1" | "raid5" | "raid6" | "raid10" | "jbod";
  status: "active" | "degraded" | "resyncing" | "failed" | "none";
  members: string[];
  /** Owner-chosen name from the StoragePool row; null until set. */
  displayName?: string | null;
  notes?: string | null;
}

export interface PoolsResponse {
  pools: PoolInfo[];
  count: number;
  snapshot_at?: string;
  error?: string;
  reason?: string;
}

/** PR #373 — one subsystem descriptor in the onboarding Claim hardware card. */
export interface ApplianceSpec {
  label: string;
  value: string;
  online: boolean;
}

/** PR #373 — GET /api/setup/appliance. The read-only hardware contract the
 *  Claim wizard step renders (a DOCUMENTED STUB on the backend; see
 *  docs/ONBOARDING_CLAIM.md). */
export interface ApplianceContract {
  appliance_id: string;
  compute: ApplianceSpec;
  storage: ApplianceSpec;
  network: ApplianceSpec;
  display: ApplianceSpec;
  supply_chain: {
    taa_compliant: boolean;
    ndaa_889_clear: boolean;
    summary: string;
  };
}

/** PR #373 — POST /api/setup/claim result. */
export interface ClaimResult {
  claimed: boolean;
  /** True when the box was already bound (idempotent re-run short-circuit). */
  already_claimed?: boolean;
  /** The wizard step to advance to after a successful claim. */
  next_step: string;
}

/** PR #380 — the onboarding ORG step form values. `industry`/`size` are LOCAL
 *  smart-default hints only — never sent off the box (FEATURES §10). The
 *  orchestrator still records them to pick local defaults. */
export interface OrgInput {
  name: string;
  slug: string;
  tz: string;
  industry?: string;
  size?: string;
  /** On-NVMe logo path (optional). */
  logo?: string;
}

/** PR #380 — POST /api/setup/org result. */
export interface OrgResult {
  ok: boolean;
  /** The normalized, reserved slug. */
  slug: string;
  /** The reserved `droplet.local/<slug>` host. */
  reserved_host: string;
  /** The wizard step to advance to after a successful persist (`internet`). */
  next_step: string;
}

/** PR #381 — the roles the onboarding TEAM step can assign. The SHIPPED
 *  HOUSEHOLD model (mirrors the orchestrator Role enum minus `service`). */
export type TeamInviteRole = "owner" | "admin" | "family" | "guest";

/** PR #381 — onboarding TEAM-invite request body. The wizard invites by
 *  email + role; the orchestrator normalizes the email + validates the role. */
export interface TeamInviteRequest {
  email: string;
  role: TeamInviteRole;
}

/** PR #381 — POST /api/people/invite result. */
export interface TeamInviteResult {
  ok: boolean;
  /** The single-use invite token (bearer credential — not displayed). */
  token: string;
  /** The normalized (lowercased) invitee email. */
  email: string;
  /** The role the invite assigns. */
  role: TeamInviteRole;
  /** ISO timestamp the invite expires. */
  expires_at: string;
}

// --- Health types ---

export interface HealthResponse {
  status: "ok" | "degraded";
  uptime: number;
  version: string;
  /**
   * WARP-1926 — the local inference runtime this box serves from: `dmr`
   * (Docker Model Runner, the shipped default since WARP-1870) or `ollama`.
   * Optional because a box running an orchestrator older than WARP-1926 does
   * not send it; `inferenceRuntimeLabel` renders a generic truth in that case
   * rather than guessing a daemon name.
   */
  inferenceRuntime?: "dmr" | "ollama";
  services: {
    db: boolean;
    redis: boolean;
    aiGateway: boolean;
    matter: boolean;
    router: boolean;
    frigate: boolean;
    switch: boolean;
    // Status display screen (services/oled-display). `true` when the
    // service is up — stays true in simulated mode too (no physical
    // device); /display/status surfaces the backend if needed.
    display: boolean;
    // WARP-3052 — file service (Nextcloud) reachability. Informational: it
    // never affects `status`. Optional: older boxes don't send it.
    nextcloud?: boolean;
  };
}

// --- Matter / Smart Home types ---

export type SmartHomeCategory =
  | "light"
  | "switch"
  | "sensor"
  | "binary_sensor"
  | "climate"
  | "media_player"
  | "cover"
  | "fan"
  | "lock"
  | "camera"
  | "vacuum";

export interface MatterDevice {
  nodeId: string;
  name: string;
  category: SmartHomeCategory;
  state: string;
  connectionState: "connected" | "disconnected" | "reconnecting" | "waiting";
  vendorName?: string;
  vendorId?: number;
  productName?: string;
  productId?: number;
  serialNumber?: string;
  endpoints: MatterEndpointInfo[];
  attributes: Record<string, unknown>;
  /** WARP-1396 — Droplet-local household identity overlaid by the orchestrator.
   *  `name` stays the Matter product name; these are the alias + room. */
  friendlyName?: string | null;
  roomId?: string | null;
  roomName?: string | null;
}

/** WARP-1396 — a household room (Droplet-local). */
export interface Room {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
  deviceCount: number;
}

export interface MatterEndpointInfo {
  endpointId: number;
  deviceTypes: Array<{ deviceType: number; revision: number }>;
  clusters: number[];
}

export interface MatterGrouped {
  lights: MatterDevice[];
  switches: MatterDevice[];
  sensors: MatterDevice[];
  climate: MatterDevice[];
  media: MatterDevice[];
  covers: MatterDevice[];
  locks: MatterDevice[];
  other: MatterDevice[];
}

export interface MatterDiscoveredDevice {
  deviceIdentifier: string;
  discriminator: number;
  vendorId?: number;
  productId?: number;
  deviceName?: string;
  deviceType?: number;
  commissioningMode: number;
  /**
   * Mirror of `services/matter-controller/src/types.ts`. `type` is the
   * transport label — "udp" | "tcp" | "ble" | "ip" — always a non-empty
   * string. "ip" appears from matter.js 0.17 onward for a transport-agnostic
   * DNS-SD record; treat anything other than "ble" as an IP address.
   * `peripheralAddress` is present only on BLE records (no ip/port).
   */
  addresses: Array<{
    ip: string;
    port: number;
    type: string;
    peripheralAddress?: string;
  }>;
}

/**
 * WARP-851: controller capability surface (GET /api/matter/capabilities).
 * `bleCommissioning: false` means devices that need Bluetooth for
 * first-time setup cannot be paired on this box yet (see WARP-850).
 */
export interface MatterCapabilities {
  bleCommissioning: boolean;
  /**
   * WARP-1035: whether the box can hand a BLE-first device the Droplet
   * AP's Wi-Fi credentials during commissioning (WARP-895). Optional —
   * an orchestrator predating WARP-1035 omits it; treat absent as false
   * (don't promise on a guess).
   */
  wifiProvisioning?: boolean;
  /**
   * WARP-1035: the Droplet AP's SSID, for naming the network new
   * devices join in pre-flight copy. Null/absent when unset or unknown.
   */
  apSsid?: string | null;
}

/**
 * KAN-5: the result of issuing a Matter device command.
 *
 * The orchestrator answers a Tier-2 write (a lock/unlock, or a climate
 * setpoint >= 30C) with HTTP 202 `{ status: "confirmation_required", … }`
 * rather than executing it. Callers MUST branch on `status` and, for the
 * confirmation path, surface a confirm affordance and then echo
 * `confirmationToken` + `service` back to POST /confirm — dropping the body
 * (the pre-KAN-5 behavior) makes every Tier-2 command a silent no-op.
 */
export type MatterCommandResult =
  | { status: "ok" }
  | {
      status: "confirmation_required";
      nodeId: string;
      /** Single-use token minted by the 202; echoed back to /confirm. */
      confirmationToken: string;
      /** The service the /confirm route validates against — echo verbatim. */
      service: string;
      /** Plain-English why-we're-asking sentence from the safety tier. */
      reason: string;
      /** Always 2 for a confirmation_required command; carried for the chip. */
      tier: number;
    };

// --- Camera / Frigate types ---

export interface CameraInfo {
  name: string;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  ipAddress: string;
  macAddress: string | null;
  enabled: boolean;
  autoDiscovered: boolean;
  /**
   * ⚠ `recording` means footage is being KEPT, not merely that frames are
   * arriving. `live` is the state that used to be mislabelled "recording":
   * a healthy stream whose retention windows are all zero, so there will be
   * nothing to scrub back to (WARP-1974).
   */
  status: "recording" | "detecting" | "live" | "idle" | "offline";
  lastSeen: string;
  lastDetection: DetectionEvent | null;
}

export interface DetectionEvent {
  id: string;
  camera: string;
  label: string;
  score: number;
  startTime: number;
  endTime: number | null;
  thumbnail: string;
  hasClip: boolean;
  hasSnapshot: boolean;
}

/** Richer event payload returned by GET /api/cameras/events for the
 *  dedicated Events page. Mirrors EventDetail in the orchestrator. */
export interface EventDetail extends DetectionEvent {
  subLabel: string | null;
  subLabelScore: number | null;
  zones: string[];
  retainIndefinitely: boolean;
  /** Authenticated proxy URL for the .mp4 clip; null if has_clip=false. */
  clipUrl: string | null;
  /** Authenticated proxy URL for the saved snapshot; null if has_snapshot=false. */
  snapshotUrl: string | null;
  /** Frigate-genai natural-language description; null when feature
   *  is off or generation hasn't happened yet. */
  description: string | null;
}

/** Filter shape for the Events page UI — mirrored 1:1 onto the
 *  /api/cameras/events query string by `fetchEvents`. All fields
 *  optional; the rail starts empty (= "anything"). */
export interface EventFilter {
  cameras?: string[];
  labels?: string[];
  /** [0, 1] */
  minScore?: number;
  /** Unix-seconds upper bound (exclusive). Used as the cursor. */
  before?: number;
  /** Unix-seconds lower bound (inclusive). Used by the "since" preset. */
  after?: number;
  hasClip?: boolean;
  hasSnapshot?: boolean;
  /** Page size, [1, 200]. Defaults to 50 server-side. */
  limit?: number;
}

export interface FilteredEventsResult {
  events: EventDetail[];
  /** start_time of the oldest event returned, or null if no more pages. */
  nextCursor: number | null;
}

// --- Reviews (Frigate 0.13+) ---

export type ReviewSeverity = "alert" | "detection" | "significant_motion";

/**
 * A Frigate review item — a cluster of sequential events on the same
 * camera, classified by severity. Reviews are the operator's primary
 * triage unit on the Events page's "Alerts" + "Detections" tabs.
 */
export interface ReviewItem {
  id: string;
  camera: string;
  startTime: number;
  endTime: number | null;
  severity: ReviewSeverity;
  hasBeenReviewed: boolean;
  objects: string[];
  audio: string[];
  zones: string[];
  detectionIds: string[];
  previewUrl: string | null;
  thumbnailUrl: string;
}

export interface ReviewFilter {
  cameras?: string[];
  severity?: ReviewSeverity[];
  before?: number;
  after?: number;
  /** When set, only reviewed (true) or unreviewed (false) items. */
  reviewed?: boolean;
  limit?: number;
}

export interface FilteredReviewsResult {
  reviews: ReviewItem[];
  nextCursor: number | null;
}

// --- Recordings + timeline (Phase 3) ---

export interface RecordingHour {
  hour: number;
  events: number;
  /** Seconds of footage retained for this hour, 0–3600. This — not
   *  `motion` — is what says there is something to play. */
  duration: number;
  motion: number;
  objects: number;
}

export interface RecordingDay {
  day: string;
  events: number;
  duration: number;
  hours: RecordingHour[];
}

export interface RecordingSegment {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  motion: number;
  objects: number;
}

export interface TimelineEntry {
  timestamp: number;
  sourceId: string;
  classType: string;
  label: string;
  zone: string | null;
  score: number;
}

// --- Per-camera settings (Phase 4.1) ---

export interface ObjectFilter {
  threshold: number;
  minScore: number;
}

/** Frigate zone in the dashboard's structured shape. Coordinates are
 *  flat normalised [x1, y1, x2, y2, …] in [0, 1] image space. */
export interface CameraZone {
  name: string;
  coordinates: number[];
  objects: string[];
  inertia: number;
}

/** A single motion-mask polygon. Same coord convention as zones. */
export interface MotionMaskPolygon {
  coordinates: number[];
}

// --- Face recognition + LPR (Phase 7.5/7.6) ---

export interface FaceImage {
  name: string;
  imageUrl: string;
}

export interface KnownFace {
  name: string;
  images: FaceImage[];
}

export interface KnownPlate {
  plate: string;
  name: string | null;
  eventCount: number;
}

// --- Notification preferences (Phase 6.3) ---
//
// Per-camera + per-user notification toggles. The orchestrator
// returns the literal { onPerson, onVehicle, onAnimal, onMotion }
// flags from the CameraNotificationPref table; the global page
// aggregates these across cameras.

export interface NotificationPrefs {
  onPerson: boolean;
  onVehicle: boolean;
  onAnimal: boolean;
  onMotion: boolean;
}

// --- PTZ (Phase 6.1) ---

export type PtzAction =
  | "MOVE_UP"
  | "MOVE_DOWN"
  | "MOVE_LEFT"
  | "MOVE_RIGHT"
  | "ZOOM_IN"
  | "ZOOM_OUT"
  | "STOP";

export interface PtzCapabilities {
  supportsPanTilt: boolean;
  supportsZoom: boolean;
  presets: string[];
}

// --- Camera system status (Phase 5) ---

export interface DetectorStat {
  name: string;
  inferenceSpeedMs: number;
  pid: number | null;
}

export interface GpuStat {
  name: string;
  gpuPct: number;
  memPct: number | null;
  tempC: number | null;
}

export type StorageRole = "recordings" | "cache" | "shm" | "other";

export interface StorageStat {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  mountType: string;
  /** What this volume is for. Only `recordings` answers "how much room
   *  does my footage have"; summing across roles describes no real disk. */
  role: StorageRole;
  /** Set when another entry reports the same filesystem (Frigate lists
   *  `recordings` and `clips` separately though they are one volume).
   *  Anything that aggregates must skip these. */
  duplicateOf: string | null;
}

/**
 * WARP-1850 — per-camera NVR storage. `null` is load-bearing throughout:
 * it means "not known", which the UI must render differently from zero.
 */
export interface CameraStorageRow {
  camera: string;
  /** Bytes used, or null when Frigate has no segments for this camera yet. */
  usedBytes: number | null;
  /** Measured bytes/hour, or null when not yet measured. */
  bytesPerHour: number | null;
  /** Share of the recordings volume, 0–100, or null if uncomputable. */
  sharePercent: number | null;
  /** Days of footage the current usage represents at the measured rate. */
  daysAtCurrentRate: number | null;
}

/** WARP-1851 — retention windows the budget controller manages, in days. */
export interface RetentionWindows {
  continuous: number;
  motion: number;
  alerts: number;
  detections: number;
}

/** WARP-1851 — a camera's current storage allocation. */
export interface CameraBudget {
  retentionMode: "MANUAL" | "BUDGET";
  budgetBytes: number | null;
  /** The operator's preferred windows; the controller scales down from here
   *  and never raises a window stored as 0. */
  retentionCeiling: RetentionWindows | null;
  /** Windows written by the immediate reconcile, when one was applied. */
  applied?: RetentionWindows | null;
  /** Operator-facing note — present when there's something to say. */
  note?: string;
}

export interface CameraStorageSummary {
  volume: {
    path: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  cameras: CameraStorageRow[];
  nearFull: boolean;
  /**
   * True when footage is landing on the BOOT DISK instead of the dedicated
   * recordings drive — the `${NVR_MEDIA_SOURCE:-nvrdata}` mount fell back
   * to a named volume on the system disk. `null` = can't tell.
   */
  recordingsOnBootDisk: boolean | null;
  totalBytesPerHour: number | null;
}

export interface CameraSystemStatus {
  version: string;
  uptimeSec: number;
  cameraCount: number;
  camerasLive: number;
  cameraFps: Array<{
    name: string;
    cameraFps: number;
    detectionFps: number;
    skippedFps: number;
  }>;
  detectors: DetectorStat[];
  gpus: GpuStat[];
  storage: StorageStat[];
  cpuPct: number;
}

export interface CameraSettings {
  detectEnabled: boolean;
  detectFps: number;
  trackedLabels: string[];
  objectFilters: Record<string, ObjectFilter>;
  recordEnabled: boolean;
  /** WARP-1849 — the four retention windows Frigate 0.17 enforces. The
   *  old single `recordRetainDays` wrote `record.retain`, a key 0.17
   *  rejects outright, which failed the whole save. */
  continuousRetainDays: number;
  motionRetainDays: number;
  alertsRetainDays: number;
  detectionsRetainDays: number;
  snapshotsEnabled: boolean;
  snapshotRetainDays: number;
  zones: CameraZone[];
  motionMasks: MotionMaskPolygon[];
}

export interface CameraSettingsPatch {
  detectEnabled?: boolean;
  detectFps?: number;
  trackedLabels?: string[];
  objectFilters?: Record<string, Partial<ObjectFilter>>;
  recordEnabled?: boolean;
  continuousRetainDays?: number;
  motionRetainDays?: number;
  alertsRetainDays?: number;
  detectionsRetainDays?: number;
  snapshotsEnabled?: boolean;
  snapshotRetainDays?: number;
  zones?: CameraZone[];
  motionMasks?: MotionMaskPolygon[];
}

/**
 * How far along a camera found on the network is toward being usable (WARP-1847).
 *  - `ready`             — a stream we can reach; adding it should just work.
 *  - `needs_credentials` — it's a camera, but the stream wants a username /
 *                          password or a vendor-specific RTSP path.
 *  - `unverified`        — something answered on a camera port, nothing has
 *                          confirmed a stream yet.
 */
export type CameraCandidateStatus = "ready" | "needs_credentials" | "unverified";

export interface DiscoveredCamera {
  /** `mac:<MAC>` for a live discovery record, a uuid for a database row. */
  id: string;
  name: string;
  ip: string;
  mac: string | null;
  manufacturer: string | null;
  model: string | null;
  discoveredAt: string | null;
  /** Absent on older payloads — treat a missing status as `unverified`. */
  status?: CameraCandidateStatus;
  displayName?: string;
  /** RTSP URL with credentials already stripped server-side; never a password. */
  rtspUrl?: string | null;
  /** True when discovery holds working credentials for the stream. */
  hasCredentials?: boolean;
  detectionMethod?: string | null;
  source?: "live" | "database";
}

export interface CameraCandidateList {
  cameras: DiscoveredCamera[];
  /**
   * False when the camera-discovery service couldn't be reached — the
   * difference between "nothing is on your network" and "nothing is looking".
   */
  discoveryOnline: boolean;
}

export interface CameraScanResult extends CameraCandidateList {
  status: string;
  known?: number;
  pending?: number;
  message?: string;
}

// --- Camera groups ---

export interface CameraGroupMember {
  /** Frigate-key for the camera; matches CameraInfo.name. */
  cameraName: string;
  cameraDisplayName: string;
  sortOrder: number;
}

export interface CameraGroupInfo {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  members: CameraGroupMember[];
  createdAt: string;
  updatedAt: string;
}

// --- Camera pins (per-user prefs; not shared across operators) ---

/**
 * Per-user "pinned" camera. Operators pin the cameras they actually
 * watch so they float to the top of the grid above the alphabetical
 * default order. Pins are keyed on Frigate camera NAME — not a Camera
 * FK — because they're a low-stakes pref. Dangling pins (camera was
 * removed) are filtered on the dashboard before render.
 */
export interface CameraPinInfo {
  cameraName: string;
  /** Lower sortOrder renders first. Negative numbers are normal — newly
   *  pinned cameras get `min - 1` so they jump above existing pins. */
  sortOrder: number;
  createdAt: string;
}

export interface CameraSSEEvent {
  /**
   * `detection`        — a NEW event accepted by the per-camera gate;
   *                      toast + SWR revalidation.
   * `detection_update` — live confidence update for the active event;
   *                      cameras page only, toast MUST ignore.
   * `detection_end`    — recording window closed; refresh events list,
   *                      no toast.
   * Mirrors `apps/orchestrator/src/types/camera.ts`.
   */
  type:
    | "connected"
    | "detection"
    | "detection_update"
    | "detection_end"
    | "camera_discovered"
    | "camera_online"
    | "camera_offline";
  camera?: string;
  label?: string;
  score?: number;
  thumbnail?: string;
  eventId?: string;
  timestamp?: number;
}

// --- Network / Router types ---

export interface InterfaceStatus {
  up: boolean;
  /** Whether this interface is configured on this box. `false` = absent on this
   *  hardware shape (e.g. no `wan` on a single-box), distinct from a configured
   *  interface that is currently down (`present: true, up: false`). */
  present?: boolean;
  pending?: boolean;
  available?: boolean;
  autostart?: boolean;
  device?: string;
  proto?: string;
  uptime?: number;
  l3_device?: string;
  "ipv4-address"?: { address: string; mask: number }[];
  "ipv6-address"?: { address: string; mask: number }[];
  route?: unknown[];
  "dns-server"?: string[];
  data?: Record<string, unknown>;
}

export interface NetworkOverview {
  interfaces: {
    lan: InterfaceStatus;
    wan: InterfaceStatus;
  };
  wireless: Record<string, unknown>;
  system: {
    board: {
      kernel?: string;
      hostname?: string;
      system?: string;
      model?: string;
      board_name?: string;
      release?: { distribution?: string; version?: string; target?: string };
    };
    resources: {
      uptime?: number;
      localtime?: number;
      load?: number[];
      memory?: { total: number; free: number; shared: number; buffered: number };
      swap?: { total: number; free: number };
    };
  };
  connectedDeviceCount: number;
  routerConnected: boolean;
  /**
   * Whole-fabric radio rollup — mirrors the orchestrator's
   * `WirelessRadioSummary` (apps/orchestrator/src/types/network.ts).
   *
   * Read this, NOT `wireless`, for anything that counts radios or decides
   * whether Wi-Fi is up. `wireless` above is the router's own netifd status
   * and nothing else, so it is `{}` on every shape where the household SSID
   * is broadcast by the access point rather than the router — which is the
   * shipping fabric, and is how the Overview tile came to report "0 radio(s)"
   * over a live two-radio network.
   *
   * Optional: an orchestrator that predates the rollup omits it, and absent
   * means UNKNOWN, not zero.
   */
  wirelessRadios?: WirelessRadioSummary;
}

/** Counts only — no SSID or passphrase crosses this boundary. */
export interface WirelessRadioSummary {
  /** Radios the router itself hosts. Zero on every edge-router shape. */
  router: number;
  /** Radios reported by online Droplet access points. */
  ap: number;
  /** `router + ap`. */
  total: number;
  /** Of `total`, how many are actually broadcasting. */
  active: number;
  /** Online APs that didn't answer — `total` is then a floor, not a census. */
  apsNotReporting: number;
}

export interface ConnectedDevice {
  hostname: string;
  ipaddr: string;
  macaddr: string;
  expire: number;
  isWireless: boolean;
  signal?: number;
  rxRate?: number;
  txRate?: number;
}

/**
 * WARP-1714 — GET /api/network/wifi/current. `source: null` means we could not
 * read the Wi-Fi (and `detail` says why), which is deliberately distinct from
 * a successfully-read network that happens to have no PSK.
 */
export interface CurrentWifi {
  ssid: string | null;
  key: string | null;
  source: "router" | "ap" | null;
  detail: string;
  section: string | null;
  radio: string | null;
}

export interface WirelessScanResult {
  ssid: string;
  bssid: string;
  channel: number;
  signal: number;
  quality: number;
  quality_max: number;
  encryption: {
    enabled: boolean;
    wpa?: number[];
    authentication?: string[];
  };
}

// WARP-42: mirror the routing service's wire shape (services/routing/schemas.py).
// Fields are optional because OpenWrt omits defaults; index signatures let
// the UI read extras like `.anonymous`, `.type`, etc. without compile errors.

export interface FirewallZone {
  name?: string;
  network?: string | string[];
  input?: string;
  output?: string;
  forward?: string;
  masq?: string;
  [key: string]: unknown;
}

export interface FirewallRule {
  name?: string;
  src?: string;
  dest?: string;
  src_mac?: string;
  proto?: string | string[];
  src_port?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

export interface FirewallRedirect {
  name?: string;
  src?: string;
  dest?: string;
  proto?: string | string[];
  src_dport?: string;
  dest_ip?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

export interface FirewallCollection<T> {
  values: Record<string, T>;
}

export interface FirewallConfig {
  zones: FirewallCollection<FirewallZone>;
  rules: FirewallCollection<FirewallRule>;
  redirects: FirewallCollection<FirewallRedirect>;
}

export interface NetworkCommandResult {
  status: string;
  tier?: number;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  reason?: string;
  expiresIn?: number;
  operation?: string;
  // WARP-871: Tier-1 writes (channel, static lease) answer 200 with the
  // operationId directly so the caller can poll /operations/:id for the
  // safe-apply outcome without a confirmation round-trip.
  /** WARP-40: present on a directly-applied (non-confirm) write so the caller
   *  can poll /network/operations/:id for the apply-vs-rollback outcome. */
  operationId?: string | null;
}

// --- WARP-83: enriched device types for the card-grid view ---

export interface DevicePresenceDay {
  date: string;
  seenMinutes: number;
}

export interface DeviceGroupRef {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface EnrichedNetworkDevice {
  mac: string;
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: string;
  lastSeen: string;
  // WARP-106: `isBlocked` is a COMPUTED display flag from the API —
  // `lastAppliedBlocked ?? manualBlock`. `manualBlock` (user intent) and
  // `lastAppliedBlocked` (ticker-authored source of truth) are the authored
  // fields the API now also returns.
  isBlocked: boolean;
  manualBlock: boolean;
  lastAppliedBlocked?: boolean | null;
  online: boolean;
  signal?: number;
  groups: DeviceGroupRef[];
  presenceDays?: DevicePresenceDay[];
  // WARP-1715: the coverage APs are part of the household network, not a
  // separate silo. `isAccessPoint` marks a row that IS an approved AP (so it
  // renders as named infrastructure rather than an anonymous DHCP lease);
  // `viaAp` names the AP a station joined through, null on the router's own
  // radio. Before this join, every device on an AP's Wi-Fi read as wired.
  isAccessPoint?: boolean;
  apModel?: string | null;
  viaAp?: string | null;
}

export interface DeviceGroupWithCount extends DeviceGroupRef {
  _count: { devices: number };
}

// --- WARP-95: schedule types ---

export interface ScheduleWindow {
  id: string;
  /** Day-of-week bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64. */
  daysOfWeek: number;
  /** Start minute-of-day, [0, 1440). */
  startMin: number;
  /** End minute-of-day, [0, 1440). If endMin <= startMin, window wraps past midnight. */
  endMin: number;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  windows: ScheduleWindow[];
  lastFiredAt?: string;
  nextTransitionAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleOverride {
  id: string;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  action: "allow" | "block";
  startAt: string;
  endAt: string;
  note?: string;
  createdAt: string;
}

export interface ScheduleEvent {
  id: string;
  scheduleId?: string;
  overrideId?: string;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  transition: "blocked" | "unblocked";
  reason: string;
  occurredAt: string;
}

// WARP-555 — read-only tool capability catalog (`/tools` surface).
// Mirrors the `GET /api/llm/tools/catalog` wire shape, which is derived
// from `@droplet/tools-core`'s TOOL_CATALOG. `domain` is one of the
// orchestrator's declared tool domains; it arrives as a string so the
// dashboard never has to stay in lockstep with the registry's union.
/**
 * WARP-2969 — whether a chat turn can reach this tool at all.
 *
 * `excluded` is the chat-scope policy list (`EXCLUDED_FROM_CHAT_TOOLS`),
 * which withholds a tool from ASKING while leaving it callable from its own
 * screen or by an MCP client. It is "not by asking", never "unavailable".
 *
 * ONE AXIS. A `module` axis was cut before it shipped: §6 module gating is
 * not applied to the chat pool for an owner or anybody holding no AccessRole,
 * so a "Module off" chip would have been a confident false statement on every
 * shipped box. WARP-2972 wires that gate; the axis returns here after it.
 *
 * The per-person axes (role grants, off-LAN withholding, turn relevance) need
 * a resolved principal and a modelled turn, and live on `/admin/prompt`'s
 * inspector instead.
 */
export interface ToolReach {
  chat: "allowed" | "excluded";
}

export interface ToolCatalogEntry {
  name: string;
  /** Agent-facing description from the registry (may contain jargon). */
  description: string;
  /** Plain-language, home-user-facing copy — what `/tools` renders (ADR-002). */
  homeDescription: string;
  domain: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  /**
   * WARP-2969. Optional because the field is additive and an orchestrator
   * from before it shipped answers without one — absence means "no evidence
   * this is withheld", which is the pre-WARP-2969 behaviour, not "withheld".
   * Read it through `reachableInChat` / `reachNote` (lib/tool-domains), never
   * by hand, so both surfaces agree on what absence means.
   */
  reach?: ToolReach;
}

// ── WARP-2823: the admin console's prompt + tool inspector ────────────────
//
// Mirrors the orchestrator's `tool-inspect.service.ts` / `prompt-inspect.service.ts`
// response shapes. Deliberately structural rather than a re-derivation: the
// dashboard renders these fields and never re-decides any of them.

/** The gates a chat turn applies, in the order it applies them. */
export type InspectGate =
  | "write_tier"
  | "role_grant"
  | "interview_strip"
  | "off_lan_withhold"
  | "chat_policy"
  | "turn_relevance";

/** Why an identity could not be established. */
export type AttributionFailure =
  | "no_principal"
  | "user_missing"
  | "user_deactivated"
  | "read_failed";

export interface ToolInspectRow {
  name: string;
  domain: string;
  homeDescription: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  advertised: boolean;
  /** The FIRST gate that withheld it. Null when advertised. */
  gate: InspectGate | null;
  reason: string | null;
  /** Every other gate that would also have withheld it. */
  alsoWithheldBy: InspectGate[];
  /** Present on a lock-capable tool the person may not use for locks. */
  lockCaveat?: string;
  /**
   * WARP-2900 — `built-in`, `extension:<slug>@<version>` or
   * `remote:<serverId>`. Optional only so an older orchestrator still types.
   */
  source?: string;
  /** The runtime server that advertised it; null for a compiled tool. */
  serverId?: string | null;
  /** WARP-2900 — runtime rows only: what dispatch does with a call. */
  classification?: RuntimeToolClassification;
  /**
   * WARP-2900 — runtime rows only, present ⇔ dispatch refuses every call.
   * Not a withholding gate: an advertised row with one is a tool the model
   * is shown and cannot use.
   */
  callRefusal?: string;
}

export interface ToolInspectResponse {
  targetUserId: string;
  tier: string | null;
  unresolved: AttributionFailure | null;
  /** `true` = no role narrowing. NOT "unrestricted" — the tier gate still runs. */
  noRoleNarrowing: boolean;
  counts: {
    registered: number;
    advertised: number;
    withheld: number;
    byGate: Record<InspectGate, number>;
    /**
     * WARP-2900 — of `advertised`, how many dispatch refuses every call to.
     * Optional only so an older orchestrator still types.
     */
    refusedAtDispatch?: number;
  };
  rows: ToolInspectRow[];
}

export type PromptBlockStatus =
  | "present"
  | "absent"
  | "errored"
  | "dropped"
  | "not_modelled"
  | "withheld_off_lan";

export interface PromptBlockView {
  key: string;
  label: string;
  status: PromptBlockStatus;
  text: string | null;
  chars: number;
  cap: number | null;
  neverDropped: boolean;
  note?: string;
}

export interface PromptInspectResponse {
  targetUserId: string;
  tier: string | null;
  unresolved: AttributionFailure | null;
  blocks: PromptBlockView[];
  /** The assembled system message, verbatim. */
  assembled: string;
  assembledChars: number;
  erroredBlocks: string[];
}

export interface ToolCatalogResponse {
  tools: ToolCatalogEntry[];
  /** Domains in the orchestrator's canonical IA order — drives filter order. */
  domains: string[];
}

/**
 * WARP-829 — the one-shot payload the `/tools` page writes to
 * `sessionStorage["droplet.pendingComposer"]` before routing to `/chat`.
 *
 * Distinct from `droplet.pendingPrompt` (the hero hand-off, which the chat
 * page AUTO-SENDS): this payload only SEEDS the composer. Clicking a tool
 * primes the chat input with a starter line and pins a "acting on <tool>"
 * indicator — nothing runs until the user edits and sends, at which point
 * the model invokes the tool and the existing in-chat confirmation gate
 * applies (see `docs/llm-safety-tiers.md`). The dashboard never dispatches
 * a tool; dispatch stays in the orchestrator's MCP path.
 *
 * `kind` is a discriminant so the chat page can grow other seed sources
 * later without overloading the key.
 */
export const PENDING_COMPOSER_KEY = "droplet.pendingComposer";

/**
 * The hero hand-off: `sessionStorage[PENDING_PROMPT_KEY]` holds a prompt typed
 * on Home or /help, and the next fresh `/chat` AUTO-SENDS it. WARP-2992 clears
 * it (and PENDING_COMPOSER_KEY) on sign-out — a named key, so the writers,
 * the reader and that purge cannot drift apart.
 */
export const PENDING_PROMPT_KEY = "droplet.pendingPrompt";

/**
 * WARP-460 + WARP-2582 — every kind of context that can be pinned to a chat
 * thread. Mirrors the orchestrator's `ContextPinKind` enum; the two are one
 * contract and change together.
 *
 * Declared HERE rather than in api.ts because the dependency runs api.ts ->
 * types.ts, and the hand-off payload below needs the business half of it.
 */
export type ContextPinKind =
  | "folder"
  | "file"
  | "email_thread"
  | "camera"
  | "camera_window"
  | "customer"
  | "deal"
  | "project"
  | "work_item";

/** The kinds whose `ref` is a RECORD ID rather than a path or a device name.
 *  These are the ones the orchestrator resolves to a display name. */
export type BusinessContextPinKind = "customer" | "deal" | "project" | "work_item";

/**
 * WARP-2582 — how the orchestrator reports a business pin's target on GET
 * /api/llm/:sessionId/pins. An EXPLICIT enum, so a client never has to infer
 * "deleted" from a null label.
 *
 * `unavailable` means the caller may not read this kind at all (the module is
 * off, or their AccessRole does not grant the domain). It is shown in the
 * Context panel only so the pin can be removed; it is never rendered into the
 * system prompt.
 */
export type ContextPinTargetState = "active" | "archived" | "missing" | "unavailable";

export interface ContextPinTarget {
  state: ContextPinTargetState;
  label: string | null;
  sublabel: string | null;
}

export interface PendingComposerToolPayload {
  kind: "tool";
  /** Registry tool name, e.g. `block_network_device`. Identity for the chip. */
  toolName: string;
  /** Human-readable tool title, e.g. "Block network device" — chip label. */
  label: string;
  /** Mirrors the registry safety flags so the chip can show the right chip. */
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  /** Plain-language starter line dropped into the composer for the user to edit. */
  seedText: string;
}

/**
 * WARP-2582 — the record hand-off from /customers, /projects and the CRM
 * record drawer. The second seed source WARP-829's `kind` discriminant was
 * built to allow.
 *
 * It carries BOTH halves for one reason: context pins are per-session and a
 * session id does not exist until the first turn mints one. So `seedText`
 * names the record on turn 1, and `pin` is applied once the id appears and
 * covers every turn after. Neither half auto-sends.
 *
 * `pin` is `null` for a LIST-scoped action ("Ask AI about your customers") —
 * a pin needs a `ref` and a list has none. Explicit null rather than an
 * absent field, so "nothing to pin" is a stated case and not an oversight.
 */
export interface PendingComposerPinPayload {
  kind: "pin";
  /** Display name — the chip label. Never sent as `ref`. */
  label: string;
  pin: { kind: BusinessContextPinKind; ref: string } | null;
  seedText: string;
}

export type PendingComposerPayload =
  | PendingComposerToolPayload
  | PendingComposerPinPayload;

/* ─────────────────────── Client-app downloads ─────────────────────── */

/** Platforms the box can describe a client app for. Mirrors
 *  `APP_PLATFORMS` in the orchestrator's services/app-downloads/catalog.ts —
 *  the two are one contract and change together. */
export type AppDownloadPlatform =
  | "windows"
  | "macos"
  | "linux"
  | "android"
  | "ios";

/** What an asset is, which decides how the page offers it. */
export type AppDownloadAssetKind = "installer" | "signature" | "manifest";

/**
 * How the catalog's authenticity was established.
 *
 * `digest-only` is the DEFAULT and is not a weakness: an operator staged
 * the artifacts onto the box (ADR-045 — nothing ships inside the image),
 * and the box re-hashes every byte against the catalog's pinned sha256
 * before serving. `signed` additionally means
 * a cosign signature over the catalog verified against a real trust
 * anchor — only claimed when it was actually checked.
 */
export type AppDownloadAttestation = "signed" | "digest-only";

export interface AppDownloadAsset {
  name: string;
  kind: AppDownloadAssetKind;
  size: number;
  /** Lowercase hex sha256, shown so a customer can verify by hand. */
  sha256: string;
  /** For a signature asset, the installer it signs. */
  signs: string | null;
  signatureAlgorithm: string | null;
  /** Absolute API path that streams the verified bytes. */
  url: string;
}

export interface AppDownloadPlatformEntry {
  platform: AppDownloadPlatform;
  version: string;
  /** `name` of the asset that is THE download. Null when store-distributed. */
  primary: string | null;
  /** Where this platform really ships, when that is not the box. */
  storeUrl: string | null;
  note: string | null;
  minOsVersion: string | null;
  releasedAt: string | null;
  assets: AppDownloadAsset[];
}

export interface AppDownloadCatalog {
  /** False when nothing is staged, or the catalog could not be trusted. */
  available: boolean;
  /** Canonical failure reason from the store; null when available. */
  reason: string | null;
  detail: string | null;
  attestation: AppDownloadAttestation | null;
  generatedAt?: string | null;
  platforms: AppDownloadPlatformEntry[];
}

// --- Routines (WARP-2671) — the ToolSpec surface at /routines ---
//
// `ToolSpec` is the orchestrator's name for a stored, replayable sequence of
// tool calls. The user-facing noun is "routine": `/tools` is already the
// read-only catalog of the box's built-in capabilities, and a routine is
// something a person composed out of them.

export type RoutineStatus = "live" | "draft" | "suggested";

export interface RoutineStep {
  id: string;
  idx: number;
  /** "call" | "summarize" | "transform" | "when" — a plain String column,
   *  extensible by design (WARP-2895 added the two sandbox kinds). */
  kind: string;
  /** `{tool, args}` for a call, `{prompt?}` for a summarize, `{code, inputs?}`
   *  for a transform / when. */
  args: Record<string, unknown> | null;
}

export interface Routine {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: RoutineStatus;
  ownerId: string | null;
  share: string | null;
  safety: number;
  /** Derived server-side from the steps since WARP-2665 — never self-declared. */
  writes: boolean;
  reversible: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present on the detail fetch, absent from the list. */
  steps?: RoutineStep[];
}

export interface RoutineRun {
  id: string;
  triggeredBy: string | null;
  startedAt: string;
  endedAt: string | null;
  status: "pending" | "running" | "ok" | "failed" | "cancelled";
  error: string | null;
  /** Per-step `{idx, tool, args, ok, result|error, as?}` records. */
  trace: unknown;
}

export interface RoutineSchedule {
  id: string;
  specId: string;
  rrule: string;
  /** IANA zone the rrule's wall-clock is read in (WARP-2665). */
  timezone: string;
  nextFireAt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── WARP-2900 (ADR-056 slice H4) — runtime tools + extensions ──────────────

/** What dispatch does with a call to a runtime tool, as the orchestrator's policy answers. */
export interface RuntimeToolClassification {
  decision: "allow" | "deny";
  /** REMOTE_WRITE_NOT_PERMITTED, REMOTE_TOOL_DENIED, … Null on allow. */
  code: string | null;
}

/**
 * One row of `GET /api/llm/tools/runtime`. There is deliberately no
 * description: a runtime tool's description is its author's claim.
 */
export interface RuntimeToolView {
  name: string;
  wireName: string;
  serverId: string;
  source: string;
  extension: { id: string; version: string } | null;
  domain: string;
  domainSource: "operator" | "server" | "default";
  classification: RuntimeToolClassification;
}

export interface RuntimeToolsResponse {
  tools: RuntimeToolView[];
}

/** The promote readback, derived server-side from provides/resources/egress only. */
export interface ExtensionReadback {
  tools: { total: number; startsAsWriteWithConfirmation: number; proposedReadOnly: number };
  routineDrafts: number;
  proposedGrants: number;
  memoryMb: number;
  egress: string;
  /** The sentences the confirm step shows, in order. */
  lines: string[];
}

export interface ExtensionPreflightFinding {
  code: string;
  detail: string;
}

export interface ExtensionPreflight {
  ok: boolean;
  blocking: ExtensionPreflightFinding[];
  advisory: ExtensionPreflightFinding[];
  budget: { availableMb: number; requestedMb: number; ceilingMb: number };
}

export type ExtensionStatus = "signed" | "installed" | "live" | "disabled" | "failed" | "uninstalled";

export interface ExtensionListItem {
  id: string;
  workspaceId: string;
  name: string;
  status: ExtensionStatus;
  failureReason: string | null;
  operatorDomain: string | null;
  installedByUserId: string;
  createdAt: string;
  updatedAt: string;
  version: {
    version: string;
    tag: string;
    commit: string;
    signer: string;
    keyFingerprint: string;
    promotedAt: string;
  } | null;
  readback: ExtensionReadback | null;
}

export interface ExtensionProposal {
  workspaceId: string;
  name: string;
  userId: string;
  tag: string;
  version: string;
  slug: string;
  proposedAt: string | null;
  promotable: boolean;
  reason: string | null;
  readback: ExtensionReadback | null;
}

/** Phase 1 of `POST /api/extensions/:workspaceId/promote` (202). */
export interface ExtensionPromotePhase1 {
  confirmationToken: string;
  expiresAt: string;
  workspaceId: string;
  slug: string;
  tag: string;
  version: string;
  commit: string;
  manifestSha256: string;
  readback: ExtensionReadback;
  preflight: ExtensionPreflight;
}

/** Phase 2 (201). */
export interface ExtensionPromoteResult {
  version: string;
  installed: boolean;
  installError: { code: string; message: string } | null;
}

// ── WARP-2977 (ADR-059 P2): the Security command center feed ──

/** Mirrors the orchestrator's SecurityEventKind enum. */
export type SecurityEventKind =
  | "detection"
  | "detection_low"
  | "camera_offline"
  | "camera_online"
  | "source_offline"
  | "source_online"
  | "threat"
  /** WARP-2977 P2b — the site mode changed. labels = [mode, modeSource, fromMode]; site-wide. */
  | "mode_changed"
  /**
   * WARP-2978 PR-D — a person Frigate has tracked for 30 s and not ended yet:
   * one row per person, endedAt null; their `end` is still its own
   * `detection` row. Shown as "Still in view".
   */
  | "detection_ongoing";

/** Mirrors the orchestrator's SecurityEventSource enum. */
export type SecurityEventSource = "frigate" | "frigate_status" | "activity_mirror" | "site_mode";

/** An area a feed row belongs to — only areas the viewer can see. */
export interface SecurityZoneRef {
  id: string;
  name: string;
}

export interface SecurityEvent {
  /** BigInt id, serialised as a string. */
  id: string;
  source: SecurityEventSource;
  kind: SecurityEventKind;
  severity: "info" | "notice" | "alert";
  /** Frigate camera name; null for rows no camera produced. */
  camera: string | null;
  labels: string[];
  cameraZones: string[];
  score: number | null;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  /** Set on detections — the clip/thumbnail routes key on it. */
  frigateEventId: string | null;
  /**
   * WARP-2977 P2b — the areas this row happened in, resolved at read time
   * from the viewer's VISIBLE links of VISIBLE areas (never names a hidden
   * area). Empty for site-wide rows (threats, Frigate health, mode changes).
   */
  zones: SecurityZoneRef[];
  /**
   * WARP-2978 (ADR-059 P3 route 1) — the incident the engine grouped this row
   * into, or null. A row the viewer can see implies its incident is visible
   * to them. Absent from a box older than P3.
   */
  incident?: { id: string } | null;
}

export interface SecurityEventsPage {
  events: SecurityEvent[];
  nextCursor: string | null;
}

/**
 * One line of the feed header: what the feed is listening to, and whether it
 * is reporting. Served in the order camera_ingest, camera_system,
 * threat_mirror, site_mode, incidents, alerts, patterns, retention (PR-2 adds
 * `locks` after camera_system). WARP-2978: `incidents` is every viewer's;
 * `alerts` (who alerts reach) is owner/admin only. `patterns` (WARP-2980) is
 * the baseline job's row.
 */
export interface SecurityHealthRow {
  id:
    | "camera_ingest"
    | "camera_system"
    | "threat_mirror"
    | "site_mode"
    | "incidents"
    | "alerts"
    | "patterns"
    | "retention";
  state: "ok" | "quiet" | "down" | "not_configured";
  detail: string;
  lastSeenAt: string | null;
}

// ── WARP-2977 P2b (ADR-059 §3.4, §3.6): areas, opening hours, the site mode ──
// Wire shapes of /api/security/{zones,sources,mode,hours}. Mirrors the
// orchestrator's views in services/security-zones.service.ts and
// services/security-mode.service.ts. "Areas" in the UI, `zone` in code.

export type SecurityZoneKind = "entry" | "interior" | "perimeter" | "parking" | "restricted";
export type SecurityZoneState = "active" | "archived";
/** PR-2 adds "lock". */
export type SecurityZoneSourceKind = "camera" | "camera_zone";
/**
 * `removed` = a person unlinked it. WARP-2979: `proposed` = Droplet suggests it
 * (nothing uses it until a person adds it); `rejected` = a person turned
 * Droplet's suggestion down, or undid Droplet's link. Route 3 lists `active`
 * links only; suggestions come from route 23.
 */
export type SecurityZoneLinkState = "active" | "removed" | "proposed" | "rejected";
/** WARP-2979 — who created a link (`origin`) and who set its current state (`setBy`). */
export type SecurityLinkActor = "person" | "droplet";

/**
 * WARP-2979 (ADR-059 P4 §6.4) — why Droplet linked or suggested a source: the
 * co-occurrence counts it decided on. Every number is an integer
 * (`lambdaMilli` = expected by chance × 1000, `liftTenths` = lift × 10,
 * `confidenceBp` = confidence × 10 000); `pAdj` is a string. The server sends
 * it only to a viewer who can see every source it names (DS-005); the page
 * turns it into sentences (components/security/link-evidence-copy.ts).
 */
export interface LinkEvidenceDirection {
  n: number;
  k: number;
  excluded: number;
  lambdaMilli: number;
  liftTenths: number;
  confidenceBp: number;
}

export interface LinkEvidenceSource {
  sourceKind: "lock" | "camera" | "camera_zone";
  sourceRef: string;
  /** The camera's (or lock's) display name when the evidence was computed. */
  label: string;
}

export interface LinkEvidenceView {
  v: 1;
  kind: "lock_camera" | "camera_camera";
  /** ISO instants of the 14-day window. */
  window: { from: string; to: string };
  anchor: LinkEvidenceSource & { linkId: string };
  candidate: LinkEvidenceSource;
  /** The anchor's visits → the candidate. */
  forward: LinkEvidenceDirection;
  /** camera_camera only: the candidate's visits → the anchor. */
  reverse: LinkEvidenceDirection | null;
  chosen: "whole" | "part" | "lock";
  wholeK: number | null;
  /** Names are a tiebreak, never evidence: shown below the numbers. */
  names: { match: boolean; shared: string[] };
  hypotheses: number;
  pAdj: string;
  gate: "auto" | "propose";
  /** Up to 5 recent hits, newest first; removed after 30 days (then `samplesTrimmedBefore` is set). */
  samples: Array<{ anchorAt: string; hitAt: string }>;
  samplesTrimmedBefore: string | null;
}

export interface SecurityZoneLinkView {
  id: string;
  sourceKind: SecurityZoneSourceKind;
  /** camera: `<frigateCamera>`; camera_zone: `<frigateCamera>/<frigateZone>`. */
  sourceRef: string;
  /**
   * ALWAYS the CAMERA's display name — the live camera name when the camera
   * exists, else the snapshot taken when it was linked — for camera AND
   * camera_zone links alike. It NEVER includes the part: render a camera_zone
   * link as "<label> (the '<part>' part of the view)", where the part is always
   * `sourceRef.slice(sourceRef.indexOf("/") + 1)`. The server snapshots
   * `sourceLabel` at link time as that same camera display name.
   */
  label: string;
  state: SecurityZoneLinkState;
  stateChangedAt: string;
  /** WARP-2979 — who created the link: a person, or Droplet (a suggestion or its own link). */
  origin: SecurityLinkActor;
  /**
   * WARP-2979 — who set its current state. `origin droplet` + `setBy droplet`
   * = "Linked by Droplet" (Keep / Undo); `origin droplet` + `setBy person` =
   * a suggestion a person added or kept. Only person-set links make alerts.
   */
  setBy: SecurityLinkActor;
  /** WARP-2979 — Droplet's evidence; null unless origin is droplet AND this viewer can see every source it names. */
  evidence: LinkEvidenceView | null;
}

export interface SecurityZoneView {
  id: string;
  name: string;
  kind: SecurityZoneKind;
  state: SecurityZoneState;
  /** Send back as `expectedVersion` on every edit of this area or its links. */
  version: number;
  /** The viewer's visible active links only. */
  links: SecurityZoneLinkView[];
}

/**
 * GET /api/security/zones. `include=archived` is honoured only for an owner or
 * admin whose Security level is manage (or has no per-person level at all);
 * for anyone else it is ignored, not refused.
 */
export interface SecurityZonesResponse {
  zones: SecurityZoneView[];
}

export type SecurityLinkStatus = "present" | "missing" | "unknown";

/** GET /api/security/sources — what can be linked, and whether each link still points at something. */
export interface SecuritySourcesView {
  frigate: "ok" | "unavailable";
  /** Visible cameras only. `parts` = the camera's Frigate zones ("parts of the camera's view"). */
  cameras: Array<{ name: string; label: string; parts: string[] }>;
  linkStatus: Array<{ linkId: string; status: SecurityLinkStatus }>;
}

/** POST /api/security/zones. */
export interface SecurityZoneCreateBody {
  name: string;
  kind: SecurityZoneKind;
}

/** PATCH /api/security/zones/:id — at least one of name/kind. */
export interface SecurityZonePatchBody {
  name?: string;
  kind?: SecurityZoneKind;
  expectedVersion: number;
}

/** PUT /api/security/zones/:id/links — the whole desired set, at most 32. */
export interface SecurityZoneLinksBody {
  links: Array<{ sourceKind: SecurityZoneSourceKind; sourceRef: string }>;
  expectedVersion: number;
}

/** POST /api/security/zones → 201. */
export interface SecurityZoneCreated {
  zone: SecurityZoneView;
}

/** PATCH, archive, unarchive and links → 200. `changed:false` = nothing to do (no audit row). */
export interface SecurityZoneWriteResult {
  zone: SecurityZoneView;
  changed: boolean;
}

// ── WARP-2979 (ADR-059 P4 §7 routes 23–27): Droplet's links and its AI settings ──

/** What Droplet may do with links on its own (manage). */
export type SecurityAiLinking = "link_and_suggest" | "suggest_only" | "off";
/** Whether Droplet writes incident summaries (on this Droplet only). */
export type SecurityAiSummaries = "on" | "off";

/** One of Droplet's open suggestions (route 23). */
export interface SecurityLinkProposal {
  linkId: string;
  zone: { id: string; name: string; kind: SecurityZoneKind };
  sourceKind: SecurityZoneSourceKind;
  sourceRef: string;
  /** The camera's display name (never the part — see SecurityZoneLinkView.label). */
  label: string;
  /** Wilson lower bound, 0..1. */
  confidence: number;
  evidence: LinkEvidenceView | null;
  /** When the evidence behind it was last computed (ISO). */
  suggestedAt: string;
}

/**
 * GET /api/security/link-proposals. `proposals` is filled only at manage (or
 * for an owner/admin with no per-person level); below it the list is empty,
 * never refused. Ordered: a name match first, then confidence.
 */
export interface SecurityLinkProposalsView {
  level: "view" | "act" | "manage" | null;
  linking: SecurityAiLinking;
  proposals: SecurityLinkProposal[];
}

/** POST /api/security/links/:id/{accept,reject} → 200. `changed:false` = already decided that way (no audit row). */
export type SecurityLinkDecisionResult = SecurityZoneWriteResult;

/** GET /api/security/ai-settings. */
export interface SecurityAiSettingsView {
  linking: SecurityAiLinking;
  summaries: SecurityAiSummaries;
  /** Send back as `expectedVersion`. */
  version: number;
}

/** PUT /api/security/ai-settings (manage). */
export interface SecurityAiSettingsBody {
  linking: SecurityAiLinking;
  summaries: SecurityAiSummaries;
  expectedVersion: number;
}

/** PUT /api/security/ai-settings → 200. `changed:false` = nothing to change (no audit row). */
export interface SecurityAiSettingsWriteResult extends SecurityAiSettingsView {
  changed: boolean;
}

export type SecurityMode = "open" | "closed" | "away";
export type SecurityModeSource = "schedule" | "manual";
export type SecurityManualEnd = "none" | "next_opening" | "at_time" | "until_changed";

/** GET /api/security/mode. `mode` is the EFFECTIVE mode. */
export interface SecurityModeView {
  mode: SecurityMode;
  source: SecurityModeSource;
  manualEnd: SecurityManualEnd;
  /** When a manual mode ends (next_opening / at_time); null otherwise. */
  until: string | null;
  setBy: { id: string; name: string } | null;
  setAt: string;
  hours:
    | { state: "not_set" }
    | {
        state: "set";
        /** The SITE zone — format every time on this page in it, never the browser's. */
        timezone: string;
        scheduledMode: "open" | "closed";
        upcoming: { at: string; mode: "open" | "closed" } | null;
      };
  /**
   * The zone to format EVERY time on the mode card in (setAt, until, upcoming):
   * the site timezone when the opening hours are set; else Workspace.tz when it
   * is a valid IANA zone; else null — and then the dashboard formats in
   * `deviceTimeZone()` (lib/security-time.ts). Never UTC.
   */
  displayTimezone: string | null;
  /** The stored mode lags the effective one, or the opening-hours check is down. */
  stale: boolean;
  version: number;
}

/** POST /api/security/mode — an intent applied to the current state (no version). */
export type SecurityModeAction =
  | { action: "close" }
  | { action: "open"; for: "1h" | "2h" | "4h" }
  | { action: "away" }
  | { action: "resume" };

export interface SecurityModeActionResult {
  mode: SecurityModeView;
  /** false = already in that state; nothing was written. */
  changed: boolean;
}

export type SecurityHoursState = "not_set" | "set";
export type SecurityDayKind = "closed" | "open_all_day" | "hours";

export interface SecurityHoursDay {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  kind: SecurityDayKind;
  /** 'HH:MM' site-local; null unless kind = hours. closes < opens = closes the next day. */
  opens: string | null;
  closes: string | null;
}

export interface SecurityHoursException {
  /** Site-local 'YYYY-MM-DD'. */
  date: string;
  kind: SecurityDayKind;
  opens: string | null;
  closes: string | null;
  note: string;
}

/** GET /api/security/hours. */
export interface SecurityHoursView {
  state: SecurityHoursState;
  timezone: string | null;
  /** Send back as `expectedVersion` on every hours or special-day write. */
  version: number;
  /** 7 entries, Monday first. */
  days: SecurityHoursDay[];
  /** Upcoming special days (from site-local yesterday), at most 100. */
  exceptions: SecurityHoursException[];
  /** The next 7 days of open windows, computed by the server. */
  preview: Array<{ startsAt: string; endsAt: string }>;
  hint: {
    /** The workspace's timezone, only when it is a valid IANA zone. */
    workspaceTimezone: string | null;
    /** The business profile's free-text typical day, read-only. "" below owner/admin (the profile's §15 audience ladder). */
    typicalDay: string;
  };
}

/** PUT /api/security/hours. */
export type SecurityHoursBody =
  | {
      state: "set";
      timezone: string;
      /** Exactly 7, unique weekdays 1..7. opens/closes 'HH:MM', only for kind = hours. */
      days: Array<{ weekday: number; kind: SecurityDayKind; opens?: string; closes?: string }>;
      expectedVersion: number;
    }
  | { state: "not_set"; expectedVersion: number };

/** PUT /api/security/hours/exceptions/:date. */
export interface SecurityHoursExceptionBody {
  kind: SecurityDayKind;
  opens?: string;
  closes?: string;
  /** At most 80 characters. */
  note?: string;
  expectedVersion: number;
}

/**
 * PUT /api/security/hours and PUT …/exceptions/:date → 200: both views, since
 * the mode may move. Both null = SAVED (committed and audited), but the server
 * could not read them back: re-read. Never an error — a 5xx means nothing changed.
 */
export interface SecurityHoursWriteResult {
  hours: SecurityHoursView | null;
  mode: SecurityModeView | null;
}

/** Every `error.code` the P2b Security routes answer with (`{error: {code, message, issues?}}`). */
export type SecurityErrorCode =
  | "VALIDATION_ERROR"
  | "ZONES_UNAVAILABLE"
  | "MODE_UNAVAILABLE"
  | "HOURS_UNAVAILABLE"
  | "MODE_CONFLICT"
  | "AUDIT_UNAVAILABLE"
  | "VERSION_CONFLICT"
  | "ZONE_NOT_FOUND"
  | "ZONE_NAME_TAKEN"
  | "ZONE_LIMIT"
  | "ZONE_ARCHIVED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_CHECK_UNAVAILABLE"
  | "INVALID_TIMEZONE"
  | "SAME_OPEN_CLOSE"
  | "HOURS_NOT_SET"
  | "EXCEPTION_NOT_FOUND"
  | "EXCEPTION_LIMIT"
  | "EXCEPTION_OUT_OF_RANGE"
  // A 500: a programming error on the box (a refused audit precondition, a
  // TypeError), never an outage — retrying the same request will not help.
  | "INTERNAL_ERROR"
  // WARP-2980 (P5 PR-A) — the read-only patterns routes 29–31.
  | "PATTERNS_UNAVAILABLE"
  | "PATTERN_NOT_FOUND"
  | "PATTERNS_NOT_BUILT"
  | "NO_TIMEZONE"
  // WARP-2980 (P5 PR-B) — expected activity, routes 32–34 (ZONE_ARCHIVED and
  // AUDIT_UNAVAILABLE above answer route 33 too).
  | "SUPPRESSIONS_UNAVAILABLE"
  | "SUPPRESSION_NOT_FOUND"
  | "SUPPRESSION_TARGET_NOT_FOUND"
  | "SUPPRESSION_LIMIT"
  // WARP-2978 (ADR-059 P3 §7 routes 16–22): incidents and who is told about alerts.
  | "INCIDENT_NOT_FOUND"
  | "INCIDENT_CONFLICT"
  | "NOT_ACTIONABLE"
  | "INCIDENTS_UNAVAILABLE"
  | "NO_RECIPIENT"
  | "NOT_ELIGIBLE"
  | "ROUTING_UNAVAILABLE"
  | "USER_NOT_FOUND"
  // WARP-2979 (ADR-059 P4 §7 routes 23–27): Droplet's links and the AI settings.
  | "LINK_NOT_FOUND"
  | "LINK_NOT_DECIDABLE"
  | "LINK_CONFLICT"
  | "LINK_LIMIT"
  | "LINKS_UNAVAILABLE"
  | "AI_SETTINGS_UNAVAILABLE";

/** The error envelope; `archivedZoneId` rides on ZONE_NAME_TAKEN when the name's holder is archived. */
export interface SecurityApiErrorBody {
  error: { code: SecurityErrorCode; message: string; issues?: unknown[]; archivedZoneId?: string };
}

// ── WARP-2980 (ADR-059 P5 PR-A): what normal looks like ──
// Wire shapes of GET /api/security/patterns{,/cells,/explain} (routes 29–31).
// Mirrors apps/orchestrator/src/services/security-patterns-read.ts. "Patterns"
// and "what's usual" in the UI; never "baseline" or "suppression".

export type SecurityPatternCode = "out_of_place" | "unusual_volume" | "long_dwell";
export type SecurityPatternRelease = "trial" | "live";
export type SecurityLearningState = "learning" | "active" | "stale";
export type SecurityDayType = "weekday" | "weekend";

/** Route 29. */
export interface SecurityPatternsOverview {
  state: "not_configured" | "not_built" | "ready";
  reason: "no_timezone" | "no_cameras" | null;
  timezone: string | null;
  window: { from: string; to: string; builtAt: string } | null;
  release: Record<SecurityPatternCode, SecurityPatternRelease>;
  /** Visible cameras Droplet has heard from. A camera with no row here has never reported. */
  sources: Array<{
    camera: string;
    label: string;
    state: SecurityLearningState;
    daysObserved: number;
    daysNeeded: 14;
    lastSeenAt: string;
    detectionsPerDay: number | null;
  }>;
  /** Areas first, then cameras; only keys whose every camera the viewer can see. */
  keys: Array<{
    zoneKey: string;
    kind: "area" | "camera";
    zoneId: string | null;
    name: string;
    cameras: string[];
    labels: string[];
    learning: boolean;
  }>;
  waitingProposals: number;
  /** WARP-2980 PR-B: how often each pattern code was right — owner/admin only, else null. */
  precision: SecurityPatternPrecision | null;
}

/** WARP-2980 PR-B — route 29's precision: per pattern code, counts from the first mark, a percentage from day 30. */
export interface SecurityPatternPrecision {
  showAfterDays: 30;
  codes: Array<{ code: SecurityPatternCode; marked: number; notExpected: number; firstMarkedAt: string; percentRight: number | null }>;
}

/** One (dayType, hour) of route 30. */
export interface SecurityPatternCellView {
  dayType: SecurityDayType;
  hour: number;
  daysObserved: number;
  daysWithEvent: number;
  /** Enough observed days to judge this hour. */
  ready: boolean;
  /** Not usually seen at this hour. */
  rare: boolean;
  typicalPerHour: number | null;
  longestUsualVisitSec: number | null;
}

/** Route 30: 48 cells, weekdays 0–23 then weekends 0–23. */
export interface SecurityPatternCells {
  key: string;
  label: string;
  window: { from: string; to: string; builtAt: string };
  cells: SecurityPatternCellView[];
}

/** Route 31. */
export interface SecurityPatternExplainView {
  key: { zoneKey: string; kind: "area" | "camera"; zoneId: string | null; name: string; cameras: string[] };
  at: { instant: string; local: string; dayType: SecurityDayType; hour: number; timezone: string };
  window: { from: string; to: string; builtAt: string };
  sources: Array<{ camera: string; state: SecurityLearningState; daysObserved: number; daysNeeded: 14; lastSeenAt: string }>;
  cell: {
    ready: boolean;
    daysObserved: number;
    daysWithEvent: number;
    smoothed: { daysObserved: number; daysWithEvent: number };
    rarity: { p: number; flagsBelow: 0.05; wouldFlag: boolean };
    volume: { typicalPerHour: number | null; flagsFrom: number | null };
    dwell: { longestUsualVisitSec: number | null; samples: number; wouldFlagAboveSec: number | null };
    neighbours: Array<{ hour: number; daysObserved: number; daysWithEvent: number }>;
  } | null;
  /** WARP-2980 PR-B: why the pattern rules are paused for this key now; every "would flag" is off while set. */
  paused: "zone_changed" | "stale_build" | "area_changed" | "camera_not_active" | null;
  /** WARP-2980 PR-B: the active expected activity covering this slot. */
  expected: Array<{ id: string; text: string; until: string; codes: SecurityPatternCode[] }>;
  release: Record<SecurityPatternCode, SecurityPatternRelease>;
}

// ── WARP-2980 (ADR-059 P5 PR-B): expected activity (routes 32–34) ──
// Mirrors apps/orchestrator/src/services/security-suppressions.service.ts.
// "Suppression" is the route's and the code's word; the UI says "Expected activity".

export type SecuritySuppressionDays = "every_day" | "weekdays" | "weekends";

/** Route 32's row. */
export interface SecuritySuppressionView {
  id: string;
  target: { kind: "area"; zoneId: string; name: string; archived: boolean } | { kind: "camera"; camera: string; name: string };
  label: string;
  days: SecuritySuppressionDays;
  /** Site-local hour 0–23, and how many hours from it (1–24; wraps past midnight; 24, "All day", only from 0). */
  hourFrom: number;
  hourCount: number;
  codes: SecurityPatternCode[];
  reason: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  /** Flags it quietened — owner/admin only; null for anyone else. */
  quietedFlags: number | null;
}

/** Route 32. `canManage` is the server's answer: render Add / Remove from it, never from a level guess. */
export interface SecuritySuppressionList {
  suppressions: SecuritySuppressionView[];
  canManage: boolean;
  limit: number;
}

/** Route 33's body — exactly these keys. */
export interface SecuritySuppressionCreateBody {
  target: { kind: "area"; zoneId: string } | { kind: "camera"; camera: string };
  label: string;
  days: SecuritySuppressionDays;
  hourFrom: number;
  hourCount: number;
  codes: SecurityPatternCode[];
  reason: string;
  expiresInDays: number;
}

// ── WARP-2978 (ADR-059 P3 §7, P6 §7.5): incidents, acknowledgement, alert routing ──
// Wire shapes of routes 16–22, mirrored from the orchestrator's
// services/security-incident-view.ts and services/security-alerts.service.ts.
// P6's native clients decode the same shapes. Everything is VIEWER-PROJECTED
// on the box (DS-005): a hidden camera's codes, counts, acks and notices are
// simply absent, and the page renders what it is given — it never fills in.
// The unions are what P3 sends; the copy helpers still render an unknown
// value (a later code or scope) as a generic line rather than nothing.

export type SecuritySeverity = "info" | "notice" | "alert";
export type SecurityIncidentScope = "area" | "camera" | "site_threat" | "site_camera_system";
/** `no_action` = ordinary activity (or no code the viewer can see): nothing to acknowledge. */
export type SecurityIncidentState = "no_action" | "open" | "acknowledged" | "resolved";
/** Whether the incident still takes events. Explicit — never inferred from times. */
export type SecurityIncidentGrouping = "collecting" | "closed";
/**
 * Mirrors the orchestrator's `SecurityReasonCode` enum: P3's three rules, then
 * P5's pattern codes (WARP-2980). A pattern code reaches `reasonCodes` and
 * `reasons` only once P5 PR-D releases it as counted; until then it is a
 * trial flag, which route 18 sends apart, in `patternFlags` (see
 * IncidentDetail). The copy names every member (incident-copy.ts).
 * WARP-2979 (P4): `camera_offline_during_activity`, an alert — a camera a
 * person linked to an area stopped reporting soon after someone was seen
 * there, while the site was closed or away.
 */
export type SecurityReasonCode =
  | "after_hours_presence"
  | "camera_offline"
  | "threat_signal"
  | SecurityPatternCode
  | "camera_offline_during_activity";
/** Whether the events behind the incident are still kept (they are trimmed after 30 days; the incident stays a year). */
export type SecurityIncidentEventsKept = "kept" | "partly_removed" | "removed";
export type SecurityIncidentAckAction = "acknowledge" | "resolve";

export interface IncidentAckSummary {
  action: SecurityIncidentAckAction;
  byName: string;
  at: string;
}

/** Route 16's row, route 17's `latest`, and the head of route 18. */
export interface IncidentSummary {
  id: string;
  scope: SecurityIncidentScope;
  /** The area as it was when the incident opened (a snapshot). */
  zone: { id: string; name: string; kind: SecurityZoneKind } | null;
  /** The Frigate camera of a `camera`-scope incident. */
  camera: string | null;
  /** Viewer-projected. */
  state: SecurityIncidentState;
  /** The viewer's visible severity. */
  severity: SecuritySeverity;
  /** The viewer's visible codes. */
  reasonCodes: SecurityReasonCode[];
  grouping: SecurityIncidentGrouping;
  /** The site mode at the first event. */
  openedInMode: SecurityMode;
  firstActivityAt: string;
  lastActivityAt: string;
  /**
   * Visible events (survives the 30-day trim) — every row the incident page
   * lists, a person's "still in view" row (PR-D) included: a 40-second visit
   * is 2 events, the early row and the finished one.
   */
  eventCount: number;
  /**
   * Visible counts per label. Keys starting `_` are the box's bookkeeping,
   * never a label to show: `_status` / `_threat` count status and threat rows,
   * `_ongoing` a person's "still in view" row (PR-D) — that person is counted
   * once, under their label, by their finished row.
   */
  labels: Record<string, number>;
  /** The latest acknowledgement, by anyone — only in an actionable view: never a partial one, never plain activity. */
  lastAck: IncidentAckSummary | null;
}

/** GET /api/security/incidents — `(lastActivityAt desc, id desc)`. */
export interface IncidentsPage {
  incidents: IncidentSummary[];
  nextCursor: string | null;
}

/** GET /api/security/incidents/summary. */
export interface IncidentsSummary {
  /** Open incidents whose visible severity is alert. */
  openAlerts: number;
  /** Open incidents whose visible severity is notice. */
  openNotices: number;
  /** At most 3 that need attention, newest first. */
  latest: IncidentSummary[];
  /** Opening hours set AND an Inside / Staff only area with a camera: after-hours alerts can fire. */
  alertsReady: boolean;
}

export interface IncidentReasonView {
  code: SecurityReasonCode;
  severity: SecuritySeverity;
  /** A snapshot of the event that triggered the code — it outlives the event. */
  evidence: {
    eventId: string;
    camera: string | null;
    source: string;
    kind: string;
    label: string | null;
    at: string;
    summary: string;
  };
  /**
   * The rule's numbers: after_hours_presence `{mode, modeSource, nonOpenAt,
   * zoneKind}`; camera_offline `{offlineForSec, backAt}`; threat_signal
   * `{activityId, kind}`; a counted pattern code (P5 PR-D) the flag's own
   * numbers, which P5 PR-C words — this page shows its name alone.
   * WARP-2979 — camera_offline_during_activity `{offlineForSec, backAt, mode,
   * modeSource, activity: {eventId, kind, label, at, zoneId, zoneName}}`.
   */
  detail: Record<string, string | number | null | Record<string, string | number | null>> | null;
  /**
   * WARP-2979 — the second camera the evidence names (camera_offline_during_activity:
   * where the person was seen), else null. The box sends the reason only when
   * this viewer can see that camera too.
   */
  relatedCamera?: string | null;
}

export interface IncidentAckView {
  action: SecurityIncidentAckAction;
  byName: string;
  at: string;
  /** What the device SAID it was — reported, never proof. */
  client: string | null;
  /** The ack came from this person's own alert notification for the incident (verified on the box). */
  viaNotification: boolean;
  /** Resolve's note; "" when none. */
  note: string;
  /**
   * The sign-in behind the ack — owner/admin ONLY (null for anyone else):
   * whether the request carried a sign-in id, and whether the box confirmed
   * that sign-in live. The id itself is never sent, not even truncated.
   */
  signIn: { recorded: boolean; confirmedLive: boolean } | null;
}

export type SecurityNoticeOutcome =
  | "queued"
  | "sent"
  | "not_sent"
  | "skipped_no_access"
  | "skipped_not_visible"
  | "skipped_capped"
  | "skipped_no_address"
  /** The delivery's status couldn't be established. */
  | "outcome_unknown";
/** `fallback_owner`: nobody chosen could be told (or see the camera), so an owner was told instead. */
export type SecurityNoticeReason = "routed" | "fallback_owner";

/** Who was told. Owner/admin receive every notice; anyone else only their own. */
export interface IncidentNoticeView {
  userId: string;
  name: string;
  outcome: SecurityNoticeOutcome;
  reason: SecurityNoticeReason;
  /** The channels that took it: "toast", "push" or "toast,push". */
  channels: string;
  pushOutcome: "sent" | "no_subscribers" | "refused_gate" | "failed" | null;
  createdAt: string;
  settledAt: string | null;
}

/**
 * A visible member event: the feed row — with `zones`, the viewer's VISIBLE
 * areas from the feed's own resolver, but without route 1's `incident` (every
 * member belongs to this one) — plus `alsoIn`, the other visible areas it
 * matched when it was sorted.
 */
export type IncidentMemberView = Omit<SecurityEvent, "incident"> & { alsoIn: SecurityZoneRef[] };

/**
 * GET /api/security/incidents/:id — 404 INCIDENT_NOT_FOUND for missing AND hidden alike.
 *
 * Deliberately NOT mirrored here: what P5 PR-B (WARP-2980) added to route 18
 * — `verdict`, `patternFlags` and `viewer.canGiveVerdict` — and route 35
 * (POST …/verdict, whose 409 is NOT_JUDGEABLE). The box sends them; this
 * page ignores them. P5 PR-C mirrors and renders them (the verdict bar, the
 * Trial chip, a flag quietened by expected activity), each with its own
 * viewer rule, so none of it is shown before that rule is.
 */
export interface IncidentDetail extends IncidentSummary {
  reasons: IncidentReasonView[];
  /** Visible members while their events are kept, newest first. */
  events: IncidentMemberView[];
  /** More visible members than `events` carries. */
  moreEvents: boolean;
  /** Every acknowledgement when the view is actionable; in a partial view only this viewer's own; plain activity, none. */
  acks: IncidentAckView[];
  notices: IncidentNoticeView[];
  eventsKept: SecurityIncidentEventsKept;
  /**
   * Whether THIS viewer can act on it right now: their Security level is at
   * least act, a code is visible, it is open or acknowledged, and the view is
   * not PARTIAL. Partial: a reason at the incident's top severity is on a
   * camera they can't see — then the box sends only their own
   * acknowledgements, no notices and no lastAck, the state is `open` until
   * someone resolves it (never `acknowledged`), and routes 19–20 answer 409
   * NOT_ACTIONABLE. The wire has no `partial` flag, and the page never infers
   * one: the controls render only when this is true, and when it is false on
   * an open or acknowledged incident the page says the same thing whatever
   * the cause.
   */
  actionable: boolean;
  /**
   * The viewer's Security level on the box, and whether they have acknowledged
   * or resolved this incident — kept in a partial view too (their own act).
   */
  viewer: { level: "view" | "act" | "manage"; acknowledged: boolean };
}

/** POST …/acknowledge and …/resolve → 200. `changed:false` = nothing new (already done). */
export interface IncidentActionResult {
  incident: IncidentDetail;
  changed: boolean;
}

/** Why a person can't be told about alerts right now. */
export type AlertIneligibleReason = "inactive" | "role" | "no_address" | "no_access";

export interface AlertRoutingPerson {
  userId: string;
  name: string;
  role: string;
  state: "receiving" | "not_receiving";
  /** `owner_default`: an owner, told by default. null = nobody chose yet (not receiving). */
  origin: "owner_default" | "chosen" | null;
  /** Send back as `expectedVersion`; null = no row yet (create). */
  version: number | null;
  eligible: boolean;
  ineligibleReason: AlertIneligibleReason | null;
  /** Manages a department made from the Security template — a suggestion only, it grants nothing. */
  managesSecurityDepartment: boolean;
  /** `push`: a phone is set up and phone notifications are on; else only while Droplet is open. */
  delivery: "push" | "in_app_only";
}

/** GET /api/security/alert-routing — the whole list at manage; below it, the viewer's own line. */
export type AlertRoutingView =
  | { level: "manage"; people: AlertRoutingPerson[]; fallbackActive: boolean }
  | { level: "view" | "act"; self: { state: "receiving" | "not_receiving"; eligible: boolean } };

/** PUT /api/security/alert-routing/:userId (manage). */
export interface AlertRoutingSetBody {
  state: "receiving" | "not_receiving";
  expectedVersion: number | null;
}

// ── WARP-2981 (ADR-059 P6): the Security wall ──

/**
 * The two numbers the wall reads off route 17 (GET
 * /api/security/incidents/summary): open incidents with a visible alert, and
 * open ones with only notices — already this viewer's DS-005 projection. The
 * rest of that body is PR-C's.
 */
export interface SecurityIncidentCounts {
  openAlerts: number;
  openNotices: number;
}

// ── WARP-2804: notification acknowledgement (routes N1–N4) ──

export type NotificationKind = "reminder" | "event" | "system" | "ai";

/** Whether the RECIPIENT has seen it. Unread means `unacked`; `untracked` rows
 *  predate WARP-2804 and are never counted as unread (they can still be acked). */
export type NotificationAckState = "unacked" | "acked" | "untracked";

/** The path that acknowledged it. `incident` is WARP-2978's; no notification route sets it. */
export type NotificationAckMethod = "inbox" | "opened" | "all" | "incident";

/** One of the signed-in person's own notifications, as N1 returns it. The box
 *  also records which sign-in acked it and what the client said it was; it
 *  never returns either. */
export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** A same-origin dashboard path, validated by the box. */
  url: string | null;
  data: Record<string, string | number | boolean> | null;
  createdAt: string;
  deliveredAt: string | null;
  channels: string;
  pushOutcome: "sent" | "no_subscribers" | "refused_gate" | "failed" | null;
  error: string | null;
  ackState: NotificationAckState;
  ackedAt: string | null;
  ackMethod: NotificationAckMethod | null;
}

/** N1. `nextCursor` is null on the last page. */
export interface NotificationsPage {
  notifications: NotificationRow[];
  unread: number;
  nextCursor: string | null;
}

/** N3. `changed: false` when it was already acked (the first ack stands). */
export interface NotificationAckResult {
  notification: NotificationRow;
  changed: boolean;
}

/** N4 (`{ids}` in: the notifications shown). `unread` is what the badge should say now. */
export interface NotificationAckAllResult {
  acked: number;
  unread: number;
}
