import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createEmailRouter } from "./email.js";

vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));

type Row = Record<string, any>;
const date = new Date("2026-10-05T10:00:00.000Z");
function fixture(role = "family") {
  const accounts = [{ id: "a1", userId: "u1", passwordEnc: "secret" }, { id: "a2", userId: "u2", passwordEnc: "other-secret" }];
  const threads: Row[] = ["c", "b", "a"].map(id => ({ id, accountId: "a1", triageStatus: "inbox", draftedByDroplet: false, lastMessageAt: date, subject: id }));
  threads.push({ id: "old", accountId: "a1", triageStatus: "inbox", draftedByDroplet: false, lastMessageAt: new Date(date.getTime() - 1000), subject: "Older" });
  threads.push({ id: "foreign", accountId: "a2", triageStatus: "inbox", lastMessageAt: date });
  const drafts: Row[] = ["c", "b", "a"].map(id => ({ id: "draft-" + id, accountId: "a1", threadId: null, toAddrs: ["to@example.com"], subject: id, body: "Private draft " + id, status: "draft", attachmentIds: [], updatedAt: date, createdAt: date, internalFutureField: "must-not-leak" }));
  drafts.push({ id: "queued", accountId: "a1", status: "queued", updatedAt: date, subject: "Queued", body: "Already dispatched", attachmentIds: [] });
  drafts.push({ id: "foreign-draft", accountId: "a2", status: "draft", updatedAt: date, body: "Someone else's mail", attachmentIds: [] });
  const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some(clause => matches(row, clause));
    if (value instanceof Date) return (row[key] as Date).getTime() === value.getTime();
    if (value && typeof value === "object" && "lt" in value) return row[key] < value.lt;
    return row[key] === value;
  });
  const project = (row: Row, select?: Row): Row => select ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : row;
  const many = (rows: Row[]) => vi.fn(async ({ where, orderBy, take, select }: Row) => {
    const sorted = rows.filter(row => matches(row, where));
    const order: Row[] = Array.isArray(orderBy) ? orderBy : [orderBy];
    sorted.sort((a, b) => {
      for (const clause of order) {
        const key = Object.keys(clause)[0]; const left = a[key] instanceof Date ? a[key].getTime() : a[key]; const right = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (left !== right) return (left < right ? -1 : 1) * (clause[key] === "desc" ? -1 : 1);
      }
      return 0;
    });
    return sorted.slice(0, take).map(row => project(row, select));
  });
  const prisma = {
    emailAccount: { findUnique: vi.fn(async ({ where, select }: Row) => { const row = accounts.find(a => a.id === where.id); return row ? project(row, select) : null; }) },
    emailThread: { findMany: many(threads) },
    emailDraft: { findMany: many(drafts), findFirst: vi.fn(async ({ where, select }: Row) => { const row = drafts.find(d => matches(d, where)); return row ? project(row, select) : null; }) },
    emailAttachment: { findMany: vi.fn(async ({ select }: Row) => [project({ id: "att-1", emailMessageId: "message-1", filename: "note.txt", size: 10, status: "stored", data: "private bytes", password: "never" }, select)]) },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "u1", username: "one", role } as never; next(); });
  app.use("/api", createEmailRouter(prisma as never, { outboundEmailEnabled: async () => true }));
  return { app, prisma, threads, drafts };
}

