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
  confirmation?: {
    kind: string;
    sceneId?: string;
    confirmationToken: string;
  };
  /** Local approve-button state: undefined = idle, then running → ran/failed. */
  confirmState?: "running" | "ran" | "failed";
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
   * through loadConversation from the persisted row. Rendered as the
   * collapsed "Thought process" disclosure above the bubble.
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
  name: string;
  family: string;
  provider: string;
  contextLength: number | null;
  /** GB on disk — null until ai-gateway exposes per-model disk usage. */
  gbOnDisk: number | null;
  /** "chat" | "embed" | "vision" | … — null until ai-gateway tags models. */
  role: string | null;
  /** Lifecycle of the model in the runtime. Drives the status chip. */
  status: "ready" | "loading" | "error";
  /** Sustained tokens/sec from the most recent benchmark; null until wired. */
  tokensPerSec: number | null;
  /** 0–100 fill for the on-disk usage meter; null until gbOnDisk has a value. */
  diskBarPct: number | null;
}

/** One opt-in cloud provider. Read-only on this surface — enabling a provider
 *  happens in Settings (the off-LAN allowlist), never here. */
export interface CloudProviderRow {
  provider: "anthropic" | "openai" | "gemini";
  /** Always false today (cloud escape default-off per FEATURES.md §8). */
  enabled: boolean;
  /** ISO timestamp of the last cloud-escape call, or null. */
  lastUsedAt: string | null;
  /** Cumulative spend this billing period; 0 until egress aggregation lands. */
  spendUsd: number;
}

/** GPU stats block — null until ai-gateway exposes a `/gpu` probe. */
export interface ModelsGpuInfo {
  name: string;
  vramGb: number;
  utilPct: number;
  tempC: number;
}

export interface ModelsPagePayload {
  local: LocalModelRow[];
  cloud: CloudProviderRow[];
  gpu: ModelsGpuInfo | null;
  avgLatencyMs: number;
  cloudSpendUsd: number;
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

export interface FileEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mimeType: string | null;
  modifiedAt: string;
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
export type FileSpaceId = "personal" | "shared";

/** A browsable Files space as reported by GET /api/files/spaces. */
export interface FileSpace {
  id: FileSpaceId;
  /** Display name ("My Files" or the shared folder name, e.g. "Household"). */
  name: string;
  /** Whether the space exists for this user (drives switcher visibility). */
  available: boolean;
  /** Home-relative root path for the space ("/" or "/Household"). */
  root: string;
}

export interface FileSpacesResponse {
  sharedAvailable: boolean;
  spaces: FileSpace[];
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

// ── WARP-1036: Voice assistant ──

/** Snapshot of the voice-io wake pipeline, relayed verbatim by the
 *  orchestrator's `/api/voice/status` proxy (snake_case keys are the
 *  voice-io FastAPI response model). The wizard's voice step polls this
 *  while the customer tries "hey droplet": a `last_wake_at` change is the
 *  wake confirmation; `last_transcript` / `last_response` land afterwards
 *  as STT and the reply complete. `state === "no_mic"` drives the
 *  plug-in-a-mic panel (hot-plug recovery needs no restart). */
export interface VoiceStatusInfo {
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
 * WARP-1059 — calibration-mode toggle result (`POST`/`DELETE`
 * `/api/voice/calibration-mode`). `expires_at` is the fail-safe TTL
 * expiry (epoch seconds) after an enter/renew; null after an exit.
 */
export interface VoiceCalibrationModeResult {
  active: boolean;
  expires_at?: number | null;
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
  role?: InviteRole;
  ttlHours?: number;
}

export interface InviteCreateResponse {
  token: string;
  url: string;
  expiresAt: string;
}

/** Mirror of `findInviteByToken` projection used by the public lookup endpoint. */
export interface InvitePublicInfo {
  username: string;
  displayName: string | null;
  role: InviteRole;
  expiresAt: string;
}

export interface InviteListItem {
  token: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: InviteRole;
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

export interface StorageStats {
  used: number;       // bytes
  total: number;      // bytes
  available: number;  // bytes
  percentage: number; // 0-100
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

export interface DrivesResponse {
  drives: DriveInfo[];
  count: number;
  /** WARP-936: whole-disk inventory. Absent on an older orchestrator/bridge —
   *  callers treat that as an empty list. */
  disks?: DiskInfo[];
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
  addresses: Array<{ ip: string; port: number; type: string }>;
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
  status: "recording" | "detecting" | "idle" | "offline";
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
  duration: number;
  motion: number;
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

export interface StorageStat {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  mountType: string;
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
  recordRetainDays: number;
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
  recordRetainDays?: number;
  snapshotsEnabled?: boolean;
  snapshotRetainDays?: number;
  zones?: CameraZone[];
  motionMasks?: MotionMaskPolygon[];
}

export interface DiscoveredCamera {
  id: string;
  name: string;
  ip: string;
  mac: string | null;
  manufacturer: string | null;
  model: string | null;
  discoveredAt: string;
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
  isBlocked: boolean;
  online: boolean;
  signal?: number;
  groups: DeviceGroupRef[];
  presenceDays?: DevicePresenceDay[];
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
export interface ToolCatalogEntry {
  name: string;
  /** Agent-facing description from the registry (may contain jargon). */
  description: string;
  /** Plain-language, home-user-facing copy — what `/tools` renders (ADR-002). */
  homeDescription: string;
  domain: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
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

export interface PendingComposerPayload {
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
