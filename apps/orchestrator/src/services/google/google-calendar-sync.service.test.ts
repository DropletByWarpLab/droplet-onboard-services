import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import type { ExternalCalendarEvent } from "../cloud-calendar-store.service.js";
import { fakeGoogleDb } from "./__tests__/fake-db.js";
import { beginGoogleConnect, completeGoogleConnect, disconnectGoogle, googleDependencies } from "./google-auth.service.js";
import { GoogleProviderError, type GoogleProvider } from "./google-client.js";
import { scopesForGoogleFeatures } from "./scopes.js";
import type { GoogleCalendarClient } from "./google-calendar-client.js";
import { googleCalendarWindow, syncGoogleCalendar, syncGoogleCalendars } from "./google-calendar-sync.service.js";

vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../email/provision.service.js", () => ({ requestIndexerRefresh: vi.fn(async () => true) }));
const userId = "user-1";
const features = { mail: false, calendar: true };
const now = new Date("2026-10-05T15:00:00Z");
const scopes = scopesForGoogleFeatures(features);
const calendarEvent: ExternalCalendarEvent = { externalUid: "event-1", title: "Planning",
  startsAt: new Date("2026-10-05T16:00:00Z"), endsAt: new Date("2026-10-05T17:00:00Z"), allDay: false };

async function setup() {
  const db = fakeGoogleDb();
  const provider: GoogleProvider = {
    getAuthorizationUrl: vi.fn((_app, { state }) => `https://accounts.google.com/authorize?state=${state}`),
    exchangeCode: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", grantedScopes: scopes })),
    getAccountAddress: vi.fn(async () => "person@example.com"),
    refresh: vi.fn(async () => ({ accessToken: "calendar-access", grantedScopes: scopes })), revoke: vi.fn(async () => {}),
  };
  const deps = googleDependencies({ provider, getApp: async () => ({ clientId: "customer-client", clientSecret: "customer-secret" }),
    now: () => now, mailboxAvailable: () => false, refreshIndexer: vi.fn(async () => true) });
  const start = await beginGoogleConnect(db.prisma, userId, "https://box.customer.com/api/google/callback", deps, features);
  expect(await completeGoogleConnect(db.prisma, { state: start.state, browserState: start.state, code: "code", error: null }, deps)).toBe("connected");
  const client: GoogleCalendarClient = { readPrimaryCalendar: vi.fn(async () => [calendarEvent]) };
  return { db, deps, provider, client, options: { ...deps, calendarClient: client } };
}

