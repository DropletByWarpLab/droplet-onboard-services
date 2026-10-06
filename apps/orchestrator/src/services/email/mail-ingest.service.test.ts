import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { intake, warn } = vi.hoisted(() => ({ intake: vi.fn(async () => {}), warn: vi.fn() }));
vi.mock("../support/email-intake.service.js", () => ({ intakeEmailMessage: intake }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn }) }));
import { afterCommitEmailIngest, MailIngestAccountMissingError, MailIngestAttachmentError,
  MailIngestValidationError, prepareEmailIngest, storeEmailIngest } from "./mail-ingest.service.js";

const payload = { messageId: "message@example.com", fromAddr: "sender@example.com", toAddrs: ["owner@example.com"],
  subject: "Invoice", bodyText: "The invoice is attached.", receivedAt: "2026-10-05T15:00:00.000Z", threadKey: "root@example.com" };
const native = { providerMessageId: "immutable-id", internetMessageId: "<message@example.com>", hasAttachments: true,
  externalAttachmentMetadata: [{ name: "invoice.pdf", size: 4, contentType: "application/pdf" }] };

function fakeStore() {
  let threads: any[] = [];
  let messages: any[] = [];
  let serial = 0;
  const db = {
    emailAccount: { updateMany: vi.fn(async () => ({ count: 1 })) },
    emailMessage: {
      findUnique: vi.fn(async ({ where }: any) => messages.find((row) =>
        row.accountId === where.accountId_messageId.accountId && row.messageId === where.accountId_messageId.messageId) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { id: `message-${++serial}`, ...data }; messages.push(row); return row; }),
    },
    emailThread: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.accountId_threadKey;
        let row = threads.find((entry) => entry.accountId === key.accountId && entry.threadKey === key.threadKey);
        if (row) Object.assign(row, update);
        else { row = { id: `thread-${++serial}`, ...create }; threads.push(row); }
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = threads.find((entry) => entry.id === where.id);
        row.messageCount += data.messageCount.increment;
        const { messageCount, ...metadata } = data;
        Object.assign(row, metadata);
        return { ...row };
      }),
    },
  };
  return { db, tx: db as unknown as Prisma.TransactionClient, prisma: db as unknown as PrismaClient,
    threads: () => threads, messages: () => messages,
    transaction: async <T>(operation: () => Promise<T>) => {
      const prior = structuredClone({ threads, messages });
      try { return await operation(); }
      catch (error) { threads = prior.threads; messages = prior.messages; throw error; }
    },
  };
}

