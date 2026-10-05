import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { recordActivity } from "../activity.singleton.js";
import { requestIndexerRefresh } from "../email/provision.service.js";
import { fakeGoogleDb } from "./__tests__/fake-db.js";
import { GoogleProviderError, type GoogleProvider, type GoogleTokens } from "./google-client.js";
import { DEFAULT_GOOGLE_FEATURES, scopesForGoogleFeatures, type GoogleFeatures } from "./scopes.js";
import { openGoogleFlow, openGoogleGrant } from "./token-store.js";
import {
  beginGoogleConnect, completeGoogleConnect, disconnectGoogle, getGoogleConnectionView,
  getGoogleMailboxAccessToken, googleDependencies, GoogleSetupRequiredError, GoogleNotConnectedError,
  GoogleTemporarilyUnavailableError, GoogleMailboxUnavailableError, type GoogleDependencies,
  GoogleDisconnectRequiredError, getGoogleCalendarAccessToken, disconnectGoogleMailbox, disconnectGoogleCalendar,
} from "./google-auth.service.js";

vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../email/provision.service.js", () => ({ requestIndexerRefresh: vi.fn(async () => true) }));
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: warnMock }) }));

const userId = "user-1";
const redirectUri = "https://box.customer.com/api/google/callback";
const app = { clientId: "customer-client.apps.googleusercontent.com", clientSecret: "customer-client-secret" };
const now = new Date("2026-10-05T15:00:00Z");
const mailScopes = scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES);
function setup(overrides: Partial<GoogleProvider> = {}) {
  const db = fakeGoogleDb();
  const provider: GoogleProvider = {
    getAuthorizationUrl: vi.fn((_app, { state }) => `https://accounts.google.com/authorize?state=${state}`),
    exchangeCode: vi.fn(async (_app, opts) => ({ accessToken: "access-secret", refreshToken: "refresh-secret", grantedScopes: [...opts.scopes ?? mailScopes] })),
    getAccountAddress: vi.fn(async () => "person@gmail.com"),
    refresh: vi.fn(async (_app, _refresh, scopes) => ({ accessToken: "new-access-secret", refreshToken: "new-refresh-secret", grantedScopes: [...scopes ?? mailScopes] })),
    revoke: vi.fn(async () => {}), ...overrides,
  };
  const deps = googleDependencies({ provider, getApp: vi.fn(async () => app), now: () => now,
    refreshIndexer: vi.fn(async () => true), mailboxAvailable: () => true });
  return { db, deps, provider };
}
async function connect(db: ReturnType<typeof fakeGoogleDb>, deps: GoogleDependencies, features: GoogleFeatures = DEFAULT_GOOGLE_FEATURES) {
  const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, features);
  const callback = { state: started.state, browserState: started.state, code: "auth-code", error: null };
  return { started, callback, outcome: await completeGoogleConnect(db.prisma, callback, deps) };
}

