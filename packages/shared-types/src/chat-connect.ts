/**
 * WARP-3904 — connect from chat.
 *
 * Two tool-result descriptors let a person add, check and remove connections
 * from Ask AI the way they would in the Integrations hub or Settings:
 *
 *   - `connections_overview` — what is connected across every family (mailbox,
 *     Google, Microsoft 365, calendar feed, catalog provider) with ONE
 *     normalized status vocabulary, plus what is available to add.
 *   - `connect_card` — how to add one provider: which fields the form shows,
 *     which safety chip it wears, where the browser posts, and what blocks it.
 *
 * These are DESCRIPTORS, not credentials and not byte routes. A tool returns a
 * descriptor; the dashboard renders a card from it; the card's form posts
 * straight from the browser to the same REST route the hub uses today, which
 * enforces its own role guard and egress allowlist. Nothing typed into the card
 * ever enters the SSE stream, the persisted transcript, or the model prompt.
 * The model only ever learns "connected" or "connection failed · <code>".
 *
 * Producers (orchestrator `connections` routes, called by tools-core handlers)
 * build descriptors with the helpers below. Consumers (the dashboard) run
 * untrusted tool-result data through `parseConnectCard` /
 * `parseConnectionsOverview`, which re-validate every path and refuse any
 * secret-shaped default — persisted tool calls and model-shaped data are not
 * trusted just because a tool "should" have produced them (same stance as
 * chat-media.ts).
 */

// ── Vocabulary ───────────────────────────────────────────────────────────

/** Which store a connection lives in. One per Prisma family. */
export type ConnectionFamily = "google" | "m365" | "mailbox" | "calendar" | "integration";

/** Who the connection belongs to. Box-wide rows need owner/admin to add or remove. */
export type ConnectionScope = "box" | "personal";

/**
 * One status vocabulary over five families. The mapping from each family's
 * own enum lives in the orchestrator (connections-overview.service.ts) and is
 * the only place that knows `DRIFT_LOCKED` or `RESYNC_REQUIRED` exist.
 *
 *   connected        reading normally
 *   needs_attention  a person has to act: reconnect, fix a key, resolve drift
 *   pending          waiting on consent, provisioning, or a first sync
 *   off              deliberately paused or disabled; nothing is wrong
 *   not_connected    row exists but holds no working credential
 */
export type ConnectionStatus = "connected" | "needs_attention" | "pending" | "off" | "not_connected";

/**
 * Safety chip for the connect step. Compositional, like the models brief:
 *   setup-lan       "Setup · stays on your box"      target is on the LAN
 *   setup-internet  "Setup · uses your internet"     target is a cloud host
 */
export type ConnectSafety = "setup-lan" | "setup-internet";

/** How the card collects what the provider needs. */
export type ConnectMode = "credentials" | "oauth" | "mailbox" | "calendar" | "wizard";

/** Why a card renders blocked instead of a form. */
export type ConnectBlockedReason = "role" | "already_connected" | "setup_required" | "unavailable";

export const CONNECTION_FAMILIES: readonly ConnectionFamily[] = ["google", "m365", "mailbox", "calendar", "integration"];
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = ["connected", "needs_attention", "pending", "off", "not_connected"];
export const CONNECT_SAFETIES: readonly ConnectSafety[] = ["setup-lan", "setup-internet"];
export const CONNECT_MODES: readonly ConnectMode[] = ["credentials", "oauth", "mailbox", "calendar", "wizard"];
export const CONNECT_BLOCKED_REASONS: readonly ConnectBlockedReason[] = ["role", "already_connected", "setup_required", "unavailable"];

/** Provider keys are catalog ids or the four family singletons. */
export const CONNECTION_PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── connections_overview ─────────────────────────────────────────────────

export interface ConnectionRow {
  /** Stable row id: `<family>:<provider-or-record-id>`. */
  id: string;
  family: ConnectionFamily;
  /** `google` · `m365` · `mailbox` · `calendar` · or a catalog provider id such as `stripe`. */
  provider: string;
  displayName: string;
  /** Account label, address or host. Never a secret, never a raw vendor error. */
  detail?: string;
  scope: ConnectionScope;
  status: ConnectionStatus;
  /** One human line for `needs_attention` / `pending` / `off`. */
  statusDetail?: string;
  /** What Droplet reads through it, lower-case nouns: `mail`, `calendar`, `payouts`. */
  capabilities: string[];
  /** ISO timestamp of the last successful sync, when the family tracks one. */
  lastSyncAt?: string;
  /** Same-origin dashboard path where the row is managed. */
  manageHref: string;
  /** The acting person may remove it from chat (`disconnect_connection`). */
  canDisconnect: boolean;
  /** A fresh sign-in is the right fix (OAuth families in `needs_attention`). */
  canReconnect: boolean;
}

