/**
 * WARP-3904 — one normalized view over the five places a connection lives.
 *
 *   google       GoogleConnection        personal   (one per person)
 *   m365         M365Connection          personal   (one per person)
 *   mailbox      EmailAccount (PASSWORD) box-wide   (IMAP/SMTP on the person's own server)
 *   calendar     CalendarSource          personal   (CalDAV / ICS feed)
 *   integration  IntegrationConnection   box-wide   (catalog providers)
 *
 * Each family keeps its own state enum; this is the only module that maps them
 * onto the shared `ConnectionStatus` vocabulary, and the only one that knows
 * `DRIFT_LOCKED` or `RESYNC_REQUIRED` exist from a chat's point of view.
 *
 * What it never does: put a token, a key, a host password, a ciphertext column
 * or a vendor's raw error text into a row. `lastError` / `lastSyncError` are
 * read to learn THAT something failed, then replaced by a short fixed line.
 *
 * Visibility: owners and admins see box-wide rows; everyone else sees only
 * their own personal connections. Guests and service principals get nothing.
 */
import type { PrismaClient } from "@prisma/client";
import {
  providerDescriptor,
  providerDescriptors,
  isProbedOnConnect,
  type AvailableConnection,
  type ConnectionRow,
  type ConnectionStatus,
  type ConnectionsOverview,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import { getGoogleConnectionView } from "./google/google-auth.service.js";
import { getConnectionView as getM365ConnectionView } from "./m365/m365-auth.service.js";
import { credentialsPurgedFor } from "./integration-status.js";

/** Roles that may hold a personal Google / Microsoft 365 / calendar connection.
 *  The same set `routes/google.ts` and `routes/m365.ts` guard their connect routes with. */
export const PERSONAL_CONNECT_ROLES: readonly string[] = ["owner", "admin", "family"];
/** Roles that may add or remove a box-wide connection (mailbox, catalog provider). */
export const BOX_CONNECT_ROLES: readonly string[] = ["owner", "admin"];

export interface ConnectionsActor {
  id: string;
  role: string;
  /** `User.username` — calendar sources are keyed on it. Looked up from `id` when absent. */
  username?: string;
}

/** The same cap `parseConnectionsOverview` applies on the consumer side. */
const MAX_ROWS = 64;
const MAX_CAPABILITIES = 6;

export const GOOGLE_DISPLAY_NAME = "Google";
export const M365_DISPLAY_NAME = "Microsoft 365";
export const MAILBOX_DISPLAY_NAME = "Mailbox";
export const CALENDAR_DISPLAY_NAME = "Calendar feed";

export const MANAGE_HREF = {
  google: "/settings#connected-accounts",
  m365: "/settings#connected-accounts",
  mailbox: "/settings#email",
  calendar: "/calendar",
  integration: "/integrations",
} as const;

/** CalendarSource.authMode values a person creates by hand; `google_oauth` / `m365_oauth` belong to those families. */
export const CALENDAR_FEED_AUTH_MODES = ["none", "basic"] as const;

const STATUS_LINE = {
  signInAgain: "Sign in again to resume",
  signingIn: "Waiting for you to finish signing in",
  syncFailed: "The last sync failed; Droplet will retry",
  paused: "Paused",
  settingUp: "Setting up — Droplet is checking the connection",
  reconnecting: "Reconnecting to the mail server",
  mailboxError: "Droplet could not sign in to the mail server",
  limited: "Connected — your plan or permissions withhold one kind of record",
  drift: "The system's data layout changed — an admin needs to review it",
  keyStopped: "The key stopped working — paste a new one to resume",
  integrationError: "Droplet cannot connect — check the setup in Integrations",
} as const;

/** A fresh object per call: a spread copies the top level only, so a caller that appended to one guest's arrays would change the next guest's. */
function emptyOverview(): ConnectionsOverview {
  return {
    kind: "connections_overview",
    connected: [],
    available: [],
    counts: { connected: 0, needsAttention: 0, available: 0 },
    boxWideVisible: false,
  };
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function iso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

function latest(...dates: Array<Date | null | undefined>): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
}

/** "payouts", "ap summaries" — the short nouns a descriptor's datasets read as. */
export function datasetNoun(name: string): string {
  const words = name.replace(/_/g, " ");
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`;
  return words.endsWith("s") ? words : `${words}s`;
}

export function descriptorCapabilities(descriptor: ProviderDescriptor | undefined): string[] {
  if (!descriptor) return [];
  return descriptor.datasets.map(datasetNoun).slice(0, MAX_CAPABILITIES);
}

/** The hub card for a descriptor is offered unless the catalog marks it coming soon. */
export function isCatalogAvailable(descriptor: ProviderDescriptor): boolean {
  return descriptor.catalog?.availability !== "coming-soon";
}

/** Same rule as GET /api/integrations/catalog's `connectInput`: how a card collects what the provider needs. */
export type ConnectInputKind = "lan" | "lan_api" | "credentials" | "mcp" | null;
export function connectInputFor(descriptor: ProviderDescriptor): ConnectInputKind {
  if (descriptor.lanProvisioning) return "lan";
  if (descriptor.id === "eaglesoft-api") return "lan_api";
  if (descriptor.track === "mcp") return "mcp";
  return isProbedOnConnect(descriptor) ? "credentials" : null;
}

// ── google ───────────────────────────────────────────────────────────────

async function googleRow(prisma: PrismaClient, actor: ConnectionsActor): Promise<ConnectionRow | null> {
  const view = await getGoogleConnectionView(prisma, actor.id);
  if (view.state === "DISCONNECTED") return null;
  const capabilities = [...(view.mailEnabled ? ["mail"] : []), ...(view.calendarEnabled ? ["calendar"] : [])];
  let status: ConnectionStatus;
  let statusDetail: string | undefined;
  let canReconnect = false;
  switch (view.state) {
    case "CONNECTED":
      status = "connected";
      if (view.calendarEnabled && (view.calendar.state === "NEEDS_RECONNECT" || view.calendar.state === "ERROR")) {
        status = "needs_attention";
        statusDetail = "Calendar sync is paused — sign in again to resume";
        canReconnect = true;
      }
      break;
    case "NEEDS_RECONNECT":
    case "ERROR":
      status = "needs_attention";
      statusDetail = STATUS_LINE.signInAgain;
      canReconnect = true;
      break;
    case "PENDING_CONSENT":
      status = "pending";
      statusDetail = STATUS_LINE.signingIn;
      break;
  }
  const row: ConnectionRow = {
    id: "google:me",
    family: "google",
    provider: "google",
    displayName: GOOGLE_DISPLAY_NAME,
    scope: "personal",
    status,
    capabilities,
    manageHref: MANAGE_HREF.google,
    canDisconnect: true,
    canReconnect,
  };
  if (view.accountAddress) row.detail = clamp(view.accountAddress, 200);
  if (statusDetail) row.statusDetail = statusDetail;
  const lastSyncAt = iso(view.calendar.lastSyncAt);
  if (lastSyncAt) row.lastSyncAt = lastSyncAt;
  return row;
}

// ── m365 ─────────────────────────────────────────────────────────────────

/** Workloads a person can switch on, with the noun their pause is reported under. */
const M365_WORKLOAD_LABEL: Record<string, string> = { mail: "Mail", calendar: "Calendar", files: "Files", sharepoint: "Files" };

async function m365Row(prisma: PrismaClient, actor: ConnectionsActor): Promise<ConnectionRow | null> {
  const view = await getM365ConnectionView(prisma, actor.id);
  if (view.state === "DISCONNECTED") return null;
  const capabilities = [
    ...(view.mail.enabled ? ["mail"] : []),
    ...(view.calendar.enabled ? ["calendar"] : []),
    ...(view.sharePoint.enabled ? ["files"] : []),
  ];
  let status: ConnectionStatus;
  let statusDetail: string | undefined;
  let canReconnect = false;
  switch (view.state) {
    case "CONNECTED": {
      status = "connected";
      // Two kinds of paused workload, two different fixes (WARP-2462). A
      // workload whose grant stopped working needs the person to sign in
      // again, so the row offers Reconnect; one that backs off, must re-read,
      // or has failed mends itself, so the row only says so.
      const signIn = new Set<string>();
      if (view.mail.enabled && (view.mail.state === "NEEDS_RECONNECT" || view.mail.state === "ERROR")) signIn.add("Mail");
      if (view.calendar.enabled && (view.calendar.state === "NEEDS_RECONNECT" || view.calendar.state === "ERROR")) signIn.add("Calendar");
      const cursors = await prisma.m365DeltaCursor.findMany({
        where: { userId: actor.id, state: { in: ["BACKOFF", "RESYNC_REQUIRED", "FAILED"] } },
        select: { workload: true },
      });
      const retry = new Set<string>();
      for (const cursor of cursors) {
        const label = M365_WORKLOAD_LABEL[cursor.workload];
        if (label && !signIn.has(label)) retry.add(label);
      }
      const joinNames = (names: string[]) =>
        names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1].toLowerCase()}`;
      if (signIn.size > 0) {
        status = "needs_attention";
        statusDetail = `${joinNames([...signIn])} sync is paused — sign in again to resume`;
        canReconnect = true;
      } else if (retry.size > 0) {
        status = "needs_attention";
        statusDetail = `${joinNames([...retry])} sync is paused — Droplet will retry`;
      }
      break;
    }
    case "NEEDS_RECONNECT":
    case "ERROR":
      status = "needs_attention";
      statusDetail = STATUS_LINE.signInAgain;
      canReconnect = true;
      break;
    case "PENDING_CONSENT":
      status = "pending";
      statusDetail = STATUS_LINE.signingIn;
      break;
  }
  const row: ConnectionRow = {
    id: "m365:me",
    family: "m365",
    provider: "m365",
    displayName: M365_DISPLAY_NAME,
    scope: "personal",
    status,
    capabilities,
    manageHref: MANAGE_HREF.m365,
    canDisconnect: true,
    canReconnect,
  };
  if (view.accountUpn) row.detail = clamp(view.accountUpn, 200);
  if (statusDetail) row.statusDetail = statusDetail;
  const lastSyncAt = iso(latest(view.mail.lastSyncAt, view.calendar.lastSyncAt));
  if (lastSyncAt) row.lastSyncAt = lastSyncAt;
  return row;
}

