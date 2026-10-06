import { describe, expect, it, vi } from "vitest";
import type { Role, ToolContext } from "../../../src/types.js";
import emailAccounts from "../../../src/handlers/email/accounts.js";
import emailSearch from "../../../src/handlers/email/search.js";
import emailRead from "../../../src/handlers/email/read.js";

const makeContext = (role: Role | undefined = "family", userId: string | undefined = "person-id") => {
  const get = vi.fn();
  const ctx = { role, userId, http: { orchestrator: { get } }, signal: new AbortController().signal } as unknown as ToolContext;
  return { get, ctx };
};
const account = { id: "outlook-1", address: "sam@company.example", displayName: "Work Outlook", authMode: "M365_GRAPH", canSend: false, imapStatus: "connected", lastIdleAt: "2026-10-05T12:00:00Z" };

describe("email_accounts", () => {
  it.each([undefined, "guest", "service"] as const)("refuses role %s without requesting mailbox identifiers", async (role) => {
    const { get, ctx } = makeContext();
    ctx.role = role;
    const result = await emailAccounts.handler({}, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(get).not.toHaveBeenCalled();
  });
  it("refuses an absent acting person without HTTP", async () => {
    const { get, ctx } = makeContext();
    ctx.userId = undefined;
    expect(await emailAccounts.handler({}, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin", "family"] as const)("forwards role %s's identity and only safe account metadata", async (role) => {
    const { get, ctx } = makeContext(role);
    get.mockResolvedValue(new Response(JSON.stringify({ accounts: [{ ...account, userId: "private-owner", lastError: "private-provider-error", oauthToken: "private-token", password: "private-password" }] })));
    const result = await emailAccounts.handler({}, ctx);
    expect(get).toHaveBeenCalledWith("/api/email/accounts", { headers: { Accept: "application/json", "X-Droplet-User": "person-id" } });
    expect(result).toEqual({ ok: true, data: { type: "email_accounts", accountCount: 1, accounts: [account] } });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("returns no invented mailbox IDs when none are connected", async () => {
    const { get, ctx } = makeContext();
    get.mockResolvedValue(new Response(JSON.stringify({ accounts: [] })));
    expect(await emailAccounts.handler({}, ctx)).toEqual({ ok: true, data: { type: "email_accounts", accountCount: 0, accounts: [] } });
  });
  it("does not expose raw failure bodies", async () => {
    const { get, ctx } = makeContext();
    get.mockResolvedValue(new Response("private-server-body", { status: 403 }));
    expect(await emailAccounts.handler({}, ctx)).toEqual({ ok: false, status: "error", error: { code: "EMAIL_ACCOUNTS_FAILED", message: "orchestrator returned 403" } });
  });
  it("lets the assistant discover an Outlook inbox, search its local bodies, then read the full conversation", async () => {
    const { get, ctx } = makeContext();
    const thread = { id: "thread-7", subject: "Follow-up", snippet: "Please review…" };
    const body = "Please review the renewal agreement by Friday. The full terms follow in this imported message.";
    get.mockImplementation(async (url: string) => {
      if (url === "/api/email/accounts") return new Response(JSON.stringify({ accounts: [account] }));
      if (url === "/api/email/outlook-1/threads?filter=inbox&limit=20&query=renewal+agreement") return new Response(JSON.stringify({ filter: "inbox", threads: [thread] }));
      if (url === "/api/email/outlook-1/threads/thread-7") return new Response(JSON.stringify({ ...thread, accountId: "outlook-1", messages: [{ id: "message-7", bodyText: body, hasAttachments: true, externalAttachmentMetadata: null }] }));
      throw new Error(`unexpected request ${url}`);
    });
    const discovered = await emailAccounts.handler({}, ctx);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const mailbox = (discovered.data as { accounts: typeof account[] }).accounts[0];
    expect(mailbox.canSend).toBe(false);
    const matches = await emailSearch.handler({ accountId: mailbox.id, query: "renewal agreement" }, ctx);
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    const found = (matches.data as { threads: typeof thread[] }).threads[0];
    const read = await emailRead.handler({ accountId: mailbox.id, threadId: found.id }, ctx);
    expect(read).toMatchObject({ ok: true, data: { type: "email_thread", messages: [{ bodyText: body, hasAttachments: true }] } });
    expect(get).toHaveBeenCalledTimes(3);
    for (const [, options] of get.mock.calls) expect(options).toEqual({ headers: { Accept: "application/json", "X-Droplet-User": "person-id" } });
  });
});