export interface AvailableConnection {
  provider: string;
  family: ConnectionFamily;
  displayName: string;
  category?: string;
  scope: ConnectionScope;
  /** False when the acting person's role cannot add it; the card explains. */
  canConnect: boolean;
}

export interface ConnectionsOverview {
  kind: "connections_overview";
  connected: ConnectionRow[];
  available: AvailableConnection[];
  counts: { connected: number; needsAttention: number; available: number };
  /** Owners and admins see box-wide rows; members only get them counted. */
  boxWideVisible: boolean;
}

// ── connect_card ─────────────────────────────────────────────────────────

export type ConnectFieldType = "text" | "password" | "email" | "url" | "number";

export interface ConnectField {
  /** Key in the POST body. */
  name: string;
  label: string;
  type: ConnectFieldType;
  required: boolean;
  /** Masked in the form, never echoed, never defaulted. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Pre-filled value for a NON-secret field (port 993). Refused on secrets. */
  defaultValue?: string;
  /** Regex source string, applied client-side before posting. */
  pattern?: string;
}

/** A tickable scope on an OAuth card (`mail`, `calendar`, `files`). */
export interface ConnectOption {
  /** Key in the start body. */
  name: string;
  label: string;
  help?: string;
  defaultChecked: boolean;
}

export interface ConnectCardBlocked {
  reason: ConnectBlockedReason;
  /** One or two sentences in the brand voice. */
  message: string;
  requiredRole?: "owner" | "admin";
}

interface ConnectCardBase {
  kind: "connect_card";
  provider: string;
  family: ConnectionFamily;
  displayName: string;
  category?: string;
  scope: ConnectionScope;
  /** What Droplet will read, one line: "Reads payouts, charges, customers · polled every 15 min". */
  summary: string;
  safety: ConnectSafety;
  /** Same-origin help page, usually `/help/integrations/<provider>`. */
  helpHref?: string;
  /** Same-origin page where the connection is managed afterwards. */
  manageHref: string;
  /** Present when the acting person cannot proceed; the card renders the message instead of a form. */
  blocked?: ConnectCardBlocked;
}

/**
 * Catalog providers (ADR-041 cloud, ADR-046 REST, ADR-043 MCP). The browser
 * posts `{ [field.name]: value }` (plus `variant` when one was picked) to
 * `post.path`, exactly as the hub's ConnectWizard does.
 */
export interface CredentialsConnectCard extends ConnectCardBase {
  mode: "credentials";
  fields: ConnectField[];
  /** Credential variants (Xero: custom connection vs PKCE app). Each adds fields to the base set. */
  variants?: Array<{ id: string; label: string; description?: string; fields: ConnectField[] }>;
  post: { path: string };
}

/**
 * Google and Microsoft 365. The browser posts `{ ...options, returnTo: "/chat" }`
 * to `start.path`, receives `{ authorizeUrl }`, and leaves for the provider.
 * The callback lands on the box and redirects to `/chat?<provider>=<outcome>`.
 */
export interface OauthConnectCard extends ConnectCardBase {
  mode: "oauth";
  options: ConnectOption[];
  start: { path: string };
  /** Provider label for the button: "Google" / "Microsoft". */
  providerLabel: string;
}

/** IMAP/SMTP mailbox on the person's own server. Posts to `/api/email/accounts`. */
export interface MailboxConnectCard extends ConnectCardBase {
  mode: "mailbox";
  fields: ConnectField[];
  post: { path: string };
}

/** CalDAV or ICS subscription. Posts to `/api/calendar/sources`. */
export interface CalendarConnectCard extends ConnectCardBase {
  mode: "calendar";
  fields: ConnectField[];
  post: { path: string };
}

/** LAN providers whose flow is too long for a card (Eaglesoft). Hands off to the hub wizard. */
export interface WizardConnectCard extends ConnectCardBase {
  mode: "wizard";
  steps: string[];
  /** "about 10 minutes" */
  estimate?: string;
  wizardHref: string;
}

