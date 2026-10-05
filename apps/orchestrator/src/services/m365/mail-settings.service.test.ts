import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("./m365-auth.service.js", () => ({ getAccessToken: auth.getAccessToken }));
import { setMicrosoftMailEnabled, lockMicrosoftMailConnection, purgeMicrosoftMail, microsoftMailViewOf,
  MicrosoftMailboxConflictError, MicrosoftMailUnavailableError } from "./mail-settings.service.js";
import { disconnectMailbox } from "../email/provision.service.js";
import type { GraphClient, GraphPage } from "./graph-client.js";

const NOW = new Date("2026-10-05T12:00:00Z");
function matches(row: any, where: any): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (value instanceof Date) return row[key] instanceof Date && value.getTime() === row[key].getTime();
    if (value && typeof value === "object" && "equals" in value) return String(row[key]).toLowerCase() === value.equals.toLowerCase();
    if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
    return row[key] === value;
  });
}
function world(overrides: Record<string, unknown> = {}) {
  let state: any = { connection: { userId: "person", state: "CONNECTED", grantedScopes: "User.Read Mail.Read", tokenCacheEnc: "cache",
    connectedAt: NOW, cursorLinkHash: "identity", mailEnabled: false, emailAccountId: null, mailSyncState: "DISCONNECTED",
    calendarEnabled: true, calendarSourceId: "calendar", calendarSyncState: "CONNECTED", ...overrides },
    person: { id: "person", username: "owner", directoryStatus: "ACTIVE", deletionStatus: "NONE" },
    accounts: [], messages: [], folders: [], memberships: [], cursors: [{ id: "calendar-cursor", userId: "person", workload: "calendar" }] };
  const db: any = {
    user: { findFirst: vi.fn(async ({ where }: any) => matches(state.person, where) ? { ...state.person } : null) },
    m365Connection: { findUnique: vi.fn(async ({ where }: any) => matches(state.connection, where) ? { ...state.connection } : null),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!matches(state.connection, where)) return { count: 0 }; Object.assign(state.connection, data); return { count: 1 }; }) },
    emailAccount: { findFirst: vi.fn(async ({ where }: any) => state.accounts.find((row: any) => matches(row, where)) ?? null),
      findUnique: vi.fn(async ({ where }: any) => state.accounts.find((row: any) => matches(row, where)) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { id: `account-${state.accounts.length + 1}`, lastIdleAt: null, ...data }; state.accounts.push(row); return row; }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const deleted = state.accounts.filter((row: any) => matches(row, where));
        const ids = new Set(deleted.map((row: any) => row.id));
        state.accounts = state.accounts.filter((row: any) => !ids.has(row.id));
        for (const key of ["messages", "folders", "memberships"]) state[key] = state[key].filter((row: any) => !ids.has(row.accountId));
        if (ids.has(state.connection.emailAccountId)) state.connection.emailAccountId = null;
        return { count: deleted.length };
      }) },
    m365DeltaCursor: { deleteMany: vi.fn(async ({ where }: any) => { const old = state.cursors.length;
      state.cursors = state.cursors.filter((row: any) => !matches(row, where)); return { count: old - state.cursors.length }; }) },
    $transaction: vi.fn(async (work: any) => { const snapshot = structuredClone(state); try { return await work(db); } catch (error) { state = snapshot; throw error; } }),
  };
  const getPage = vi.fn(async (_url: string, _token: string) => ({ raw: { mail: "Primary@example.test", userPrincipalName: "login-name@tenant.test" },
    items: [], links: { nextLink: null, deltaLink: null } } as GraphPage));
  return { db: db as PrismaClient, state: () => state, getPage, client: { getPage } as unknown as GraphClient };
}
beforeEach(() => {
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockImplementation(async (db: any, _entra: unknown, userId: string, _now: Date, onGrant: any) => {
    const row = await db.m365Connection.findUnique({ where: { userId } });
    onGrant({ tokenCacheEnc: row.tokenCacheEnc, cursorLinkHash: row.cursorLinkHash, connectedAt: row.connectedAt,
      mailEnabled: row.mailEnabled, emailAccountId: row.emailAccountId });
    return "ephemeral-secret-token";
  });
});

