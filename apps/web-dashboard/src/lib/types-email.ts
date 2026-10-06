/**
 * WARP-837 — wire types for the Email surface (`/email`).
 *
 * These mirror the shapes the orchestrator's `apps/orchestrator/src/routes/email.ts`
 * actually returns (verified against origin/main at e2cb72d). They live in their
 * own file rather than the shared `types.ts` so the Email work stays cleanly
 * additive and doesn't collide with sibling surface PRs editing `types.ts`.
 *
 * Read-only-first: the only mutation types here are the draft create/patch/send
 * bodies. There is no "add account" / IMAP-cred / off-LAN-toggle shape — those
 * surfaces live in Settings, never on this page.
 */

/** IMAP connection health, as reported on each account row. */
export type ImapStatus = "idle" | "reconnecting" | "error" | "paused";

/** One connected mailbox. The address is the stable key the user recognises. */
export interface EmailAccount {
  id: string;
  userId: string | null;
  displayName: string;
  address: string;
  imapStatus: ImapStatus;
  /** ISO timestamp of the last successful IDLE round-trip, or null if never. */
  lastIdleAt: string | null;
  /** ISO timestamp of the last connection error, or null. */
  lastErrorAt: string | null;
  /** Human-readable last error, or null. */
  lastError: string | null;
  /** Provider-backed imports may be read-only even for a Droplet owner. */
  authMode?: "PASSWORD" | "GOOGLE_OAUTH" | "M365_GRAPH";
  canSend?: boolean;
}

export interface EmailAccountsResponse {
  accounts: EmailAccount[];
}

/**
 * The three list filters this surface exposes. The backend additionally
 * supports `archived`, which is intentionally out of v1 scope (FEATURES §2.4
 * lists only Inbox / Triaged / From Droplet).
 */
export type EmailFilter = "inbox" | "triaged" | "droplet";

/** Triage bucket a thread sits in server-side. */
export type TriageStatus = "inbox" | "triaged" | "archived";

/** A thread as it appears in the list column (no message bodies). */
export interface ThreadSummary {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  lastSender: string | null;
  snippet: string | null;
  messageCount: number;
  triageStatus: TriageStatus;
  /** True when Droplet authored a draft on this thread (the "From Droplet" chip). */
  draftedByDroplet: boolean;
  /** ISO timestamp of the most recent message. */
  lastMessageAt: string;
}

export interface ThreadsResponse {
  filter: EmailFilter;
  threads: ThreadSummary[];
}

/** One message inside a thread. `toAddrs`/`ccAddrs` are JSON string arrays. */
export interface EmailMessage {
  id: string;
  threadId: string;
  messageId: string;
  fromAddr: string;
  fromName: string | null;
  toAddrs: string[];
  ccAddrs: string[] | null;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** ISO timestamp. */
  receivedAt: string;
  /** WARP-3267 — the files the message carried (metadata only). */
  attachments?: EmailAttachment[];
  /** Outlook import records presence/metadata; attachment bytes stay in Outlook. */
  hasAttachments?: boolean;
  externalAttachmentMetadata?: Array<{ id: string; filename: string; contentType: string; size: number; isInline: boolean; status: "remote_only" }> | null;
}

/**
 * WARP-3267 — one attachment of a received message. `stored` ones download
 * from `emailAttachmentUrl`; the others were over the box's limits and are
 * listed so the reader knows they existed.
 */
export interface EmailAttachment {
  id: string;
  partIndex: number;
  filename: string;
  /** The sender's claim. Shown, never used to open the file. */
  contentType: string;
  size: number;
  sha256: string;
  contentId: string | null;
  status: "stored" | "too_large" | "over_limit";
}

/** A full thread with its messages in ascending receivedAt order. */
export interface ThreadDetail extends ThreadSummary {
  messages: EmailMessage[];
}

/** Lifecycle of an outbound draft. */
export type DraftStatus = "draft" | "queued" | "sent" | "failed";

/** A draft row, as returned by POST /drafts and PATCH /drafts/:id. */
export interface DraftRow {
  id: string;
  accountId: string;
  threadId: string | null;
  toAddrs: string[];
  ccAddrs: string[] | null;
  bccAddrs: string[] | null;
  subject: string;
  body: string;
  draftedByDroplet: boolean;
  /** WARP-3267 — stored attachment ids a forward carries. */
  attachmentIds?: string[];
  status: DraftStatus;
  /** ISO timestamp once sent, else null. */
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /api/email/:accountId/drafts. */
export interface CreateDraftInput {
  threadId?: string | null;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject: string;
  body?: string;
  draftedByDroplet?: boolean;
}

/** Body for PATCH /api/email/drafts/:id (all fields optional). */
export interface PatchDraftInput {
  toAddrs?: string[];
  ccAddrs?: string[] | null;
  bccAddrs?: string[] | null;
  subject?: string;
  body?: string;
}

/**
 * The safety tier carried by each AI-suggested action, matching the backend's
 * literal vocabulary exactly (`email-analysis.service.ts` coerces to these two).
 */
export type ActionSafety = "Read" | "Write · confirm";

/** One AI-suggested next step, with its safety chip label. */
export interface SuggestedAction {
  label: string;
  safety: ActionSafety;
}

/** One named callout (entity / date / deadline / amount / ask). */
export interface AnalysisCallout {
  label: string;
}

/** Cross-system references the analysis surfaced. */
export interface RelatedReferences {
  files: string[];
  threads: string[];
  cameras: string[];
  tools: string[];
}

/** The AI side-panel payload from GET /threads/:id/analysis. */
export interface ThreadAnalysis {
  summary: string;
  callouts: AnalysisCallout[];
  suggestedActions: SuggestedAction[];
  related: RelatedReferences;
}

/**
 * Typed result of POST /drafts/:id/send. We never throw the server's 451 as a
 * raw error — instead we return a discriminated result so the UI can render a
 * calm, actionable "outbound email is off-LAN" message. A genuine transport /
 * server error still throws.
 *
 * - `queued`          — the happy path (HTTP 202): the draft is enqueued.
 * - `off_lan_blocked` — HTTP 451: outbound email is disabled by the off-LAN
 *                       allowlist; carries the server's friendly message.
 */
export type SendDraftResult =
  | { status: "queued"; id: string }
  | { status: "off_lan_blocked"; message: string; channel: string };