export type ConnectCard =
  | CredentialsConnectCard
  | OauthConnectCard
  | MailboxConnectCard
  | CalendarConnectCard
  | WizardConnectCard;

/** Result of `disconnect_connection` once the approval has been given and the family has purged. */
export interface ConnectionDisconnected {
  kind: "connection_disconnected";
  provider: string;
  family: ConnectionFamily;
  displayName: string;
}

// ── Allowlisted POST targets ─────────────────────────────────────────────

/**
 * The only places a card may post. The hub posts to these today; the card
 * adds no new write surface. A descriptor naming anything else is dropped by
 * the parser, so a persisted or model-shaped card cannot redirect a secret.
 */
export const CONNECT_POST_PATH_RES: readonly RegExp[] = [
  /^\/api\/integrations\/[a-z0-9][a-z0-9-]{0,63}\/connect$/,
  /^\/api\/email\/accounts$/,
  /^\/api\/calendar\/sources$/,
];
export const CONNECT_OAUTH_START_PATHS: readonly string[] = ["/api/google/connect", "/api/m365/connect"];

/** Same-origin dashboard path: starts with one `/`, no scheme, no `..`, no control characters. */
export function isSafeDashboardHref(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0 || u.length > 2048) return false;
  if (!u.startsWith("/") || u.startsWith("//")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(u)) return false;
  const pathOnly = u.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return false;
  }
  return !decoded.split("/").includes("..");
}

/** The one connect route a credentials card for `provider` may post to. */
export function credentialsConnectPath(provider: string): string {
  return `/api/integrations/${provider}/connect`;
}

export function isAllowedConnectPostPath(p: unknown): p is string {
  return typeof p === "string" && CONNECT_POST_PATH_RES.some((re) => re.test(p));
}

export function isAllowedOauthStartPath(p: unknown): p is string {
  return typeof p === "string" && CONNECT_OAUTH_START_PATHS.includes(p);
}

// ── Parsers (consumer side) ──────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = 512): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function optStr(v: unknown, max = 512): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}
function oneOf<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}
function strList(v: unknown, max = 32): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, max);
}

export const CONNECT_FIELD_TYPES: readonly ConnectFieldType[] = ["text", "password", "email", "url", "number"];

export function parseConnectField(v: unknown): ConnectField | null {
  if (!isRecord(v)) return null;
  const name = str(v.name, 64);
  const label = str(v.label, 120);
  if (!name || !label || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) return null;
  if (!oneOf(v.type, CONNECT_FIELD_TYPES)) return null;
  const secret = v.secret === true || v.type === "password";
  const field: ConnectField = {
    name,
    label,
    type: secret ? "password" : v.type,
    required: v.required === true,
    secret,
  };
  const placeholder = optStr(v.placeholder, 160);
  if (placeholder) field.placeholder = placeholder;
  const help = optStr(v.help, 400);
  if (help) field.help = help;
  // A secret may never arrive pre-filled: that would be a credential on the wire.
  const defaultValue = secret ? undefined : optStr(v.defaultValue, 256);
  if (defaultValue) field.defaultValue = defaultValue;
  const pattern = optStr(v.pattern, 256);
  if (pattern) {
    try {
      new RegExp(pattern);
      field.pattern = pattern;
    } catch {
      /* drop an unparseable pattern rather than the field */
    }
  }
  return field;
}

function parseFields(v: unknown, max = 24): ConnectField[] {
  if (!Array.isArray(v)) return [];
  const out: ConnectField[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const f = parseConnectField(item);
    if (f && !seen.has(f.name)) {
      seen.add(f.name);
      out.push(f);
    }
    if (out.length >= max) break;
  }
  return out;
}

function parseBlocked(v: unknown): ConnectCardBlocked | undefined {
  if (!isRecord(v)) return undefined;
  if (!oneOf(v.reason, CONNECT_BLOCKED_REASONS)) return undefined;
  const message = str(v.message, 600);
  if (!message) return undefined;
  const blocked: ConnectCardBlocked = { reason: v.reason, message };
  if (v.requiredRole === "owner" || v.requiredRole === "admin") blocked.requiredRole = v.requiredRole;
  return blocked;
}