describe("native email saved reads and keyset paging", () => {
  it("pages timestamp ties without dropping or repeating a thread, even when a newer one arrives", async () => {
    const f = fixture(); const first = await request(f.app).get("/api/email/a1/threads?limit=1");
    expect(first.status).toBe(200); expect(first.body.threads.map((t: Row) => t.id)).toEqual(["c"]); expect(first.body.nextCursor).toEqual(expect.any(String));
    f.threads.push({ id: "new", accountId: "a1", triageStatus: "inbox", lastMessageAt: new Date(date.getTime() + 1000) });
    const second = await request(f.app).get("/api/email/a1/threads").query({ limit: 2, cursor: first.body.nextCursor });
    expect(second.body.threads.map((t: Row) => t.id)).toEqual(["b", "a"]);
    const third = await request(f.app).get("/api/email/a1/threads").query({ limit: 2, cursor: second.body.nextCursor });
    expect(third.body.threads.map((t: Row) => t.id)).toEqual(["old"]); expect(third.body.nextCursor).toBeNull();
  });
  it("binds cursors to account, filter and route and rejects malformed or overlong input before listing", async () => {
    const f = fixture("owner"); const first = await request(f.app).get("/api/email/a1/threads?limit=1");
    for (const url of ["/api/email/a2/threads", "/api/email/a1/threads?filter=triaged", "/api/email/a1/drafts"]) {
      const res = await request(f.app).get(url).query({ cursor: first.body.nextCursor }); expect(res.status).toBe(400); expect(res.body.error).toBe("invalid_email_cursor");
    }
    const before = f.prisma.emailThread.findMany.mock.calls.length;
    for (const cursor of ["!!!", "a".repeat(1025), Buffer.from("{}").toString("base64url")]) { expect((await request(f.app).get("/api/email/a1/threads").query({ cursor })).status).toBe(400); }
    expect(f.prisma.emailThread.findMany.mock.calls.length).toBe(before);
  });
  it("reads saved draft summaries without message bodies and scoped detail with explicit metadata only", async () => {
    const f = fixture(); const list = await request(f.app).get("/api/email/a1/drafts?limit=1");
    expect(list.status).toBe(200); expect(list.body.drafts[0].id).toBe("draft-c"); expect(list.body.drafts[0].body).toBeUndefined(); expect(list.body.drafts[0].internalFutureField).toBeUndefined();
    const next = await request(f.app).get("/api/email/a1/drafts").query({ limit: 2, cursor: list.body.nextCursor });
    expect(next.body.drafts.map((d: Row) => d.id)).toEqual(["draft-b", "draft-a"]); expect(next.body.nextCursor).toBeNull();
    const detail = await request(f.app).get("/api/email/a1/drafts/draft-c");
    expect(detail.status).toBe(200); expect(detail.body.body).toBe("Private draft c"); expect(detail.body.internalFutureField).toBeUndefined(); expect(JSON.stringify(detail.body)).not.toContain("passwordEnc");
  });
  it("can show an immutable queued draft without making it editable or dispatching mail", async () => {
    const f = fixture(); const res = await request(f.app).get("/api/email/a1/drafts?status=queued");
    expect(res.status).toBe(200); expect(res.body.drafts.map((d: Row) => d.id)).toEqual(["queued"]);
    const detail = await request(f.app).get("/api/email/a1/drafts/queued"); expect(detail.body.status).toBe("queued");
  });
  it("restores forwarded attachment metadata with its download message id, never stored bytes", async () => {
    const f = fixture(); f.drafts[0].attachmentIds = ["att-1"];
    const detail = await request(f.app).get("/api/email/a1/drafts/draft-c");
    expect(detail.body.attachments[0]).toMatchObject({ id: "att-1", emailMessageId: "message-1", filename: "note.txt" });
    expect(detail.body.attachments[0].data).toBeUndefined(); expect(detail.body.attachments[0].password).toBeUndefined();
    expect(f.prisma.emailAttachment.findMany).toHaveBeenCalledWith({ where: { accountId: "a1", id: { in: ["att-1"] } }, select: expect.any(Object), orderBy: { partIndex: "asc" } });
  });
  it("family cannot read foreign accounts or mix another account's draft into an owned path", async () => {
    const f = fixture();
    for (const path of ["/api/email/a2/drafts", "/api/email/a2/drafts/foreign-draft", "/api/email/a1/drafts/foreign-draft", "/api/email/a2/threads"]) {
      const res = await request(f.app).get(path).set("X-Droplet-User", "two"); expect(res.status).toBe(404); expect(JSON.stringify(res.body)).not.toContain("Someone else's");
    }
    expect(f.prisma.emailDraft.findMany).not.toHaveBeenCalled(); expect(f.prisma.emailThread.findMany).not.toHaveBeenCalled();
    expect(f.prisma.emailDraft.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { id: "foreign-draft", accountId: "a1" }, select: expect.any(Object) });
  });
  it.each(["owner", "admin"])("%s keeps existing household mailbox visibility", async role => {
    const f = fixture(role); expect((await request(f.app).get("/api/email/a2/drafts/foreign-draft")).status).toBe(200);
  });
  it.each(["guest", "service"])("%s is denied before any draft read", async role => {
    const f = fixture(role); expect((await request(f.app).get("/api/email/a1/drafts")).status).toBe(403); expect((await request(f.app).get("/api/email/a1/drafts/draft-c")).status).toBe(403);
    expect(f.prisma.emailAccount.findUnique).not.toHaveBeenCalled(); expect(f.prisma.emailDraft.findMany).not.toHaveBeenCalled(); expect(f.prisma.emailDraft.findFirst).not.toHaveBeenCalled();
  });
  it("bounds draft status and page size without touching the list", async () => {
    const f = fixture(); for (const query of ["status=unknown", "limit=0", "limit=101", "limit=1.5"]) { expect((await request(f.app).get("/api/email/a1/drafts?" + query)).status).toBe(400); }
    expect(f.prisma.emailDraft.findMany).not.toHaveBeenCalled();
  });
});
