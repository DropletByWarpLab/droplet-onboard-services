import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../support/email-intake.service.js", () => ({ intakeEmailMessage: vi.fn(async () => {}) }));
import { createMicrosoftMailPageHandler } from "./mail-landing.service.js";
import { GraphClient, GraphRequestError, type GraphPage } from "./graph-client.js";
import type { DueCursor } from "./delta-cursor.service.js";
import { syncCursor, type PageContext } from "./m365-sync.service.js";
import { initialUrlFor } from "./graph-resources.js";
import * as authService from "./m365-auth.service.js";
import { MicrosoftMailUnavailableError } from "./mail-normalizer.js";

const NOW = new Date("2026-10-05T12:00:00Z");
function message(id: string, extra: Record<string, unknown> = {}) {
  return { id, internetMessageId: `<${id}@example.test>`, conversationId: "conversation", parentFolderId: "inbox", subject: "Archive me",
    body: { contentType: "text", content: `Complete text of ${id}` }, from: { emailAddress: { address: "sender@example.test", name: "Sender" } },
    sender: null, toRecipients: [{ emailAddress: { address: "owner@example.test" } }], ccRecipients: [],
    receivedDateTime: "2026-10-05T10:00:00Z", createdDateTime: "2026-10-05T09:00:00Z", isDraft: false,
    hasAttachments: false, internetMessageHeaders: [], ...extra };
}
function page(items: unknown[], last = true): GraphPage {
  return { items, raw: { value: items }, links: { nextLink: last ? null : "https://graph.microsoft.com/v1.0/next", deltaLink: last ? "https://graph.microsoft.com/v1.0/delta?$deltatoken=checkpoint" : null } } as GraphPage;
}
function matches(row: any, where: any): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (key === "AND") return value.every((part: any) => matches(row, part));
    if (value instanceof Date) return row[key] instanceof Date && value.getTime() === row[key].getTime();
    if (value !== null && typeof value === "object" && "not" in value) return row[key] !== value.not;
    return row[key] === value;
  });
}
function world() {
  let serial = 0;
  let state: any = { person: { id: "person", username: "owner", directoryStatus: "ACTIVE", deletionStatus: "NONE" },
    connection: { userId: "person", state: "CONNECTED", mailEnabled: true, mailSyncState: "WAITING", emailAccountId: "account",
      grantedScopes: "Mail.Read", tokenCacheEnc: "cache-generation", cursorLinkHash: "identity-generation", connectedAt: NOW },
    account: { id: "account", userId: "person", address: "owner@example.test", authMode: "M365_GRAPH", lastIdleAt: null },
    cursors: [{ id: "cursor", userId: "person", workload: "mail", resourceId: "inbox", deltaLink: null, resumeLink: null, state: "IDLE" }],
    folders: [], memberships: [], messages: [], threads: [] };
  const db: any = {
    user: { findFirst: vi.fn(async ({ where }: any) => matches(state.person, where) ? { ...state.person } : null) },
    m365Connection: { findUnique: vi.fn(async () => ({ ...state.connection })),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!matches(state.connection, where)) return { count: 0 }; Object.assign(state.connection, data); return { count: 1 }; }) },
    emailAccount: { findFirst: vi.fn(async ({ where }: any) => matches(state.account, where) ? { ...state.account } : null),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!matches(state.account, where)) return { count: 0 }; Object.assign(state.account, data); return { count: 1 }; }) },
    m365DeltaCursor: { findFirst: vi.fn(async ({ where }: any) => state.cursors.find((c: any) => matches(c, where)) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => { const rows = state.cursors.filter((c: any) => matches(c, where));
        rows.forEach((row: any) => Object.assign(row, data)); return { count: rows.length }; }) },
    m365MailFolder: { upsert: vi.fn(async ({ where, create, update }: any) => { const row = state.folders.find((f: any) => matches(f, where.accountId_folderId));
        if (row) return Object.assign(row, update); const next = { id: `folder-${++serial}`, externalSyncRun: null, ...create }; state.folders.push(next); return next; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const rows = state.folders.filter((f: any) => matches(f, where)); rows.forEach((r: any) => Object.assign(r, data)); return { count: rows.length }; }) },
    m365MailMembership: { upsert: vi.fn(async ({ where, create, update }: any) => { const row = state.memberships.find((m: any) => matches(m, where.accountId_folderId_providerMessageId));
        if (row) return Object.assign(row, update); const next = { id: `member-${++serial}`, externalSeenRun: null, ...create }; state.memberships.push(next); return next; }),
      deleteMany: vi.fn(async ({ where }: any) => { const before = state.memberships.length; state.memberships = state.memberships.filter((m: any) => !matches(m, where)); return { count: before - state.memberships.length }; }) },
    emailMessage: { findUnique: vi.fn(async ({ where }: any) => state.messages.find((m: any) => matches(m, where.accountId_messageId)) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { id: `message-${++serial}`, ...data }; state.messages.push(row); return row; }) },
    emailThread: { upsert: vi.fn(async ({ where, create, update }: any) => { const row = state.threads.find((t: any) => matches(t, where.accountId_threadKey));
        if (row) return Object.assign(row, update); const next = { id: `thread-${++serial}`, ...create }; state.threads.push(next); return next; }),
      update: vi.fn(async ({ where, data }: any) => { const row = state.threads.find((t: any) => matches(t, where)); row.messageCount += data.messageCount.increment; return row; }) },
    $transaction: vi.fn(async (work: any) => {
      if (beforeTransaction) { const change = beforeTransaction; beforeTransaction = undefined; change(state); }
      const snapshot = structuredClone(state);
      try { return await work(db); } catch (error) { state = snapshot; throw error; }
    }),
  };
  let beforeTransaction: ((s: any) => void) | undefined;
  const getPage = vi.fn(async (_url: string, _token: string, _options: unknown) => ({ raw: message("one"), items: [], links: { deltaLink: null, nextLink: null } } as GraphPage));
  const run = (overrides: Partial<PageContext> = {}): PageContext => ({ fullEnumeration: true, isFirstPage: true, isLastPage: true,
    accessToken: "secret-bearer", grantGeneration: { tokenCacheEnc: "cache-generation", cursorLinkHash: "identity-generation", connectedAt: NOW,
      mailEnabled: true, emailAccountId: "account" }, ...overrides });
  const cursor = (overrides: Partial<DueCursor> = {}): DueCursor => ({ ...state.cursors[0], cursorLinkHash: "identity-generation", ...overrides });
  return { db: db as PrismaClient, state: () => state, cursor, run, getPage,
    handler: createMicrosoftMailPageHandler(db, { getPage } as unknown as GraphClient, () => NOW),
    beforeTransaction: (change: (s: any) => void) => { beforeTransaction = change; } };
}