// ── mailbox ──────────────────────────────────────────────────────────────

async function mailboxRows(prisma: PrismaClient): Promise<ConnectionRow[]> {
  const accounts = await prisma.emailAccount.findMany({
    // Google / Microsoft mailboxes are the google / m365 rows, not a second connection.
    where: { authMode: "PASSWORD" },
    orderBy: { address: "asc" },
    select: { id: true, address: true, imapStatus: true, lastIdleAt: true },
  });
  return accounts.map((account): ConnectionRow => {
    let status: ConnectionStatus;
    let statusDetail: string | undefined;
    switch (account.imapStatus) {
      case "idle":
        status = "connected";
        break;
      case "reconnecting":
        status = "pending";
        statusDetail = STATUS_LINE.reconnecting;
        break;
      case "error":
        status = "needs_attention";
        statusDetail = STATUS_LINE.mailboxError;
        break;
      case "paused":
        status = "off";
        statusDetail = STATUS_LINE.paused;
        break;
    }
    const row: ConnectionRow = {
      id: `mailbox:${account.id}`,
      family: "mailbox",
      provider: "mailbox",
      displayName: MAILBOX_DISPLAY_NAME,
      detail: clamp(account.address, 200),
      scope: "box",
      status,
      capabilities: ["mail"],
      manageHref: MANAGE_HREF.mailbox,
      canDisconnect: true,
      canReconnect: false,
    };
    if (statusDetail) row.statusDetail = statusDetail;
    const lastSyncAt = iso(account.lastIdleAt);
    if (lastSyncAt) row.lastSyncAt = lastSyncAt;
    return row;
  });
}