beforeEach(() => { intake.mockReset().mockResolvedValue(undefined); warn.mockClear(); });
describe("canonical local mailbox ingestion", () => {
  it("measures attachments and returns local message identity without doing intake inside the transaction", async () => {
    const store = fakeStore();
    const bytes = Buffer.from("%PDF");
    const prepared = prepareEmailIngest("account-a", { ...payload, attachments: [{
      filename: "../../invoice\u202Efdp.exe", contentType: "application/pdf", size: 1, sha256: "0".repeat(64),
      status: "stored", data: bytes.toString("base64"),
    }] });
    const result = await storeEmailIngest(store.tx, prepared);
    expect(result).toMatchObject({ emailMessageId: store.messages()[0].id, accountId: "account-a", messageId: payload.messageId,
      threadId: store.threads()[0].id, duplicate: false, intakeEligible: true });
    expect(store.messages()[0].attachments.create[0]).toMatchObject({ accountId: "account-a", filename: "invoice_fdp.exe",
      size: 4, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(store.threads()[0].messageCount).toBe(1);
    expect(intake).not.toHaveBeenCalled();
    expect(store.db.emailAccount.updateMany.mock.invocationCallOrder[0]).toBeLessThan(store.db.emailMessage.findUnique.mock.invocationCallOrder[0]!);
    await afterCommitEmailIngest(store.prisma, [result]);
    expect(intake).toHaveBeenCalledWith(store.prisma, "account-a", payload.messageId);
  });

  it("deduplicates by mailbox and message ID without rewinding thread metadata or incrementing twice", async () => {
    const store = fakeStore();
    const first = await storeEmailIngest(store.tx, prepareEmailIngest("account-a", payload));
    const duplicate = await storeEmailIngest(store.tx, prepareEmailIngest("account-a", { ...payload, subject: "Old replay", bodyText: "Old body" }));
    expect(duplicate).toMatchObject({ duplicate: true, emailMessageId: first.emailMessageId, threadId: first.threadId });
    expect(store.db.emailThread.upsert).toHaveBeenCalledOnce();
    expect(store.threads()[0]).toMatchObject({ messageCount: 1, subject: "Invoice", snippet: payload.bodyText });
    const other = await storeEmailIngest(store.tx, prepareEmailIngest("account-b", payload));
    expect(other.emailMessageId).not.toBe(first.emailMessageId);
    expect(store.messages()).toHaveLength(2);
    await afterCommitEmailIngest(store.prisma, [duplicate, duplicate]);
    expect(intake).toHaveBeenCalledOnce();
  });

  it("message, nested attachments and thread count roll back with an outer membership failure", async () => {
    const store = fakeStore();
    await expect(store.transaction(async () => {
      await storeEmailIngest(store.tx, prepareEmailIngest("account-a", payload));
      throw new Error("Folder membership unavailable");
    })).rejects.toThrow("Folder membership unavailable");
    expect(store.messages()).toHaveLength(0);
    expect(store.threads()).toHaveLength(0);
    expect(intake).not.toHaveBeenCalled();
  });

  it("historical messages cannot rewind the inbox caption, sender, snippet or sorting timestamp", async () => {
    const store = fakeStore();
    await storeEmailIngest(store.tx, prepareEmailIngest("account-a", { ...payload, fromName: "Latest sender" }));
    const original = { ...store.threads()[0] };
    await storeEmailIngest(store.tx, prepareEmailIngest("account-a", { ...payload, messageId: "older@example.com",
      subject: "Old subject", bodyText: "Old snippet", fromName: "Old sender", receivedAt: "2025-01-01T12:00:00.000Z" }));
    expect(store.threads()[0]).toMatchObject({ ...original, messageCount: 2 });
    expect(store.messages()).toHaveLength(2);
    await storeEmailIngest(store.tx, prepareEmailIngest("account-a", { ...payload, messageId: "newest@example.com",
      subject: "Newest subject", bodyText: "Newest snippet", fromName: "Newest sender", receivedAt: "2026-10-06T12:00:00.000Z" }));
    expect(store.threads()[0]).toMatchObject({ messageCount: 3, subject: "Newest subject", snippet: "Newest snippet",
      lastSender: "Newest sender", lastMessageAt: new Date("2026-10-06T12:00:00.000Z") });
  });

  it("stores native provider facts separately and never auto-queues SMTP support intake for Outlook", async () => {
    const store = fakeStore();
    const prepared = prepareEmailIngest("account-a", { ...payload, messageId: "m365:immutable-id", toAddrs: [] }, native);
    const result = await storeEmailIngest(store.tx, prepared);
    expect(store.messages()[0]).toMatchObject({ messageId: "m365:immutable-id", ...native, toAddrs: [] });
    expect(result.intakeEligible).toBe(false);
    await afterCommitEmailIngest(store.prisma, [result]);
    expect(intake).not.toHaveBeenCalled();
    expect(() => prepareEmailIngest("account-a", { ...payload, toAddrs: [] })).toThrow(MailIngestValidationError);
  });

  it("allows Exchange's 500 native recipients while retaining the legacy 100 recipient bound", () => {
    const recipients = Array.from({ length: 500 }, (_value, index) => `person-${index}@example.com`);
    expect(prepareEmailIngest("account-a", { ...payload, toAddrs: recipients, ccAddrs: recipients }, native).payload.toAddrs).toHaveLength(500);
    expect(() => prepareEmailIngest("account-a", { ...payload, toAddrs: recipients })).toThrow(MailIngestValidationError);
  });

  it("public legacy payload fields cannot inject native metadata or disable support intake", async () => {
    const store = fakeStore();
    const result = await storeEmailIngest(store.tx, prepareEmailIngest("account-a", { ...payload, ...native, intakeEligible: false }));
    expect(store.messages()[0]).not.toHaveProperty("providerMessageId");
    expect(result.intakeEligible).toBe(true);
  });

  it("fails before creating mail if its account disappeared, and keeps intake errors after commit generic", async () => {
    const store = fakeStore();
    store.db.emailAccount.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(storeEmailIngest(store.tx, prepareEmailIngest("account-a", payload))).rejects.toBeInstanceOf(MailIngestAccountMissingError);
    expect(store.db.emailMessage.create).not.toHaveBeenCalled();
    const result = await storeEmailIngest(store.tx, prepareEmailIngest("account-a", payload));
    intake.mockRejectedValueOnce(new Error("MESSAGE_CONTENT_SECRET"));
    await afterCommitEmailIngest(store.prisma, [result]);
    expect(store.messages()).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("MESSAGE_CONTENT_SECRET");
  });

  it("retains attachment limit/error classifications before any inbox writes", () => {
    const attachment = { filename: "f.pdf", contentType: "application/pdf", size: 0, sha256: "0".repeat(64), status: "stored" };
    expect(() => prepareEmailIngest("account-a", { ...payload, attachments: [attachment] })).toThrow(MailIngestAttachmentError);
    try { prepareEmailIngest("account-a", { ...payload, attachments: [{ ...attachment, status: "too_large", data: "eA==" }] }); }
    catch (error) { expect(error).toMatchObject({ status: 400, code: "attachment_data_not_stored" }); }
    try { prepareEmailIngest("account-a", { ...payload, attachments: Array.from({ length: 21 }, () => ({ ...attachment, data: "eA==" })) }); }
    catch (error) { expect(error).toMatchObject({ status: 413, code: "attachment_limit_exceeded" }); }
  });
});