describe("Outlook mail opt-in and local archive ownership", () => {
  it("uses full Mail.Read to resolve the actual Exchange address, never the login UPN", async () => {
    const w = world();
    expect(await setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).toBe(true);
    expect(w.getPage).toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/me?$select=mail,displayName", "ephemeral-secret-token");
    expect(w.state().accounts).toEqual([expect.objectContaining({ address: "primary@example.test", userId: "person", authMode: "M365_GRAPH",
      passwordEnc: null, imapHost: "", smtpHost: "", imapStatus: "paused" })]);
    expect(w.state().connection).toMatchObject({ mailEnabled: true, mailSyncState: "WAITING", emailAccountId: "account-1", calendarEnabled: true, calendarSourceId: "calendar" });
  });
  it("records missing-scope opt-in without token acquisition or mailbox reads", async () => {
    const w = world({ grantedScopes: "User.Read Mail.ReadBasic Calendars.Read" });
    expect(await setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).toBe(true);
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(w.getPage).not.toHaveBeenCalled();
    expect(w.state().accounts).toEqual([]);
    expect(microsoftMailViewOf(w.state().connection)).toMatchObject({ enabled: true, needsConsent: true, state: "NEEDS_RECONNECT", mailboxId: null });
  });
  it.each(["Mail.Read", "Mail.ReadWrite"])("requires an active owner even with %s", async (scope) => {
    const w = world({ grantedScopes: scope }); w.state().person.directoryStatus = "DISABLED";
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow(MicrosoftMailUnavailableError);
    expect(w.state().connection.mailEnabled).toBe(false);
    expect(w.getPage).not.toHaveBeenCalled();
  });
  it("also refuses a missing-scope opt-in for a leaver", async () => {
    const w = world({ grantedScopes: "Mail.ReadBasic" }); w.state().person.deletionStatus = "PENDING";
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow(MicrosoftMailUnavailableError);
    expect(w.state().connection.mailEnabled).toBe(false);
  });
  it.each(["person", "another-owner"])("does not replace an existing address owned by %s", async (userId) => {
    const w = world(); w.state().accounts.push({ id: "existing", userId, address: "PRIMARY@example.test", authMode: "PASSWORD" });
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow(MicrosoftMailboxConflictError);
    expect(w.state().accounts).toHaveLength(1);
    expect(w.state().accounts[0].authMode).toBe("PASSWORD");
    expect(w.state().connection.emailAccountId).toBeNull();
  });
  it("rejects a foreign linked account, without replacing or modifying it", async () => {
    const w = world({ emailAccountId: "foreign", mailEnabled: true });
    w.state().accounts.push({ id: "foreign", userId: "another-owner", address: "primary@example.test", authMode: "M365_GRAPH" });
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow(MicrosoftMailboxConflictError);
    expect(w.state().accounts[0].userId).toBe("another-owner");
  });
  it("preserves explicit existing ERROR state rather than inferring healthy from timestamps", async () => {
    const w = world({ emailAccountId: "owned", mailEnabled: true, mailSyncState: "ERROR" });
    w.state().accounts.push({ id: "owned", userId: "person", address: "primary@example.test", authMode: "M365_GRAPH", lastIdleAt: NOW });
    expect(await setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).toBe(true);
    expect(w.state().accounts).toHaveLength(1);
    expect(w.state().connection.mailSyncState).toBe("ERROR");
  });
  it("does not fall back to UPN when Exchange mail is absent", async () => {
    const w = world(); w.getPage.mockResolvedValueOnce({ raw: { mail: null, userPrincipalName: "login@tenant.test" }, items: [], links: { deltaLink: null, nextLink: null } } as GraphPage);
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow(MicrosoftMailUnavailableError);
    expect(w.state().accounts).toEqual([]);
    expect(microsoftMailViewOf(w.state().connection)).toMatchObject({ state: "ERROR", lastError: expect.stringContaining("setup could not complete") });
  });
  it("records a fixed visible provisioning error without copying raw provider state", async () => {
    const w = world(); w.getPage.mockRejectedValueOnce(new Error("raw-provider-secret-bearer"));
    await expect(setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client)).rejects.toThrow("raw-provider-secret-bearer");
    const view = microsoftMailViewOf(w.state().connection);
    expect(view).toMatchObject({ enabled: true, state: "ERROR", mailboxId: null, lastError: expect.stringContaining("setup could not complete") });
    expect(JSON.stringify(view)).not.toContain("raw-provider-secret-bearer");
  });
  it.each(["off", "new-grant", "needs-reconnect"])("does not let a late provisioning failure downgrade %s", async (kind) => {
    const w = world();
    let failProfile!: (error: Error) => void;
    w.getPage.mockImplementationOnce(() => new Promise((_resolve, reject) => { failProfile = reject; }));
    const pending = setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client);
    const rejection = expect(pending).rejects.toThrow("private-provider-error");
    await vi.waitFor(() => expect(w.getPage).toHaveBeenCalled());
    if (kind === "off") await setMicrosoftMailEnabled(w.db, "person", false, {} as any, w.client);
    if (kind === "new-grant") { w.state().connection.tokenCacheEnc = "replacement"; w.state().connection.mailSyncState = "CONNECTED"; }
    if (kind === "needs-reconnect") w.state().connection.mailSyncState = "NEEDS_RECONNECT";
    failProfile(new Error("private-provider-error"));
    await rejection;
    expect(w.state().connection.mailSyncState).toBe(kind === "off" ? "DISCONNECTED" : kind === "new-grant" ? "CONNECTED" : "NEEDS_RECONNECT");
  });
  it.each(["off", "disconnect", "new-grant"])("cancels a delayed initial ON after %s", async (kind) => {
    const w = world();
    let resolveProfile!: (value: GraphPage) => void;
    w.getPage.mockImplementationOnce(() => new Promise((resolve) => { resolveProfile = resolve; }));
    const pending = setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client);
    await vi.waitFor(() => expect(w.getPage).toHaveBeenCalled());
    expect(w.state().connection.mailEnabled).toBe(true);
    if (kind === "new-grant") w.state().connection.tokenCacheEnc = "replacement-grant";
    else {
      await setMicrosoftMailEnabled(w.db, "person", false, {} as any, w.client);
      if (kind === "disconnect") w.state().connection.state = "DISCONNECTED";
    }
    resolveProfile({ raw: { mail: "primary@example.test" }, items: [], links: { nextLink: null, deltaLink: null } });
    expect(await pending).toBe(false);
    expect(w.state().accounts).toEqual([]);
    expect(w.state().connection.calendarSourceId).toBe("calendar");
  });
  it("does not fetch the profile if OFF occurred before the token generation was returned", async () => {
    const w = world();
    let completeToken!: () => Promise<void>;
    auth.getAccessToken.mockImplementationOnce((_db: unknown, _entra: unknown, _userId: string, _now: Date, onGrant: any) => new Promise((resolve) => {
      completeToken = async () => { const row = w.state().connection;
        onGrant({ tokenCacheEnc: row.tokenCacheEnc, connectedAt: NOW, cursorLinkHash: row.cursorLinkHash, mailEnabled: row.mailEnabled, emailAccountId: row.emailAccountId });
        resolve("ephemeral-secret-token"); };
    }));
    const pending = setMicrosoftMailEnabled(w.db, "person", true, {} as any, w.client);
    await vi.waitFor(() => expect(auth.getAccessToken).toHaveBeenCalled());
    await setMicrosoftMailEnabled(w.db, "person", false, {} as any, w.client);
    await completeToken();
    expect(await pending).toBe(false);
    expect(w.getPage).not.toHaveBeenCalled();
    expect(w.state().accounts).toEqual([]);
  });
  it("purges only the owned archive and mail cursors while preserving the calendar", async () => {
    const w = world({ mailEnabled: true, emailAccountId: "owned" });
    w.state().accounts.push({ id: "owned", userId: "person", address: "primary@example.test", authMode: "M365_GRAPH" },
      { id: "foreign", userId: "other", address: "other@example.test", authMode: "M365_GRAPH" });
    w.state().messages.push({ accountId: "owned" }, { accountId: "foreign" });
    w.state().folders.push({ accountId: "owned" }); w.state().memberships.push({ accountId: "owned" });
    w.state().cursors.push({ id: "mail-cursor", userId: "person", workload: "mail" }, { id: "other-cursor", userId: "other", workload: "mail" });
    await setMicrosoftMailEnabled(w.db, "person", false, {} as any, w.client);
    expect(w.state().accounts.map((a: any) => a.id)).toEqual(["foreign"]);
    expect(w.state().messages).toEqual([{ accountId: "foreign" }]);
    expect(w.state().folders).toEqual([]); expect(w.state().memberships).toEqual([]);
    expect(w.state().connection).toMatchObject({ mailEnabled: false, emailAccountId: null, calendarEnabled: true, calendarSourceId: "calendar" });
    expect(w.state().cursors.map((c: any) => c.id)).toEqual(["calendar-cursor", "other-cursor"]);
  });
  it("never purges a foreign account even if an inconsistent connection points to it", async () => {
    const w = world({ mailEnabled: true, emailAccountId: "foreign" });
    w.state().accounts.push({ id: "foreign", userId: "other", address: "other@example.test", authMode: "M365_GRAPH" });
    await w.db.$transaction((tx) => purgeMicrosoftMail(tx, "person"));
    expect(w.state().accounts).toHaveLength(1);
    expect(w.state().connection.emailAccountId).toBeNull();
  });
  it("direct mailbox removal disables mail and its cursors without disconnecting Microsoft calendar", async () => {
    const w = world({ mailEnabled: true, emailAccountId: "owned" });
    w.state().accounts.push({ id: "owned", userId: "person", address: "primary@example.test", authMode: "M365_GRAPH" });
    w.state().cursors.push({ id: "mail-cursor", userId: "person", workload: "mail" });
    expect(await disconnectMailbox(w.db, "owned")).toEqual({ removed: true, address: "primary@example.test" });
    expect(w.state().accounts).toEqual([]);
    expect(w.state().connection).toMatchObject({ state: "CONNECTED", mailEnabled: false, calendarEnabled: true, calendarSourceId: "calendar" });
    expect(w.state().cursors.map((c: any) => c.id)).toEqual(["calendar-cursor"]);
  });
  it("locks only the active, owned mailbox of the exact current connection generation", async () => {
    const w = world({ mailEnabled: true, emailAccountId: "owned" });
    w.state().accounts.push({ id: "owned", userId: "person", address: "primary@example.test", authMode: "M365_GRAPH" });
    expect(await lockMicrosoftMailConnection(w.db, "person", { tokenCacheEnc: "cache", connectedAt: NOW, cursorLinkHash: "identity", emailAccountId: "owned" }))
      .toMatchObject({ account: { id: "owned" }, ownerUsername: "owner" });
    expect(await lockMicrosoftMailConnection(w.db, "person", { tokenCacheEnc: "old-cache" })).toBeNull();
    w.state().person.directoryStatus = "DISABLED";
    expect(await lockMicrosoftMailConnection(w.db, "person")).toBeNull();
  });
});