/**
 * Null when the data is not a connect card, or is one whose paths would let a
 * form post anywhere but the allowlisted routes. Unknown keys are dropped.
 */
export function parseConnectCard(data: unknown): ConnectCard | null {
  if (!isRecord(data) || data.kind !== "connect_card") return null;
  const provider = str(data.provider, 64);
  const displayName = str(data.displayName, 120);
  const summary = str(data.summary, 400);
  if (!provider || !CONNECTION_PROVIDER_RE.test(provider) || !displayName || !summary) return null;
  if (!oneOf(data.family, CONNECTION_FAMILIES)) return null;
  if (!oneOf(data.scope, ["box", "personal"] as const)) return null;
  if (!oneOf(data.safety, CONNECT_SAFETIES)) return null;
  if (!oneOf(data.mode, CONNECT_MODES)) return null;
  if (!isSafeDashboardHref(data.manageHref)) return null;

  const base: ConnectCardBase = {
    kind: "connect_card",
    provider,
    family: data.family,
    displayName,
    scope: data.scope,
    summary,
    safety: data.safety,
    manageHref: data.manageHref,
  };
  const category = optStr(data.category, 64);
  if (category) base.category = category;
  if (isSafeDashboardHref(data.helpHref)) base.helpHref = data.helpHref;
  const blocked = parseBlocked(data.blocked);
  if (blocked) base.blocked = blocked;

  switch (data.mode) {
    case "credentials": {
      const post = isRecord(data.post) ? data.post.path : undefined;
      if (!isAllowedConnectPostPath(post)) return null;
      // Its OWN provider's route, not merely an allowlisted one: the dashboard
      // derives the credential-save target from this path, so a card for
      // "stripe" that named another provider's connect route would save the
      // typed key under that provider.
      if (post !== credentialsConnectPath(provider)) return null;
      const card: CredentialsConnectCard = { ...base, mode: "credentials", fields: parseFields(data.fields), post: { path: post } };
      if (Array.isArray(data.variants)) {
        const variants: NonNullable<CredentialsConnectCard["variants"]> = [];
        for (const raw of data.variants.slice(0, 8)) {
          if (!isRecord(raw)) continue;
          const id = str(raw.id, 64);
          const label = str(raw.label, 120);
          if (!id || !label || !CONNECTION_PROVIDER_RE.test(id)) continue;
          const variant: (typeof variants)[number] = { id, label, fields: parseFields(raw.fields) };
          const description = optStr(raw.description, 400);
          if (description) variant.description = description;
          variants.push(variant);
        }
        if (variants.length > 0) card.variants = variants;
      }
      return card;
    }
    case "oauth": {
      const start = isRecord(data.start) ? data.start.path : undefined;
      if (!isAllowedOauthStartPath(start)) return null;
      const providerLabel = str(data.providerLabel, 40);
      if (!providerLabel) return null;
      const options: ConnectOption[] = [];
      if (Array.isArray(data.options)) {
        for (const raw of data.options.slice(0, 8)) {
          if (!isRecord(raw)) continue;
          const name = str(raw.name, 32);
          const label = str(raw.label, 80);
          if (!name || !label || !/^[a-z][a-zA-Z0-9]{0,31}$/.test(name)) continue;
          const option: ConnectOption = { name, label, defaultChecked: raw.defaultChecked === true };
          const help = optStr(raw.help, 200);
          if (help) option.help = help;
          options.push(option);
        }
      }
      return { ...base, mode: "oauth", options, start: { path: start }, providerLabel };
    }
    case "mailbox":
    case "calendar": {
      const post = isRecord(data.post) ? data.post.path : undefined;
      if (!isAllowedConnectPostPath(post)) return null;
      const expected = data.mode === "mailbox" ? "/api/email/accounts" : "/api/calendar/sources";
      if (post !== expected) return null;
      return { ...base, mode: data.mode, fields: parseFields(data.fields), post: { path: post } };
    }
    case "wizard": {
      if (!isSafeDashboardHref(data.wizardHref)) return null;
      const card: WizardConnectCard = { ...base, mode: "wizard", steps: strList(data.steps, 8), wizardHref: data.wizardHref };
      const estimate = optStr(data.estimate, 60);
      if (estimate) card.estimate = estimate;
      return card;
    }
    default:
      return null;
  }
}

