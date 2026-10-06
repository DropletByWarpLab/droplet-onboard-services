/** Canonical local inbox storage for MIME indexer and delegated Outlook reads. */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createLogger } from "../../lib/logger.js";
import { EMAIL_HEADERS_SCHEMA } from "../support/email-headers.js";
import { intakeEmailMessage } from "../support/email-intake.service.js";

const logger = createLogger("email-ingest");
export const EMAIL_ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxStored: 20,
  maxListed: 50,
} as const;

/** The indexer applies the same limits and omits bytes for oversized parts. */
export const EMAIL_INGEST_SCHEMA = z.object({
  messageId: z.string().min(1).max(998),
  inReplyTo: z.string().max(998).nullable().optional(),
  fromAddr: z.string().email().max(254),
  fromName: z.string().max(254).nullable().optional(),
  toAddrs: z.array(z.string().email().max(254)).min(1).max(100),
  ccAddrs: z.array(z.string().email().max(254)).max(100).nullable().optional(),
  subject: z.string().max(998),
  bodyText: z.string().max(1_000_000).nullable().optional(),
  bodyHtml: z.string().max(2_000_000).nullable().optional(),
  receivedAt: z.string().datetime(),
  threadKey: z.string().min(1).max(998),
  // Absent headers retain the older indexer's unchecked automatic-mail status.
  headers: EMAIL_HEADERS_SCHEMA.optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(255), contentType: z.string().min(1).max(255),
    size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentId: z.string().max(998).nullable().optional(),
    status: z.enum(["stored", "too_large", "over_limit"]),
    data: z.string().max(Math.ceil(EMAIL_ATTACHMENT_LIMITS.maxBytes / 3) * 4).optional(),
  })).max(EMAIL_ATTACHMENT_LIMITS.maxListed).optional(),
});
export type EmailIngestPayload = z.infer<typeof EMAIL_INGEST_SCHEMA>;
const nativeIngestSchema = EMAIL_INGEST_SCHEMA.extend({
  // BCC-only messages and Exchange drafts may have no visible recipients.
  toAddrs: z.array(z.string().email().max(254)).max(500),
  ccAddrs: z.array(z.string().email().max(254)).max(500).nullable().optional(),
});
/** Only internal native-provider adapters may set these facts. */
export interface NativeMailIngestMetadata {
  providerMessageId: string;
  internetMessageId: string | null;
  externalAttachmentMetadata?: Prisma.InputJsonValue;
  hasAttachments: boolean;
}
export interface PreparedEmailIngest {
  accountId: string;
  payload: EmailIngestPayload;
  attachments: Prisma.EmailAttachmentUncheckedCreateWithoutEmailMessageInput[];
  native?: NativeMailIngestMetadata;
}
export interface EmailIngestResult {
  accountId: string;
  /** Canonical RFC Message-ID, or a provider adapter's stable synthetic key. */
  messageId: string;
  /** Local EmailMessage UUID, suitable for a folder membership foreign key. */
  emailMessageId: string;
  threadId: string;
  duplicate: boolean;
  /** Synthetic provider IDs cannot participate in SMTP support threading/auto-acks. */
  intakeEligible: boolean;
}
export class MailIngestValidationError extends Error {
  readonly status = 400;
  constructor(public readonly details: z.typeToFlattenedError<EmailIngestPayload>) {
    super("Invalid ingest payload"); this.name = "MailIngestValidationError";
  }
}
export class MailIngestAttachmentError extends Error {
  readonly status: 400 | 413;
  constructor(public readonly code: "attachment_data_not_stored" | "attachment_data_missing" | "attachment_limit_exceeded") {
    super(code); this.name = "MailIngestAttachmentError";
    this.status = code === "attachment_limit_exceeded" ? 413 : 400;
  }
}
export class MailIngestAccountMissingError extends Error {
  constructor() { super("Account not provisioned"); this.name = "MailIngestAccountMissingError"; }
}

/** Sender-controlled names are cleaned once for every inbox and download surface. */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069"<>:|?*]/g, "_")
    .replace(/^[.\s]+/, "").trim().slice(0, 200)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "_");
  return cleaned || "attachment";
}