describe("Gmail connection lifecycle", () => {
  beforeEach(() => { __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64")); warnMock.mockClear(); });
  afterEach(() => __setColumnCryptoKeyForTest(null));

  it("starts a person-owned browser flow and keeps only state hash and encrypted verifier", async () => {
    const { db, deps, provider } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    const row = db.connections()[0];
    expect(row.state).toBe("PENDING_CONSENT");
    expect(row.pendingStateHash).toBe(createHash("sha256").update(started.state).digest("hex"));
    expect(row.pendingFlowEnc).not.toContain(app.clientSecret);
    expect(JSON.stringify(row)).not.toContain(started.state);
    const flow = openGoogleFlow(userId, row.pendingFlowEnc);
    expect(flow.redirectUri).toBe(redirectUri);
    expect(provider.getAuthorizationUrl).toHaveBeenCalledWith(app, expect.objectContaining({
      codeChallenge: createHash("sha256").update(flow.codeVerifier).digest("base64url"),
    }));
    expect(started.expiresAt.getTime() - now.getTime()).toBe(900_000);
  });

  it("does not mint a flow without customer app setup, a supported callback or the mail service", async () => {
    const { db, deps } = setup();
    await expect(beginGoogleConnect(db.prisma, userId, "https://droplet.local/api/google/callback", deps)).rejects.toBeInstanceOf(GoogleSetupRequiredError);
    await expect(beginGoogleConnect(db.prisma, userId, redirectUri, { ...deps, getApp: async () => undefined })).rejects.toBeInstanceOf(GoogleSetupRequiredError);
    await expect(beginGoogleConnect(db.prisma, userId, redirectUri, { ...deps, mailboxAvailable: () => false })).rejects.toBeInstanceOf(GoogleMailboxUnavailableError);
    expect(db.connections()).toHaveLength(0);
  });

  it("calendar-only consent works without the mail sidecar and persists only the selected identity/calendar grant", async () => {
    const { db, deps, provider } = setup();
    const calendarDeps = { ...deps, mailboxAvailable: () => false };
    expect((await connect(db, calendarDeps, { mail: false, calendar: true })).outcome).toBe("connected");
    expect(db.accounts()).toHaveLength(0);
    expect(db.sources()[0]).toMatchObject({ userId: "sam", authMode: "google_oauth", passwordEnc: null,
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events" });
    expect(db.connections()[0]).toMatchObject({ mailEnabled: false, calendarEnabled: true, calendarSyncState: "WAITING" });
    expect(openGoogleGrant(userId, db.connections()[0].tokenEnc).scopes).toEqual(scopesForGoogleFeatures({ mail: false, calendar: true }));
    expect(provider.getAuthorizationUrl).toHaveBeenCalledWith(app, expect.objectContaining({ scopes: scopesForGoogleFeatures({ mail: false, calendar: true }) }));
    expect(deps.refreshIndexer).not.toHaveBeenCalled();
    expect((await getGoogleConnectionView(db.prisma, userId)).calendar.state).toBe("WAITING");
  });

  it("adds Calendar to the same Gmail account while preserving its mailbox archive", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    const mailboxId = db.accounts()[0].id;
    expect((await connect(db, deps, { mail: true, calendar: true })).outcome).toBe("connected");
    expect(db.accounts()).toHaveLength(1);
    expect(db.accounts()[0].id).toBe(mailboxId);
    expect(db.sources()).toHaveLength(1);
    expect(db.connections()[0]).toMatchObject({ mailEnabled: true, calendarEnabled: true });
    await expect(beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: false, calendar: true }))
      .rejects.toBeInstanceOf(GoogleDisconnectRequiredError);
    await expect(beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: false }))
      .rejects.toBeInstanceOf(GoogleDisconnectRequiredError);
    expect(db.accounts()[0].id).toBe(mailboxId);
    expect(db.sources()).toHaveLength(1);
  });

  it.each(["denied", "expired", "failed"])("keeps working Gmail when additive Calendar consent is %s", async (outcome) => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    const original = { ...db.connections()[0] };
    const mailbox = { ...db.accounts()[0] };
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    if (outcome === "failed") vi.mocked(provider.exchangeCode).mockRejectedValueOnce(new GoogleProviderError());
    expect(await completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: "code", error: outcome === "denied" ? "access_denied" : null,
    }, outcome === "expired" ? { ...deps, now: () => started.expiresAt } : deps))
      .toBe(outcome === "denied" ? "cancelled" : outcome);
    expect(db.connections()[0]).toMatchObject({ state: "CONNECTED", mailEnabled: true, calendarEnabled: false,
      tokenEnc: original.tokenEnc, connectedAt: original.connectedAt, lastRefreshOkAt: original.lastRefreshOkAt,
      emailAccountId: mailbox.id, calendarSyncState: "DISCONNECTED", pendingFlowEnc: null });
    expect(db.accounts()).toEqual([mailbox]);
    expect(db.sources()).toHaveLength(0);
    expect(await getGoogleMailboxAccessToken(db.prisma, mailbox.id, deps)).toBe("new-access-secret");
  });

  it("expiry through status restores the prior grant and timestamps, including repeated consent starts", async () => {
    const { db, deps } = setup();
    await connect(db, deps, { mail: true, calendar: true });
    db.connections()[0].calendarSyncState = "CONNECTED";
    const original = { ...db.connections()[0] };
    await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    const repeated = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    const prior = openGoogleFlow(userId, db.connections()[0].pendingFlowEnc).prior;
    expect(prior).toMatchObject({ state: "CONNECTED", calendarSyncState: "CONNECTED",
      connectedAt: original.connectedAt.toISOString(), lastRefreshOkAt: original.lastRefreshOkAt.toISOString() });
    const view = await getGoogleConnectionView(db.prisma, userId, repeated.expiresAt);
    expect(view).toMatchObject({ state: "CONNECTED", connectedAt: original.connectedAt, calendar: { state: "CONNECTED" } });
    expect(db.connections()[0]).toMatchObject({ tokenEnc: original.tokenEnc, calendarEnabled: true, pendingFlowEnc: null });
  });

  it("cancelled reconsent retains a previous reconnect state and reason", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    Object.assign(db.connections()[0], { state: "NEEDS_RECONNECT", tokenEnc: null, lastError: "Reconnect required." });
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    expect(await completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: null, error: "access_denied",
    }, deps)).toBe("cancelled");
    expect(db.connections()[0]).toMatchObject({ state: "NEEDS_RECONNECT", tokenEnc: null, lastError: "Reconnect required." });
  });

  it("a damaged prior grant is never restored as connected after cancelled additive consent", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    db.connections()[0].tokenEnc = "CORRUPT_REFRESH_TOKEN_SECRET";
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    expect(await completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: null, error: "access_denied",
    }, deps)).toBe("cancelled");
    expect(db.connections()[0]).toMatchObject({ state: "NEEDS_RECONNECT", tokenEnc: null });
    expect(db.connections()[0].lastError).not.toContain("CORRUPT_REFRESH_TOKEN_SECRET");
  });

  it("a damaged sealed prior flow becomes a generic reconnect state on expiry", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    db.connections()[0].pendingFlowEnc = "CORRUPT_STATE_SECRET";
    const view = await getGoogleConnectionView(db.prisma, userId, started.expiresAt);
    expect(view.state).toBe("NEEDS_RECONNECT");
    expect(db.connections()[0]).toMatchObject({ tokenEnc: null, pendingFlowEnc: null });
    expect(view.lastError).not.toContain("CORRUPT_STATE_SECRET");
    expect(db.accounts()).toHaveLength(1);
  });

  it("a late additive-consent failure cannot restore state after Calendar removal", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: true, calendar: true });
    let rejectExchange!: (error: unknown) => void;
    vi.mocked(provider.exchangeCode).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectExchange = reject; }));
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar: true });
    const completing = completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: "code", error: null,
    }, deps);
    await vi.waitFor(() => expect(rejectExchange).toBeTypeOf("function"));
    await disconnectGoogleCalendar(db.prisma, userId, db.sources()[0].id, deps);
    rejectExchange(new GoogleProviderError());
    expect(await completing).toBe("failed");
    expect(db.connections()[0]).toMatchObject({ state: "NEEDS_RECONNECT", calendarEnabled: false,
      calendarSourceId: null, pendingFlowEnc: null });
    expect(db.sources()).toHaveLength(0);
  });

  it("status never projects a foreign linked calendar's health or event count", async () => {
    const { db, deps } = setup();
    await connect(db, deps, { mail: false, calendar: true });
    Object.assign(db.sources()[0], { userId: "someone-else", lastSyncError: "FOREIGN_ERROR", lastSyncAt: now });
    db.events().push({ id: "foreign-event", sourceId: db.sources()[0].id, userId: "someone-else" });
    const view = await getGoogleConnectionView(db.prisma, userId);
    expect(view.calendar).toMatchObject({ lastSyncAt: null, lastError: null, eventCount: 0 });
    expect(JSON.stringify(view)).not.toContain("FOREIGN_ERROR");
    expect(db.calendarEvent.count).not.toHaveBeenCalled();
  });

  it("does not accept selective consent when a requested Calendar scope was denied", async () => {
    const { db, deps } = setup({ exchangeCode: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", grantedScopes: mailScopes })) });
    expect((await connect(db, deps, { mail: true, calendar: true })).outcome).toBe("failed");
    expect(db.accounts()).toHaveLength(0);
    expect(db.sources()).toHaveLength(0);
    expect(db.connections()[0].tokenEnc).toBeNull();
  });

  it("mail and calendar consumers share one refresh of the same per-person grant", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: true, calendar: true });
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.refresh).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const mailbox = getGoogleMailboxAccessToken(db.prisma, db.accounts()[0].id, deps);
    const calendar = getGoogleCalendarAccessToken(db.prisma, userId, deps);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    expect(provider.refresh).toHaveBeenCalledOnce();
    respond({ accessToken: "shared", grantedScopes: scopesForGoogleFeatures({ mail: true, calendar: true }) });
    expect(await mailbox).toBe("shared");
    expect((await calendar).accessToken).toBe("shared");
  });

  it("verifies the Gmail address and commits OAuth mailbox with first sync still pending", async () => {
    const { db, deps, provider } = setup();
    expect((await connect(db, deps)).outcome).toBe("connected");
    expect(provider.getAccountAddress).toHaveBeenCalledWith("access-secret");
    expect(db.accounts()[0]).toMatchObject({
      userId, authMode: "GOOGLE_OAUTH", passwordEnc: null, address: "person@gmail.com", username: "person@gmail.com",
      imapHost: "imap.gmail.com", imapPort: 993, imapTls: true,
      smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true, imapStatus: "reconnecting",
    });
    const row = db.connections()[0];
    expect(row).toMatchObject({ state: "CONNECTED", accountAddress: "person@gmail.com", emailAccountId: db.accounts()[0].id,
      pendingStateHash: null, pendingFlowEnc: null, pendingExpiresAt: null });
    expect(openGoogleGrant(userId, row.tokenEnc)).toEqual({ ...app, refreshToken: "refresh-secret", scopes: mailScopes });
    expect(JSON.stringify(row)).not.toContain("access-secret");
    expect(deps.refreshIndexer).toHaveBeenCalledOnce();
    expect(JSON.stringify(await getGoogleConnectionView(db.prisma, userId))).not.toMatch(/access-secret|refresh-secret|customer-client-secret|tokenEnc/);
  });

  it("an unknown or other browser's state cannot claim the flow", async () => {
    const { db, deps, provider } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    expect(await completeGoogleConnect(db.prisma, { state: started.state, browserState: "different", code: "code", error: null }, deps)).toBe("failed");
    expect(await completeGoogleConnect(db.prisma, { state: "unknown", browserState: "unknown", code: "code", error: null }, deps)).toBe("failed");
    expect(db.connections()[0].pendingStateHash).not.toBeNull();
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });

  it("a completed callback cannot be replayed", async () => {
    const { db, deps, provider } = setup();
    const { callback } = await connect(db, deps);
    expect(await completeGoogleConnect(db.prisma, callback, deps)).toBe("failed");
    expect(provider.exchangeCode).toHaveBeenCalledOnce();
  });

  it("denied consent is single use and returns cancelled without reflecting provider errors", async () => {
    const { db, deps, provider } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    const callback = { state: started.state, browserState: started.state, code: null, error: "access_denied" };
    expect(await completeGoogleConnect(db.prisma, callback, deps)).toBe("cancelled");
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", tokenEnc: null, lastError: null });
    expect(provider.exchangeCode).not.toHaveBeenCalled();
    expect(await completeGoogleConnect(db.prisma, callback, deps)).toBe("failed");
  });

  it("expires abandoned consent and clears its encrypted secrets", async () => {
    const { db, deps, provider } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    expect(await completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null },
      { ...deps, now: () => started.expiresAt })).toBe("expired");
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", pendingFlowEnc: null, pendingStateHash: null });
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });

  it("polling an expired pending flow settles it without exposing secrets", async () => {
    const { db, deps } = setup();
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    expect((await getGoogleConnectionView(db.prisma, userId, started.expiresAt)).state).toBe("DISCONNECTED");
    expect(db.connections()[0].pendingFlowEnc).toBeNull();
  });

  it.each([
    { userId: "other-person", authMode: "GOOGLE_OAUTH" },
    { userId, authMode: "PASSWORD" },
    { userId: null, authMode: "PASSWORD" },
  ])("refuses an address already connected with %j without reassigning its archive", async (owner) => {
    const { db, deps } = setup();
    db.seedAccount({ ...owner, address: "PERSON@gmail.com", passwordEnc: "old-password" });
    const original = { ...db.accounts()[0] };
    expect((await connect(db, deps)).outcome).toBe("failed");
    expect(db.accounts()).toEqual([original]);
    expect(db.connections()[0].state).toBe("ERROR");
    expect(db.connections()[0].tokenEnc).toBeNull();
    expect(db.connections()[0].lastError).toContain("already connected");
  });

  it("reuses the person's own OAuth mailbox so reconnection keeps the archive", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    const accountId = db.accounts()[0].id;
    await connect(db, deps);
    expect(db.accounts()).toHaveLength(1);
    expect(db.accounts()[0].id).toBe(accountId);
  });

  it("refuses switching Google identity until explicit disconnect, preserving the prior grant and archive", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    const originalMailboxId = db.accounts()[0].id;
    const originalGrant = db.connections()[0].tokenEnc;
    db.seedAccount({ userId, authMode: "PASSWORD", address: "manual@example.com" });
    vi.mocked(provider.getAccountAddress).mockResolvedValue("new-person@gmail.com");
    expect((await connect(db, deps)).outcome).toBe("different_account");
    expect(db.accounts().map((account) => account.address).sort()).toEqual(["manual@example.com", "person@gmail.com"]);
    expect(db.connections()).toHaveLength(1);
    expect(db.connections()[0]).toMatchObject({ emailAccountId: originalMailboxId, accountAddress: "person@gmail.com", tokenEnc: originalGrant });
    expect(db.connections()[0].lastError).toContain("Disconnect the existing Google account");
    expect(provider.revoke).not.toHaveBeenCalled();
    await disconnectGoogle(db.prisma, userId, deps);
    expect((await connect(db, deps)).outcome).toBe("connected");
    expect(db.accounts().map((account) => account.address).sort()).toEqual(["manual@example.com", "new-person@gmail.com"]);
  });

  it("will not call a connection successful without a refresh grant or Gmail profile", async () => {
    for (const overrides of [
      { exchangeCode: vi.fn(async () => ({ accessToken: "access-secret", grantedScopes: mailScopes })) },
      { getAccountAddress: vi.fn(async () => { throw new Error("PROVIDER_TOKEN_SECRET"); }) },
    ]) {
      const { db, deps } = setup(overrides);
      expect((await connect(db, deps)).outcome).toBe("failed");
      expect(db.accounts()).toHaveLength(0);
      expect(JSON.stringify(db.connections())).not.toContain("PROVIDER_TOKEN_SECRET");
    }
  });

  it.each(["disconnect", "deactivate", "delete", "new-flow"])("late exchange cannot overwrite %s", async (action) => {
    const { db, deps, provider } = setup();
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.exchangeCode).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    const completion = completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    if (action === "disconnect") await disconnectGoogle(db.prisma, userId, deps);
    if (action === "deactivate") db.users()[0].directoryStatus = "DEACTIVATED";
    if (action === "delete") db.users().splice(0);
    if (action === "new-flow") await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    respond({ accessToken: "access-secret", refreshToken: "refresh-secret", grantedScopes: mailScopes });
    expect(await completion).toBe("cancelled");
    expect(db.connections()[0].state).not.toBe("CONNECTED");
    expect(db.accounts()).toHaveLength(0);
  });

  it("disconnect atomically purges the local token and owned archive even if revoke is unavailable", async () => {
    const { db, deps, provider } = setup({ revoke: vi.fn(async () => { throw new Error("provider unavailable"); }) });
    await connect(db, deps);
    db.seedAccount({ userId: "other-person", authMode: "GOOGLE_OAUTH", address: "other@gmail.com" });
    await disconnectGoogle(db.prisma, userId, deps);
    expect(provider.revoke).toHaveBeenCalledWith("refresh-secret");
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", tokenEnc: null, pendingFlowEnc: null, emailAccountId: null });
    expect(db.accounts().map((account) => account.address)).toEqual(["other@gmail.com"]);
  });

  it("disconnect during re-consent can revoke the prior grant, which the pending worker cannot use", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    const accountId = db.accounts()[0].id;
    await beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    await expect(getGoogleMailboxAccessToken(db.prisma, accountId, deps)).rejects.toBeInstanceOf(GoogleNotConnectedError);
    expect(provider.refresh).not.toHaveBeenCalled();
    await disconnectGoogle(db.prisma, userId, deps);
    expect(provider.revoke).toHaveBeenCalledWith("refresh-secret");
    expect(db.accounts()).toHaveLength(0);
    expect(db.connections()[0].tokenEnc).toBeNull();
  });

  it("removing Gmail keeps a selected Calendar grant, source, events and connected health", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: true, calendar: true });
    const original = { ...db.connections()[0] };
    const source = { ...db.sources()[0] };
    db.events().push({ id: "calendar-event-1", sourceId: source.id, userId: "sam", externalUid: "meeting-1" });
    const events = [...db.events()];
    await disconnectGoogleMailbox(db.prisma, userId, db.accounts()[0].id, deps);
    expect(db.accounts()).toHaveLength(0);
    expect(db.connections()[0]).toMatchObject({ state: "CONNECTED", mailEnabled: false, calendarEnabled: true,
      emailAccountId: null, calendarSourceId: source.id, calendarSyncState: original.calendarSyncState,
      connectedAt: original.connectedAt, tokenEnc: original.tokenEnc });
    expect(db.sources()).toEqual([source]);
    expect(db.events()).toEqual(events);
    expect(provider.revoke).not.toHaveBeenCalled();
    expect((await getGoogleCalendarAccessToken(db.prisma, userId, deps)).accessToken).toBe("new-access-secret");
    expect(provider.refresh).toHaveBeenLastCalledWith(expect.any(Object), "refresh-secret",
      scopesForGoogleFeatures({ mail: true, calendar: true }));
  });

  it("removing a mail-only Google mailbox purges its grant and revokes after local deletion", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    const accountId = db.accounts()[0].id;
    vi.mocked(provider.revoke).mockImplementationOnce(async () => {
      expect(db.accounts()).toHaveLength(0);
      expect(db.connections()[0].tokenEnc).toBeNull();
      throw new Error("PROVIDER_SECRET");
    });
    await disconnectGoogleMailbox(db.prisma, userId, accountId, deps);
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", tokenEnc: null,
      mailEnabled: false, emailAccountId: null, accountAddress: null, pendingFlowEnc: null });
    expect(provider.revoke).toHaveBeenCalledWith("refresh-secret");
  });

  it.each([false, true])("removing Gmail cancels a racing callback with Calendar selected=%s", async (calendar) => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: true, calendar });
    const mailboxId = db.accounts()[0].id;
    const originalGrant = db.connections()[0].tokenEnc;
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.exchangeCode).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail: true, calendar });
    const callback = completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    await disconnectGoogleMailbox(db.prisma, userId, mailboxId, deps);
    respond({ accessToken: "late-access", refreshToken: "late-refresh", grantedScopes: scopesForGoogleFeatures({ mail: true, calendar }) });
    expect(await callback).toBe("cancelled");
    expect(db.accounts()).toHaveLength(0);
    expect(db.connections()[0]).toMatchObject({ mailEnabled: false, emailAccountId: null, pendingFlowEnc: null,
      state: calendar ? "NEEDS_RECONNECT" : "DISCONNECTED", tokenEnc: calendar ? originalGrant : null });
    expect(db.sources()).toHaveLength(calendar ? 1 : 0);
    if (calendar) {
      expect(db.connections()[0].calendarSyncState).toBe("NEEDS_RECONNECT");
      expect(provider.revoke).not.toHaveBeenCalled();
      expect((await connect(db, deps, { mail: false, calendar: true })).outcome).toBe("connected");
      expect(db.accounts()).toHaveLength(0);
    } else expect(provider.revoke).toHaveBeenCalledOnce();
  });

  it("mailbox-only disconnect cannot remove another person's or a manual archive", async () => {
    const { db, deps, provider } = setup();
    db.seedAccount({ userId: "other-person", authMode: "GOOGLE_OAUTH", address: "other@gmail.com" });
    db.seedAccount({ userId, authMode: "PASSWORD", address: "manual@example.com" });
    await disconnectGoogleMailbox(db.prisma, userId, db.accounts()[0].id, deps);
    await disconnectGoogleMailbox(db.prisma, userId, db.accounts()[1].id, deps);
    expect(db.accounts()).toHaveLength(2);
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(deps.refreshIndexer).not.toHaveBeenCalled();
  });

  it("a consent transaction begun before Gmail removal is serialized and then cancelled", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    const mailboxId = db.accounts()[0].id;
    let resumeRead!: () => void;
    let reportRead!: () => void;
    const readPaused = new Promise<void>((resolve) => { reportRead = resolve; });
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    let pauseRead = true;
    let held = false;
    let releaseRow!: () => void;
    let rowAvailable = Promise.resolve();
    // Model PostgreSQL's row write locks for two overlapping transactions.
    // Without begin's early write, Remove commits while begin reads stale features.
    db.$transaction.mockImplementation(async (operation) => {
      let ownLock = false;
      const acquire = async () => {
        if (ownLock) return;
        while (held) await rowAvailable;
        held = true; ownLock = true;
        rowAvailable = new Promise<void>((resolve) => { releaseRow = resolve; });
      };
      const tx = { ...db, googleConnection: { ...db.googleConnection,
        updateMany: async (args: any) => { await acquire(); return db.googleConnection.updateMany(args); },
        upsert: async (args: any) => { await acquire(); return db.googleConnection.upsert(args); },
        findUnique: async (args: any) => {
          const row = await db.googleConnection.findUnique(args);
          if (pauseRead) { pauseRead = false; reportRead(); await readGate; }
          return row;
        },
      } };
      try { return await operation(tx); }
      finally { if (ownLock) { held = false; releaseRow(); } }
    });
    const beginning = beginGoogleConnect(db.prisma, userId, redirectUri, deps);
    await readPaused;
    const removal = disconnectGoogleMailbox(db.prisma, userId, mailboxId, deps);
    // Let an unblocked removal complete before the consent read resumes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    resumeRead();
    const started = await beginning;
    expect(await removal).toBe(true);
    expect(await completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: "code", error: null,
    }, deps)).toBe("failed");
    expect(db.accounts()).toHaveLength(0);
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", mailEnabled: false, pendingFlowEnc: null });
  });

  it("removing Calendar keeps selected Gmail and deletes only the owned Calendar archive", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: true, calendar: true });
    const original = { ...db.connections()[0] };
    const sourceId = db.sources()[0].id;
    const mailbox = { ...db.accounts()[0] };
    db.events().push({ id: "google-meeting", sourceId, userId: "sam" }, { id: "other-meeting", sourceId: "another", userId: "sam" });
    expect(await disconnectGoogleCalendar(db.prisma, userId, sourceId, deps)).toBe(true);
    expect(db.sources()).toHaveLength(0);
    expect(db.events().map((event) => event.id)).toEqual(["other-meeting"]);
    expect(db.accounts()).toEqual([mailbox]);
    expect(db.connections()[0]).toMatchObject({ state: "CONNECTED", mailEnabled: true, calendarEnabled: false,
      emailAccountId: mailbox.id, calendarSourceId: null, calendarSyncState: "DISCONNECTED",
      tokenEnc: original.tokenEnc, connectedAt: original.connectedAt });
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(await getGoogleMailboxAccessToken(db.prisma, mailbox.id, deps)).toBe("new-access-secret");
  });

  it("removing Calendar-only clears the last grant before best-effort remote revoke", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail: false, calendar: true });
    vi.mocked(provider.revoke).mockImplementationOnce(async () => {
      expect(db.connections()[0].tokenEnc).toBeNull();
      expect(db.sources()).toHaveLength(0);
      throw new Error("PROVIDER_SECRET");
    });
    expect(await disconnectGoogleCalendar(db.prisma, userId, db.sources()[0].id, deps)).toBe(true);
    expect(db.connections()[0]).toMatchObject({ state: "DISCONNECTED", tokenEnc: null,
      calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED", accountAddress: null });
    expect(provider.revoke).toHaveBeenCalledWith("refresh-secret");
  });

  it.each([false, true])("Calendar removal cancels a racing callback with Gmail selected=%s", async (mail) => {
    const { db, deps, provider } = setup();
    await connect(db, deps, { mail, calendar: true });
    const sourceId = db.sources()[0].id;
    const originalGrant = db.connections()[0].tokenEnc;
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.exchangeCode).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, deps, { mail, calendar: true });
    const callback = completeGoogleConnect(db.prisma, { state: started.state, browserState: started.state, code: "code", error: null }, deps);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    await disconnectGoogleCalendar(db.prisma, userId, sourceId, deps);
    respond({ accessToken: "late-access", refreshToken: "late-refresh", grantedScopes: scopesForGoogleFeatures({ mail, calendar: true }) });
    expect(await callback).toBe("cancelled");
    expect(db.sources()).toHaveLength(0);
    expect(db.connections()[0]).toMatchObject({ calendarEnabled: false, calendarSourceId: null, pendingFlowEnc: null,
      state: mail ? "NEEDS_RECONNECT" : "DISCONNECTED", tokenEnc: mail ? originalGrant : null });
    expect(db.accounts()).toHaveLength(mail ? 1 : 0);
    if (mail) {
      expect(provider.revoke).not.toHaveBeenCalled();
      expect((await connect(db, deps, { mail: true, calendar: false })).outcome).toBe("connected");
      expect(db.sources()).toHaveLength(0);
    } else expect(provider.revoke).toHaveBeenCalledOnce();
  });

  it("calendar-only disconnect cannot remove a foreign or manual subscription", async () => {
    const { db, deps, provider } = setup();
    const foreign = await db.calendarSource.create({ data: { userId: "someone-else", authMode: "google_oauth" } });
    const manual = await db.calendarSource.create({ data: { userId: "sam", authMode: "basic" } });
    expect(await disconnectGoogleCalendar(db.prisma, userId, foreign.id, deps)).toBe(false);
    expect(await disconnectGoogleCalendar(db.prisma, userId, manual.id, deps)).toBe(false);
    expect(db.sources()).toHaveLength(2);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("reports committed consent as connected even when audit and the default indexer followup fail", async () => {
    const { db, deps } = setup();
    const defaults = googleDependencies({ provider: deps.provider, getApp: deps.getApp, now: deps.now, mailboxAvailable: deps.mailboxAvailable });
    const started = await beginGoogleConnect(db.prisma, userId, redirectUri, defaults);
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("REFRESH_TOKEN_SECRET"));
    vi.mocked(requestIndexerRefresh).mockRejectedValueOnce(new Error("CLIENT_CREDENTIAL_SECRET"));
    expect(await completeGoogleConnect(db.prisma, {
      state: started.state, browserState: started.state, code: "code", error: null,
    }, defaults)).toBe("connected");
    expect(db.connections()[0].state).toBe("CONNECTED");
    expect(db.accounts()).toHaveLength(1);
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warnMock.mock.calls)).not.toMatch(/REFRESH_TOKEN_SECRET|CLIENT_CREDENTIAL_SECRET/);
  });

  it("reports committed disconnect as successful even when audit and an injected indexer followup fail", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("recorder unavailable"));
    vi.mocked(deps.refreshIndexer).mockRejectedValueOnce(new Error("indexer unavailable"));
    await expect(disconnectGoogle(db.prisma, userId, deps)).resolves.toBeUndefined();
    expect(db.connections()[0].state).toBe("DISCONNECTED");
    expect(db.connections()[0].tokenEnc).toBeNull();
    expect(db.accounts()).toHaveLength(0);
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it("refresh returns only a short-lived token and persists rotated refresh credentials", async () => {
    const { db, deps } = setup();
    await connect(db, deps);
    await expect(getGoogleMailboxAccessToken(db.prisma, db.accounts()[0].id, deps)).resolves.toBe("new-access-secret");
    expect(openGoogleGrant(userId, db.connections()[0].tokenEnc).refreshToken).toBe("new-refresh-secret");
    expect(JSON.stringify(db.connections())).not.toContain("new-access-secret");
  });

  it("simultaneous IMAP/SMTP authentication shares refresh and its rotation instead of failing a valid send", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.refresh).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const accountId = db.accounts()[0].id;
    const imap = getGoogleMailboxAccessToken(db.prisma, accountId, deps);
    const smtp = getGoogleMailboxAccessToken(db.prisma, accountId, deps);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    expect(provider.refresh).toHaveBeenCalledOnce();
    respond({ accessToken: "shared-access", refreshToken: "rotated-refresh", grantedScopes: mailScopes });
    await expect(Promise.all([imap, smtp])).resolves.toEqual(["shared-access", "shared-access"]);
    expect(openGoogleGrant(userId, db.connections()[0].tokenEnc).refreshToken).toBe("rotated-refresh");
    await getGoogleMailboxAccessToken(db.prisma, accountId, deps);
    expect(provider.refresh).toHaveBeenCalledTimes(2);
  });

  it("a shared in-flight refresh still returns no token to either transport after disconnect", async () => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.refresh).mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const accountId = db.accounts()[0].id;
    const imap = getGoogleMailboxAccessToken(db.prisma, accountId, deps).catch((error: unknown) => error);
    const smtp = getGoogleMailboxAccessToken(db.prisma, accountId, deps).catch((error: unknown) => error);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    await disconnectGoogle(db.prisma, userId, deps);
    respond({ accessToken: "late-access", grantedScopes: mailScopes });
    for (const result of await Promise.all([imap, smtp])) expect(result).toBeInstanceOf(GoogleTemporarilyUnavailableError);
    expect(db.connections()[0].tokenEnc).toBeNull();
  });

  it("revoked grants become actionable reconnect state while transient outages preserve the link", async () => {
    for (const permanent of [true, false]) {
      const { db, deps } = setup({ refresh: vi.fn(async () => { throw new GoogleProviderError(permanent); }) });
      await connect(db, deps);
      const token = db.connections()[0].tokenEnc;
      await expect(getGoogleMailboxAccessToken(db.prisma, db.accounts()[0].id, deps))
        .rejects.toBeInstanceOf(permanent ? GoogleNotConnectedError : GoogleTemporarilyUnavailableError);
      expect(db.connections()[0].state).toBe(permanent ? "NEEDS_RECONNECT" : "CONNECTED");
      expect(db.connections()[0].tokenEnc).toBe(permanent ? null : token);
    }
  });

  it.each(["disconnect", "deactivate", "delete"])("late refresh cannot return access or resurrect after %s", async (action) => {
    const { db, deps, provider } = setup();
    await connect(db, deps);
    let respond!: (value: GoogleTokens) => void;
    vi.mocked(provider.refresh).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const pending = getGoogleMailboxAccessToken(db.prisma, db.accounts()[0].id, deps).catch((error: unknown) => error);
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    if (action === "disconnect") await disconnectGoogle(db.prisma, userId, deps);
    if (action === "deactivate") db.users()[0].directoryStatus = "DEACTIVATED";
    if (action === "delete") db.users().splice(0);
    respond({ accessToken: "late-access", refreshToken: "late-refresh", grantedScopes: mailScopes });
    expect(await pending).toBeInstanceOf(GoogleTemporarilyUnavailableError);
    expect(JSON.stringify(db.connections())).not.toContain("late-refresh");
  });
});