export function parseConnectionRow(v: unknown): ConnectionRow | null {
  if (!isRecord(v)) return null;
  const id = str(v.id, 160);
  const provider = str(v.provider, 64);
  const displayName = str(v.displayName, 120);
  if (!id || !provider || !CONNECTION_PROVIDER_RE.test(provider) || !displayName) return null;
  if (!oneOf(v.family, CONNECTION_FAMILIES)) return null;
  if (!oneOf(v.scope, ["box", "personal"] as const)) return null;
  if (!oneOf(v.status, CONNECTION_STATUSES)) return null;
  if (!isSafeDashboardHref(v.manageHref)) return null;
  const row: ConnectionRow = {
    id,
    family: v.family,
    provider,
    displayName,
    scope: v.scope,
    status: v.status,
    capabilities: strList(v.capabilities, 16),
    manageHref: v.manageHref,
    canDisconnect: v.canDisconnect === true,
    canReconnect: v.canReconnect === true,
  };
  const detail = optStr(v.detail, 200);
  if (detail) row.detail = detail;
  const statusDetail = optStr(v.statusDetail, 300);
  if (statusDetail) row.statusDetail = statusDetail;
  const lastSyncAt = optStr(v.lastSyncAt, 40);
  if (lastSyncAt && !Number.isNaN(Date.parse(lastSyncAt))) row.lastSyncAt = lastSyncAt;
  return row;
}

export function parseAvailableConnection(v: unknown): AvailableConnection | null {
  if (!isRecord(v)) return null;
  const provider = str(v.provider, 64);
  const displayName = str(v.displayName, 120);
  if (!provider || !CONNECTION_PROVIDER_RE.test(provider) || !displayName) return null;
  if (!oneOf(v.family, CONNECTION_FAMILIES)) return null;
  if (!oneOf(v.scope, ["box", "personal"] as const)) return null;
  const item: AvailableConnection = { provider, family: v.family, displayName, scope: v.scope, canConnect: v.canConnect === true };
  const category = optStr(v.category, 64);
  if (category) item.category = category;
  return item;
}

/** Null when the data is not an overview. Rows that fail validation are dropped, not the whole card. */
export function parseConnectionsOverview(data: unknown): ConnectionsOverview | null {
  if (!isRecord(data) || data.kind !== "connections_overview") return null;
  const connected = Array.isArray(data.connected)
    ? data.connected.map(parseConnectionRow).filter((r): r is ConnectionRow => r !== null).slice(0, 64)
    : [];
  const available = Array.isArray(data.available)
    ? data.available.map(parseAvailableConnection).filter((r): r is AvailableConnection => r !== null).slice(0, 64)
    : [];
  const needsAttention = connected.filter((r) => r.status === "needs_attention").length;
  return {
    kind: "connections_overview",
    connected,
    available,
    counts: { connected: connected.length, needsAttention, available: available.length },
    boxWideVisible: data.boxWideVisible === true,
  };
}

export function parseConnectionDisconnected(data: unknown): ConnectionDisconnected | null {
  if (!isRecord(data) || data.kind !== "connection_disconnected") return null;
  const provider = str(data.provider, 64);
  const displayName = str(data.displayName, 120);
  if (!provider || !CONNECTION_PROVIDER_RE.test(provider) || !displayName) return null;
  if (!oneOf(data.family, CONNECTION_FAMILIES)) return null;
  return { kind: "connection_disconnected", provider, family: data.family, displayName };
}

// ── Chip copy (one place, both apps) ─────────────────────────────────────

export const CONNECT_SAFETY_LABEL: Record<ConnectSafety, string> = {
  "setup-lan": "Setup · stays on your box",
  "setup-internet": "Setup · uses your internet",
};

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  pending: "Pending",
  off: "Off",
  not_connected: "Not connected",
};

/**
 * The quiet follow-up turn the dashboard sends after a card resolves, so the
 * model can continue without a secret or a vendor body ever reaching it.
 * Mirrors the approval path's "I approved that — go ahead." convention.
 */
export function connectOutcomeTurn(displayName: string, outcome: "connected" | "failed" | "cancelled", code?: string): string {
  switch (outcome) {
    case "connected":
      return `${displayName} is connected now.`;
    case "failed":
      return code ? `Connecting ${displayName} failed (${code}).` : `Connecting ${displayName} failed.`;
    case "cancelled":
      return `I didn't connect ${displayName}.`;
  }
}