/** Validate before any database writes. Stored byte sizes and hashes are measured here. */
export function prepareEmailIngest(accountId: string, value: unknown, native?: NativeMailIngestMetadata): PreparedEmailIngest {
  const parsed = (native ? nativeIngestSchema : EMAIL_INGEST_SCHEMA).safeParse(value);
  if (!parsed.success) throw new MailIngestValidationError(parsed.error.flatten());
  let stored = 0;
  let total = 0;
  const attachments: PreparedEmailIngest["attachments"] = [];
  for (const [partIndex, attachment] of (parsed.data.attachments ?? []).entries()) {
    const base = { accountId, partIndex, filename: sanitizeAttachmentFilename(attachment.filename),
      contentType: attachment.contentType, contentId: attachment.contentId ?? null, status: attachment.status };
    if (attachment.status !== "stored") {
      if (attachment.data !== undefined) throw new MailIngestAttachmentError("attachment_data_not_stored");
      attachments.push({ ...base, size: attachment.size, sha256: attachment.sha256, data: null });
      continue;
    }
    if (attachment.data === undefined) throw new MailIngestAttachmentError("attachment_data_missing");
    const bytes = Buffer.from(attachment.data, "base64");
    stored += 1; total += bytes.length;
    if (bytes.length > EMAIL_ATTACHMENT_LIMITS.maxBytes || total > EMAIL_ATTACHMENT_LIMITS.maxTotalBytes ||
      stored > EMAIL_ATTACHMENT_LIMITS.maxStored) throw new MailIngestAttachmentError("attachment_limit_exceeded");
    attachments.push({ ...base, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes });
  }
  return { accountId, payload: parsed.data, attachments, ...(native ? { native } : {}) };
}

/** Caller owns the transaction and any provider generation/owner lock. Acquire
 * the account row next so competing canonical ingests cannot cause P2002 to
 * abort a transaction that also records provider folder membership. */
export async function storeEmailIngest(tx: Prisma.TransactionClient, prepared: PreparedEmailIngest): Promise<EmailIngestResult> {
  const { accountId, payload, attachments, native } = prepared;
  const locked = await tx.emailAccount.updateMany({ where: { id: accountId }, data: { updatedAt: new Date() } });
  if (locked.count !== 1) throw new MailIngestAccountMissingError();
  const existing = await tx.emailMessage.findUnique({
    where: { accountId_messageId: { accountId, messageId: payload.messageId } }, select: { id: true, threadId: true },
  });
  if (existing) return { accountId, messageId: payload.messageId, emailMessageId: existing.id,
    threadId: existing.threadId, duplicate: true, intakeEligible: !native };
  const receivedAt = new Date(payload.receivedAt);
  const snippet = (payload.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  const thread = await tx.emailThread.upsert({
    where: { accountId_threadKey: { accountId, threadKey: payload.threadKey } },
    update: {},
    create: { accountId, threadKey: payload.threadKey, subject: payload.subject,
      lastSender: payload.fromName ?? payload.fromAddr, snippet, messageCount: 0, lastMessageAt: receivedAt },
  });
  const message = await tx.emailMessage.create({ data: {
    accountId, threadId: thread.id, messageId: payload.messageId, inReplyTo: payload.inReplyTo ?? null,
    fromAddr: payload.fromAddr, fromName: payload.fromName ?? null, toAddrs: payload.toAddrs as Prisma.InputJsonValue,
    ccAddrs: (payload.ccAddrs ?? null) as Prisma.InputJsonValue,
    subject: payload.subject, bodyText: payload.bodyText ?? null, bodyHtml: payload.bodyHtml ?? null, receivedAt,
    ...(payload.headers ? { headers: payload.headers as Prisma.InputJsonValue } : {}),
    ...(attachments.length ? { attachments: { create: attachments } } : {}),
    ...(native ?? {}),
  }, select: { id: true } });
  // History arrives in provider/folder order, which is not chronological.
  // The account lock serializes all canonical writers; only the latest new
  // message may change the inbox's caption, sender, snippet or sorting time.
  await tx.emailThread.update({ where: { id: thread.id }, data: {
    messageCount: { increment: 1 },
    ...(thread.lastMessageAt <= receivedAt ? { subject: payload.subject, lastSender: payload.fromName ?? payload.fromAddr,
      snippet: snippet.length > 0 ? snippet : undefined, lastMessageAt: receivedAt } : {}),
  } });
  return { accountId, messageId: payload.messageId, emailMessageId: message.id, threadId: thread.id,
    duplicate: false, intakeEligible: !native };
}

/** Call only after the outer transaction commits. The message ledger makes
 * duplicate delivery retry intake after a crash without duplicating tickets.
 * This route has never emitted an ingest activity row; extraction preserves that. */
export async function afterCommitEmailIngest(prisma: PrismaClient, results: readonly EmailIngestResult[]): Promise<void> {
  const seen = new Set<string>();
  for (const result of results) {
    if (!result.intakeEligible) continue;
    const key = `${result.accountId}\0${result.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { await intakeEmailMessage(prisma, result.accountId, result.messageId); }
    catch { logger.warn({ accountId: result.accountId }, "Service-desk email intake will need retry"); }
  }
}