// ── calendar feeds ───────────────────────────────────────────────────────

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

async function calendarRows(prisma: PrismaClient, username: string): Promise<ConnectionRow[]> {
  const sources = await prisma.calendarSource.findMany({
    where: { userId: username, authMode: { in: [...CALENDAR_FEED_AUTH_MODES] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, url: true, lastSyncAt: true, lastSyncError: true },
  });
  return sources.map((source): ConnectionRow => {
    const host = hostOf(source.url);
    const failed = !!source.lastSyncError;
    const row: ConnectionRow = {
      id: `calendar:${source.id}`,
      family: "calendar",
      provider: "calendar",
      displayName: CALENDAR_DISPLAY_NAME,
      detail: clamp(host ? `${source.name} · ${host}` : source.name, 200),
      scope: "personal",
      status: failed ? "needs_attention" : "connected",
      capabilities: ["calendar"],
      manageHref: MANAGE_HREF.calendar,
      canDisconnect: true,
      canReconnect: false,
    };
    if (failed) row.statusDetail = STATUS_LINE.syncFailed;
    const lastSyncAt = iso(source.lastSyncAt);
    if (lastSyncAt) row.lastSyncAt = lastSyncAt;
    return row;
  });
}

// ── catalog providers ────────────────────────────────────────────────────

interface IntegrationRowFacts {
  provider: string;
  status: string;
  lastHealthyAt: Date | null;
  apiCredentialsEnc: string | null;
  providerTokensEnc: string | null;
}

/** The row's status in the shared vocabulary, with the line that explains it. */
export function integrationStatus(status: string): { status: ConnectionStatus; detail?: string } {
  switch (status) {
    case "CONNECTED":
      return { status: "connected" };
    case "CAPABILITY_LIMITED":
      return { status: "connected", detail: STATUS_LINE.limited };
    case "PROVISIONING":
      return { status: "pending", detail: STATUS_LINE.settingUp };
    case "DEGRADED":
      return { status: "needs_attention", detail: STATUS_LINE.syncFailed };
    case "DRIFT_LOCKED":
      return { status: "needs_attention", detail: STATUS_LINE.drift };
    case "NEEDS_RECONNECT":
      return { status: "needs_attention", detail: STATUS_LINE.keyStopped };
    case "ERROR":
      return { status: "needs_attention", detail: STATUS_LINE.integrationError };
    case "DISABLED":
      return { status: "off", detail: STATUS_LINE.paused };
    default:
      // NOT_CONFIGURED, and any status a newer build writes that this one does not know.
      return { status: "not_connected" };
  }
}

/** Rows that still stand for a connection: not a disconnect that already purged its credentials. */
function isLiveIntegrationRow(row: IntegrationRowFacts): boolean {
  return !credentialsPurgedFor({ status: row.status, apiCredentialsEnc: row.apiCredentialsEnc, providerTokensEnc: row.providerTokensEnc });
}

async function integrationRows(prisma: PrismaClient): Promise<IntegrationRowFacts[]> {
  const rows = await prisma.integrationConnection.findMany({
    orderBy: { provider: "asc" },
    // The credential columns are read ONLY so `credentialsPurgedFor` can tell a
    // disconnected provider from a paused one. Nothing below puts them in a row.
    select: { provider: true, status: true, lastHealthyAt: true, apiCredentialsEnc: true, providerTokensEnc: true },
  });
  return rows.filter(isLiveIntegrationRow);
}

function integrationConnectionRow(row: IntegrationRowFacts): ConnectionRow {
  const descriptor = providerDescriptor(row.provider);
  const mapped = integrationStatus(row.status);
  const out: ConnectionRow = {
    id: `integration:${row.provider}`,
    family: "integration",
    provider: row.provider,
    displayName: descriptor?.displayName ?? row.provider,
    scope: "box",
    status: mapped.status,
    capabilities: descriptorCapabilities(descriptor),
    manageHref: MANAGE_HREF.integration,
    // A row that holds no credential has nothing to disconnect.
    canDisconnect: row.status !== "NOT_CONFIGURED",
    canReconnect: false,
  };
  if (mapped.detail) out.statusDetail = mapped.detail;
  const lastSyncAt = iso(row.lastHealthyAt);
  if (lastSyncAt) out.lastSyncAt = lastSyncAt;
  return out;
}

/** Catalog providers a card can connect from chat and that have no standing connection. */
function availableIntegrations(rows: IntegrationRowFacts[]): AvailableConnection[] {
  const standing = new Set(rows.filter((r) => r.status !== "NOT_CONFIGURED").map((r) => r.provider));
  return providerDescriptors()
    .filter((d) => isCatalogAvailable(d) && connectInputFor(d) !== null && !standing.has(d.id))
    .map((d) => ({ provider: d.id, family: "integration" as const, displayName: d.displayName, category: d.category, scope: "box" as const, canConnect: true }));
}

// ── overview ─────────────────────────────────────────────────────────────

async function usernameOf(prisma: PrismaClient, actor: ConnectionsActor): Promise<string | null> {
  if (actor.username) return actor.username;
  const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { username: true } });
  return user?.username ?? null;
}