describe("Microsoft folder-scoped local mail landing", () => {
  it("runs production syncCursor, Graph preferences and real landing with an IDLE folder claim", async () => {
    const w = world();
    const fetchImpl = vi.fn(async (_url: string, _init?: Record<string, unknown>) => new Response(JSON.stringify({
      value: [message("one")], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new GraphClient({ fetchImpl });
    const token = vi.spyOn(authService, "getAccessToken").mockImplementationOnce(async (_db, _entra, _user, _now, onGrant) => {
      onGrant?.({ tokenCacheEnc: "cache-generation", cursorLinkHash: "identity-generation", connectedAt: NOW, mailEnabled: true, emailAccountId: "account" });
      return "ephemeral-secret-token";
    });
    try {
      const result = await syncCursor({ prisma: w.db, client, entra: {} as any,
        initialUrlFor: (workload, resource) => initialUrlFor(workload, resource, NOW),
        handlePage: createMicrosoftMailPageHandler(w.db, client, () => NOW), now: () => NOW, mailModuleEnabled: true }, w.cursor());
      expect(result).toMatchObject({ completed: true, pages: 1, items: 1 });
      expect(w.state().messages[0]).toMatchObject({ bodyText: "Complete text of one", providerMessageId: "one" });
      expect(w.state().connection.mailSyncState).toBe("CONNECTED");
      expect(w.state().account.lastIdleAt).toEqual(NOW);
      expect(w.state().cursors[0]).toMatchObject({ state: "IDLE", deltaLink: expect.stringContaining("$deltatoken=next") });
      const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.Prefer).toBe('odata.maxpagesize=100, IdType="ImmutableId", outlook.body-content-type="text"');
      expect(JSON.stringify(result)).not.toContain("ephemeral-secret-token");
    } finally { token.mockRestore(); }
  });
  it("accepts the production IDLE claim and makes a non-final committed page immediately readable", async () => {
    const w = world();
    expect(w.cursor().state).toBe("IDLE");
    await w.handler(w.cursor(), page([message("one")], false), w.run({ isLastPage: false }));
    expect(w.state().messages).toHaveLength(1);
    expect(w.state().connection.mailSyncState).toBe("CONNECTED");
    expect(w.state().account.lastIdleAt).toEqual(NOW);
    expect(w.state().folders[0].lastSyncAt).toBeUndefined();
  });
  it("stores full content and native identity atomically, retries without duplicate messages or thread count", async () => {
    const w = world();
    await w.handler(w.cursor(), page([message("one")]), w.run());
    await w.handler(w.cursor(), page([message("one")]), w.run());
    expect(w.state().messages).toHaveLength(1);
    expect(w.state().messages[0]).toMatchObject({ messageId: "m365:one", providerMessageId: "one", internetMessageId: "<one@example.test>", bodyText: "Complete text of one" });
    expect(w.state().threads[0].messageCount).toBe(1);
    expect(w.state().memberships).toHaveLength(1);
    expect(w.state().connection.mailSyncState).toBe("CONNECTED");
    expect(w.state().account.lastIdleAt).toEqual(NOW);
  });
  it("moves across folders with one archived message, then remote deletion removes membership only", async () => {
    const w = world();
    await w.handler(w.cursor(), page([message("one")]), w.run());
    await w.handler(w.cursor(), page([{ id: "one", "@removed": { reason: "deleted" } }]), w.run({ fullEnumeration: false }));
    w.state().cursors.push({ ...w.cursor(), id: "destination-cursor", resourceId: "projects" });
    await w.handler(w.cursor({ id: "destination-cursor", resourceId: "projects" }), page([message("one", { parentFolderId: "projects" })]), w.run());
    expect(w.state().messages).toHaveLength(1);
    expect(w.state().memberships.map((m: any) => m.folderId)).toEqual(["projects"]);
    await w.handler(w.cursor({ id: "destination-cursor", resourceId: "projects" }), page([{ id: "one", "@removed": { reason: "deleted" } }]), w.run({ fullEnumeration: false }));
    expect(w.state().memberships).toEqual([]);
    expect(w.state().messages).toHaveLength(1);
  });
  it("retains full-run markers across final checkpoint retry and sweeps only this folder membership", async () => {
    const w = world();
    w.state().memberships.push({ accountId: "account", folderId: "inbox", providerMessageId: "stale", externalSeenRun: null },
      { accountId: "foreign", folderId: "inbox", providerMessageId: "foreign", externalSeenRun: null });
    await w.handler(w.cursor(), page([message("one")], false), w.run({ isLastPage: false }));
    const marker = w.state().folders[0].externalSyncRun;
    await w.handler(w.cursor(), page([message("two")]), w.run({ isFirstPage: false }));
    await w.handler(w.cursor(), page([message("two")]), w.run({ isFirstPage: false }));
    expect(w.state().folders[0].externalSyncRun).toBe(marker);
    expect(w.state().memberships.map((m: any) => m.providerMessageId).sort()).toEqual(["foreign", "one", "two"]);
    expect(w.state().messages).toHaveLength(2);
  });
  it("hydrates a partial update with immutable/text headers and follows its current folder", async () => {
    const w = world();
    w.getPage.mockResolvedValueOnce({ raw: message("one", { parentFolderId: "elsewhere" }), items: [], links: { deltaLink: null, nextLink: null } } as GraphPage);
    await w.handler(w.cursor(), page([{ id: "one", isRead: true }]), w.run({ fullEnumeration: false }));
    expect(w.getPage).toHaveBeenCalledWith(expect.stringContaining("/me/messages/one?$select="), "secret-bearer", { mail: true });
    expect(w.state().messages).toHaveLength(1);
    expect(w.state().memberships).toEqual([]);
  });
  it("hydrates duplicate unordered entries once and lets the current full representation win", async () => {
    const w = world();
    await w.handler(w.cursor(), page([message("one"), { id: "one", "@removed": { reason: "deleted" } }, { id: "one", isRead: true }]), w.run());
    expect(w.getPage).toHaveBeenCalledTimes(1);
    expect(w.state().messages).toHaveLength(1);
    expect(w.state().memberships).toHaveLength(1);
  });
  it("excludes drafts after hydration, then imports their complete sent content", async () => {
    const w = world();
    w.getPage.mockResolvedValueOnce({ raw: message("one", { isDraft: true, from: null, toRecipients: [] }), items: [], links: { deltaLink: null, nextLink: null } } as GraphPage);
    await w.handler(w.cursor(), page([{ id: "one", isDraft: true }]), w.run());
    expect(w.state().messages).toEqual([]);
    expect(w.state().memberships).toEqual([]);
    await w.handler(w.cursor(), page([message("one")]), w.run());
    expect(w.state().messages[0].bodyText).toBe("Complete text of one");
  });
  it("handles deletion between delta and hydration without deleting an archived message", async () => {
    const w = world();
    await w.handler(w.cursor(), page([message("one")]), w.run());
    w.getPage.mockRejectedValueOnce(new GraphRequestError({ statusCode: 404, message: "Not found" }));
    await w.handler(w.cursor(), page([{ id: "one", isRead: true }]), w.run({ fullEnumeration: false }));
    expect(w.state().memberships).toEqual([]);
    expect(w.state().messages).toHaveLength(1);
  });
  it.each(["disconnect", "off", "leaver", "generation", "identity", "account", "cursor", "checkpoint"])("rejects a late page after %s without writes", async (kind) => {
    const w = world();
    w.beforeTransaction((s) => {
      if (kind === "disconnect") s.connection.state = "DISCONNECTED";
      if (kind === "off") s.connection.mailEnabled = false;
      if (kind === "leaver") s.person.directoryStatus = "DISABLED";
      if (kind === "generation") s.connection.tokenCacheEnc = "replacement-cache";
      if (kind === "identity") s.connection.cursorLinkHash = "replacement-identity";
      if (kind === "account") s.account.userId = "another-person";
      if (kind === "cursor") s.cursors = [];
      if (kind === "checkpoint") s.cursors[0].resumeLink = "new-checkpoint";
    });
    await expect(w.handler(w.cursor(), page([message("one")]), w.run())).rejects.toThrow(MicrosoftMailUnavailableError);
    expect(w.state().messages).toEqual([]);
    expect(w.state().memberships).toEqual([]);
    expect(w.state().folders).toEqual([]);
  });
  it.each(["envelope", "continuation", "item", "hydration", "identity"])("rejects malformed %s before page writes", async (kind) => {
    const w = world();
    let input = page([message("one"), message("two")]);
    if (kind === "envelope") input = { ...input, raw: { value: undefined } };
    if (kind === "continuation") input = { ...input, links: { deltaLink: null, nextLink: null } };
    if (kind === "item") input = page([message("one"), message("two", { body: { contentType: "text" } })]);
    if (kind === "hydration" || kind === "identity") {
      input = page([message("one"), { id: "two", isRead: true }]);
      w.getPage.mockResolvedValueOnce({ raw: kind === "hydration" ? { id: "two", isRead: true } : message("wrong-message"), items: [], links: { deltaLink: null, nextLink: null } } as GraphPage);
    }
    await expect(w.handler(w.cursor(), input, w.run())).rejects.toThrow(MicrosoftMailUnavailableError);
    expect(w.db.$transaction).not.toHaveBeenCalled();
    expect(w.state().messages).toEqual([]);
    expect(w.state().memberships).toEqual([]);
  });
  it("rolls back all page inserts if one canonical insert fails", async () => {
    const w = world();
    const create = vi.mocked(w.db.emailMessage.create) as unknown as ReturnType<typeof vi.fn>;
    create.mockImplementationOnce(async (args: any) => { const row = { id: "first", ...args.data }; w.state().messages.push(row); return row; });
    create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(w.handler(w.cursor(), page([message("one"), message("two")]), w.run())).rejects.toThrow("database unavailable");
    expect(w.state().messages).toEqual([]);
    expect(w.state().memberships).toEqual([]);
    expect(w.state().folders).toEqual([]);
  });
});
