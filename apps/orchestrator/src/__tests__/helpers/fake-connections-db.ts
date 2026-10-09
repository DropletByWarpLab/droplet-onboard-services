/**
 * WARP-3904 — an in-memory Prisma double for the connect-from-chat suites.
 *
 * It answers exactly the reads `connections-overview.service`,
 * `connect-card.service` and `routes/connections` make over the five families
 * (Google, Microsoft 365, mailbox, calendar feed, catalog provider), plus the
 * `resolveAssertedUser` lookup. Two properties matter for what the suites
 * prove:
 *
 *   - `select` is HONOURED. A real Prisma client returns only the selected
 *     columns, so a service that selects a ciphertext column "to compare it"
 *     and then spreads the row would leak here exactly as it would in
 *     production. A double that returned every column regardless would let
 *     that through.
 *   - Rows carry secret-looking VALUES by default (`tokenEnc`, `passwordEnc`,
 *     `apiCredentialsEnc`, a vendor error with a token in it), so a response
 *     that serializes one fails an assertion on the value, not on a field name.
 */
import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

export const SECRET_TOKEN = "ya29.A0ARrdaM-SECRET-ACCESS-TOKEN";
export const SECRET_CIPHERTEXT = "gho_SECRETCIPHERTEXT0123456789abcdef";
export const SECRET_PASSWORD = "hunter2-correct-horse-battery-staple";
export const VENDOR_ERROR = `401 Unauthorized: invalid_grant for token ${SECRET_TOKEN}`;

export interface ConnectionsWorld {
  users: Row[];
  google: Row[];
  m365: Row[];
  cursors: Row[];
  mailboxes: Row[];
  sources: Row[];
  integrations: Row[];
}

// ── seed builders ────────────────────────────────────────────────────────

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

export const userRow = (over: Row = {}): Row => {
  const id = (over.id as string | undefined) ?? nextId("user");
  return { id, username: `name-${id}`, nextcloudUsername: null, role: "owner", displayName: "Test person", email: null, directoryStatus: "ACTIVE", ...over };
};

export const googleRow = (userId: string, over: Row = {}): Row => ({
  id: nextId("g"),
  userId,
  state: "CONNECTED",
  accountAddress: "person@gmail.com",
  connectedAt: new Date("2026-10-01T09:00:00Z"),
  lastError: VENDOR_ERROR,
  emailAccountId: null,
  mailEnabled: true,
  calendarEnabled: false,
  calendarSyncState: "DISCONNECTED",
  calendarSourceId: null,
  tokenEnc: SECRET_CIPHERTEXT,
  pendingStateHash: null,
  pendingFlowEnc: SECRET_CIPHERTEXT,
  pendingExpiresAt: null,
  ...over,
});

export const m365Row = (userId: string, over: Row = {}): Row => ({
  id: nextId("m"),
  userId,
  state: "CONNECTED",
  accountUpn: "person@contoso.example",
  tenantId: "tenant-1",
  grantedScopes: "Mail.Read Calendars.Read offline_access",
  connectedAt: new Date("2026-10-01T09:00:00Z"),
  lastRefreshOkAt: new Date("2026-10-08T08:00:00Z"),
  lastError: VENDOR_ERROR,
  pendingFlowExpiresAt: null,
  homeAccountId: "home-1",
  tokenCacheEnc: SECRET_CIPHERTEXT,
  appClientId: null,
  appTenantId: null,
  sharePointEnabled: false,
  calendarEnabled: false,
  calendarSourceId: null,
  calendarSyncState: "DISCONNECTED",
  mailEnabled: true,
  emailAccountId: null,
  mailSyncState: "CONNECTED",
  ...over,
});

export const cursorRow = (userId: string, workload: string, state: string): Row => ({ id: nextId("cur"), userId, workload, state, resourceId: "r", deltaLink: SECRET_CIPHERTEXT });

export const mailboxRow = (over: Row = {}): Row => ({
  id: nextId("mbx"),
  userId: null,
  displayName: "Front desk",
  address: "desk@northgate.example",
  imapHost: "mail.northgate.example",
  smtpHost: "smtp.northgate.example",
  username: "NORTHGATE-frontdesk",
  passwordEnc: SECRET_CIPHERTEXT,
  authMode: "PASSWORD",
  imapStatus: "idle",
  lastIdleAt: new Date("2026-10-08T11:00:00Z"),
  lastErrorAt: null,
  lastError: VENDOR_ERROR,
  ...over,
});

export const sourceRow = (userId: string, over: Row = {}): Row => ({
  id: nextId("src"),
  userId,
  name: "Personal iCloud",
  url: "https://caldav.icloud.example/dav/cal",
  authMode: "basic",
  username: "me@icloud.example",
  passwordEnc: SECRET_CIPHERTEXT,
  lastSyncAt: new Date("2026-10-08T10:00:00Z"),
  lastSyncError: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

export const integrationRow = (provider: string, status: string, over: Row = {}): Row => ({
  id: nextId("int"),
  provider,
  status,
  lastHealthyAt: new Date("2026-10-08T09:30:00Z"),
  apiCredentialsEnc: SECRET_CIPHERTEXT,
  providerTokensEnc: null,
  lastError: VENDOR_ERROR,
  ...over,
});

// ── matching ─────────────────────────────────────────────────────────────

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((choice) => matches(row, choice));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return (value as { in: unknown[] }).in.includes(row[key]);
      if ("not" in value) return row[key] !== (value as { not: unknown }).not;
      return false;
    }
    return row[key] === value;
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
  return out;
}

function sorted(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [[key, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const av = a[key] instanceof Date ? a[key].getTime() : a[key];
    const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "desc" ? -cmp : cmp;
  });
}

/** `findMany` · `findFirst` · `findUnique` over one in-memory table. */
function table(rows: () => Row[]) {
  const find = (args: Row = {}): Row[] => sorted(rows().filter((row) => matches(row, args.where)), args.orderBy);
  return {
    findMany: vi.fn(async (args: Row = {}) => {
      const found = find(args).map((row) => pick(row, args.select));
      return typeof args.take === "number" ? found.slice(0, args.take) : found;
    }),
    findFirst: vi.fn(async (args: Row = {}) => {
      const [first] = find(args);
      return first ? pick(first, args.select) : null;
    }),
    findUnique: vi.fn(async (args: Row = {}) => {
      const [first] = find(args);
      return first ? pick(first, args.select) : null;
    }),
  };
}

// ── the double ───────────────────────────────────────────────────────────

export function fakeConnectionsDb(seed: Partial<ConnectionsWorld> = {}) {
  const world: ConnectionsWorld = { users: [], google: [], m365: [], cursors: [], mailboxes: [], sources: [], integrations: [], ...seed };
  const db = {
    user: table(() => world.users),
    googleConnection: table(() => world.google),
    m365Connection: table(() => world.m365),
    m365DeltaCursor: table(() => world.cursors),
    emailAccount: table(() => world.mailboxes),
    calendarSource: table(() => world.sources),
    integrationConnection: table(() => world.integrations),
    calendarEvent: { count: vi.fn(async () => 0) },
    emailMessage: { count: vi.fn(async () => 0) },
  };
  return { world, db, prisma: db as unknown as PrismaClient };
}

/** Every model method that was called, for "a guest never reaches the database". */
export function totalCalls(db: ReturnType<typeof fakeConnectionsDb>["db"]): number {
  let n = 0;
  for (const model of Object.values(db)) for (const fn of Object.values(model)) n += (fn as { mock: { calls: unknown[] } }).mock.calls.length;
  return n;
}