describe("Google Calendar source sync", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 11).toString("base64")));
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("lands a read-only snapshot under the canonical username and reports its first successful sync", async () => {
    const { db, options, client } = await setup();
    expect(db.connections()[0].calendarSyncState).toBe("WAITING");
    expect(await syncGoogleCalendar(db.prisma, userId, options)).toEqual({ state: "synced", eventCount: 1 });
    expect(client.readPrimaryCalendar).toHaveBeenCalledWith("calendar-access", {
      start: new Date("2025-10-05T15:00:00Z"), end: new Date("2027-10-05T15:00:00Z"),
    });
    expect(db.events()[0]).toMatchObject({ userId: "sam", source: "external", sourceId: db.sources()[0].id,
      externalUid: "event-1", title: "Planning" });
    expect(db.connections()[0].calendarSyncState).toBe("CONNECTED");
    expect(db.sources()[0]).toMatchObject({ lastSyncAt: now, lastSyncError: null });
    expect(db.accounts()).toHaveLength(0);
    expect(googleCalendarWindow(now).start.toISOString()).toBe("2025-10-05T15:00:00.000Z");
  });

  it("updates stable events, sweeps only this complete external snapshot and keeps local events", async () => {
    const { db, client, options } = await setup();
    await syncGoogleCalendar(db.prisma, userId, options);
    const id = db.events()[0].id;
    db.events().push({ id: "local-event", userId: "sam", source: "local", sourceId: null, externalUid: null, title: "Local" });
    vi.mocked(client.readPrimaryCalendar).mockResolvedValueOnce([{ ...calendarEvent, title: "Updated planning" }]);
    await syncGoogleCalendar(db.prisma, userId, options);
    expect(db.events().find((event) => event.id === id)?.title).toBe("Updated planning");
    vi.mocked(client.readPrimaryCalendar).mockResolvedValueOnce([]);
    await syncGoogleCalendar(db.prisma, userId, options);
    expect(db.events()).toEqual([expect.objectContaining({ id: "local-event" })]);
  });

  it("preserves the last complete snapshot on provider failure and redacts its error", async () => {
    const { db, client, options } = await setup();
    await syncGoogleCalendar(db.prisma, userId, options);
    vi.mocked(client.readPrimaryCalendar).mockRejectedValueOnce(new Error("PROVIDER_TOKEN_SECRET"));
    expect(await syncGoogleCalendar(db.prisma, userId, options)).toEqual({ state: "failed" });
    expect(db.events()).toHaveLength(1);
    expect(db.connections()[0]).toMatchObject({ state: "CONNECTED", calendarSyncState: "ERROR" });
    expect(db.sources()[0].lastSyncError).not.toContain("PROVIDER_TOKEN_SECRET");
  });

  it("a revoked refresh grant marks the account and calendar reconnect states without fetching", async () => {
    const { db, provider, client, options } = await setup();
    vi.mocked(provider.refresh).mockRejectedValueOnce(new GoogleProviderError(true));
    expect(await syncGoogleCalendar(db.prisma, userId, options)).toEqual({ state: "failed" });
    expect(db.connections()[0]).toMatchObject({ state: "NEEDS_RECONNECT", calendarSyncState: "NEEDS_RECONNECT", tokenEnc: null });
    expect(client.readPrimaryCalendar).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "deactivate", "remove-source", "re-consent"])("late snapshot cannot resurrect events after %s", async (action) => {
    const { db, deps, client, options } = await setup();
    let respond!: (events: ExternalCalendarEvent[]) => void;
    vi.mocked(client.readPrimaryCalendar).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const pending = syncGoogleCalendar(db.prisma, userId, options);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    if (action === "disconnect") await disconnectGoogle(db.prisma, userId, deps);
    if (action === "deactivate") db.users()[0].directoryStatus = "DEACTIVATED";
    if (action === "remove-source") {
      db.connections()[0].calendarEnabled = false;
      db.connections()[0].calendarSyncState = "DISCONNECTED";
      await db.calendarSource.deleteMany({ where: { id: db.sources()[0].id } });
    }
    if (action === "re-consent") {
      const start = await beginGoogleConnect(db.prisma, userId, "https://box.customer.com/api/google/callback", deps, features);
      await completeGoogleConnect(db.prisma, { state: start.state, browserState: start.state, code: "new-code", error: null }, deps);
    }
    respond([calendarEvent]);
    expect(await pending).toEqual({ state: "skipped" });
    expect(db.events()).toHaveLength(0);
    if (action === "disconnect" || action === "remove-source") expect(db.sources()).toHaveLength(0);
  });

  it("deduplicates overlapping scheduled work and the next cron only considers opted-in active links", async () => {
    const { db, client, options } = await setup();
    let respond!: (events: ExternalCalendarEvent[]) => void;
    vi.mocked(client.readPrimaryCalendar).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const first = syncGoogleCalendar(db.prisma, userId, options);
    const second = syncGoogleCalendar(db.prisma, userId, options);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    expect(client.readPrimaryCalendar).toHaveBeenCalledOnce();
    respond([calendarEvent]);
    expect(await first).toEqual(await second);
    db.connections()[0].calendarEnabled = false;
    await syncGoogleCalendars(db.prisma, options);
    expect(client.readPrimaryCalendar).toHaveBeenCalledOnce();
  });

  it("disconnect purges source and external events but preserves local calendar events", async () => {
    const { db, deps, options } = await setup();
    await syncGoogleCalendar(db.prisma, userId, options);
    db.events().push({ id: "local-event", userId: "sam", source: "local", sourceId: null, externalUid: null });
    await disconnectGoogle(db.prisma, userId, deps);
    expect(db.sources()).toHaveLength(0);
    expect(db.events()).toEqual([expect.objectContaining({ id: "local-event" })]);
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
  });
});