export async function buildConnectionsOverview(prisma: PrismaClient, actor: ConnectionsActor): Promise<ConnectionsOverview> {
  if (!PERSONAL_CONNECT_ROLES.includes(actor.role)) return emptyOverview();
  const boxWide = BOX_CONNECT_ROLES.includes(actor.role);
  const username = await usernameOf(prisma, actor);

  const [google, m365, calendars, mailboxes, integrations] = await Promise.all([
    googleRow(prisma, actor),
    m365Row(prisma, actor),
    username ? calendarRows(prisma, username) : Promise.resolve([]),
    boxWide ? mailboxRows(prisma) : Promise.resolve([]),
    boxWide ? integrationRows(prisma) : Promise.resolve([]),
  ]);

  const connected: ConnectionRow[] = [
    ...(google ? [google] : []),
    ...(m365 ? [m365] : []),
    ...mailboxes,
    ...calendars,
    ...integrations.map(integrationConnectionRow),
  ].slice(0, MAX_ROWS);

  const available: AvailableConnection[] = [
    ...(google ? [] : [{ provider: "google", family: "google" as const, displayName: GOOGLE_DISPLAY_NAME, category: "Mail and calendar", scope: "personal" as const, canConnect: true }]),
    ...(m365 ? [] : [{ provider: "m365", family: "m365" as const, displayName: M365_DISPLAY_NAME, category: "Mail and calendar", scope: "personal" as const, canConnect: true }]),
    ...(boxWide ? [{ provider: "mailbox", family: "mailbox" as const, displayName: MAILBOX_DISPLAY_NAME, category: "Mail", scope: "box" as const, canConnect: true }] : []),
    { provider: "calendar", family: "calendar" as const, displayName: CALENDAR_DISPLAY_NAME, category: "Calendar", scope: "personal" as const, canConnect: true },
    ...(boxWide ? availableIntegrations(integrations) : []),
  ].slice(0, MAX_ROWS);

  return {
    kind: "connections_overview",
    connected,
    available,
    counts: {
      connected: connected.length,
      needsAttention: connected.filter((r) => r.status === "needs_attention").length,
      available: available.length,
    },
    boxWideVisible: boxWide,
  };
}
