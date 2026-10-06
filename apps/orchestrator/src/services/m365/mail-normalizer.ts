/** Delegated Graph mail becomes canonical local, read-only message content. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EmailIngestPayload } from "../email/mail-ingest.service.js";

export const MICROSOFT_MAIL_FIELDS = ["id", "internetMessageId", "internetMessageHeaders", "conversationId",
  "parentFolderId", "subject", "body", "from", "sender", "toRecipients", "ccRecipients",
  "receivedDateTime", "createdDateTime", "isDraft", "hasAttachments"] as const;
const ADDRESS = z.string().email().max(254);

export class MicrosoftMailUnavailableError extends Error {
  constructor() { super("Outlook mail could not be read. Droplet will retry."); this.name = "MicrosoftMailUnavailableError"; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function fail(): never { throw new MicrosoftMailUnavailableError(); }
function bounded(value: unknown, limit: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > limit || (nonempty && !value)) fail();
  return value;
}
export function microsoftMailId(value: unknown): string { return bounded(object(value)?.id, 4096, true); }

/** Headers/body can be omitted on a legitimate delta update: hydrate before storing. */
export function microsoftMailNeedsHydration(value: unknown): boolean {
  const item = object(value);
  if (!item) fail();
  microsoftMailId(item);
  if (item["@removed"] !== undefined) return false;
  return ["parentFolderId", "subject", "body", "toRecipients", "ccRecipients", "isDraft", "hasAttachments", "internetMessageHeaders"]
    .some((field) => !(field in item)) || (!("receivedDateTime" in item) && !(item.isDraft === true && "createdDateTime" in item));
}

function recipient(value: unknown): { address: string; name: string | null } {
  const email = object(object(value)?.emailAddress);
  const parsed = ADDRESS.safeParse(email?.address);
  if (!parsed.success) fail();
  return { address: parsed.data, name: email?.name == null ? null : bounded(email.name, 254) };
}
function recipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) fail();
  return value.map((entry) => recipient(entry).address);
}
function instant(value: unknown): string {
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  if (!parsed.success) fail();
  const date = new Date(parsed.data);
  if (!Number.isFinite(date.getTime())) fail();
  return date.toISOString();
}
function messageId(value: string | null): string | null {
  if (value === null) return null;
  const result = value.trim().replace(/^<|>$/g, "");
  return result && result.length <= 998 ? result : null;
}
function headers(value: unknown): { values: Map<string, string[]>; checked: NonNullable<EmailIngestPayload["headers"]> } {
  if (!Array.isArray(value) || value.length > 2000) fail();
  const values = new Map<string, string[]>();
  let size = 0;
  for (const entry of value) {
    const header = object(entry);
    const name = bounded(header?.name, 256, true).toLowerCase();
    const text = bounded(header?.value, 1_000_000);
    size += name.length + text.length;
    if (size > 2_000_000) fail();
    values.set(name, [...(values.get(name) ?? []), text]);
  }
  const first = (key: string) => values.get(key)?.[0] ?? null;
  const keyword = (key: string) => first(key)?.trim().toLowerCase().split(/[;\s]/, 1)[0]?.slice(0, 64) ?? null;
  let references = (values.get("references") ?? []).join(" ").split(/\s+/).map(messageId).filter((id): id is string => id !== null);
  if (references.length > 100) references = [references[0]!, ...references.slice(-99)];
  const returnPath = first("return-path");
  const contentType = first("content-type");
  return { values, checked: { references, autoSubmitted: keyword("auto-submitted"), precedence: keyword("precedence"),
    xAutoreply: keyword("x-autoreply"), xAutorespond: keyword("x-autorespond"),
    returnPath: returnPath === null ? null : returnPath.trim().replace(/^<|>$/g, "").slice(0, 320),
    reportType: contentType?.toLowerCase().startsWith("multipart/report")
      ? /report-type\s*=\s*"?([^;"\s]*)/i.exec(contentType)?.[1]?.toLowerCase().slice(0, 64) ?? "" : null } };
}

export interface MicrosoftMailNativeMetadata {
  providerMessageId: string;
  internetMessageId: string | null;
  hasAttachments: boolean;
  /** Metadata only: these entries never stand for locally stored attachment bytes. */
  externalAttachmentMetadata: { id: string; filename: string; contentType: string; size: number; isInline: boolean; status: "remote_only" }[] | null;
}
export type MicrosoftMailEntry = { kind: "removed"; providerMessageId: string } | { kind: "excluded"; providerMessageId: string; reason: "draft" } |
  { kind: "message"; providerMessageId: string; parentFolderId: string; payload: EmailIngestPayload; metadata: MicrosoftMailNativeMetadata };

function attachmentMetadata(value: unknown): MicrosoftMailNativeMetadata["externalAttachmentMetadata"] {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 50) fail();
  return value.map((entry) => {
    const part = object(entry);
    if (typeof part?.size !== "number" || !Number.isSafeInteger(part.size) || part.size < 0 || typeof part.isInline !== "boolean") fail();
    return { id: bounded(part.id, 4096, true), filename: bounded(part.name, 255, true),
      contentType: bounded(part.contentType, 255, true), size: part.size, isInline: part.isInline, status: "remote_only" as const };
  });
}

/** Requires the full selected representation, not bodyPreview or a partial delta. */
export function parseMicrosoftMailMessage(value: unknown, mailboxAddress: string): MicrosoftMailEntry {
  const item = object(value);
  const id = microsoftMailId(item);
  if (!item) fail();
  if (item["@removed"] !== undefined) {
    const removed = object(item["@removed"]);
    if (!removed || (removed.reason !== "deleted" && removed.reason !== "changed")) fail();
    return { kind: "removed", providerMessageId: id };
  }
  if (microsoftMailNeedsHydration(item)) fail();
  if (typeof item.isDraft !== "boolean" || typeof item.hasAttachments !== "boolean") fail();
  // The existing local email archive is immutable after creation. Import a
  // draft only once it is sent, when its complete historical content is fixed.
  if (item.isDraft) return { kind: "excluded", providerMessageId: id, reason: "draft" };
  const sender = item.from != null ? recipient(item.from) : item.sender != null ? recipient(item.sender)
    : fail();
  const body = object(item.body);
  // Every mail GET asks Graph for its complete plain-text body. HTML or a
  // preview is never substituted silently, and no remote markup is rendered.
  if (typeof body?.contentType !== "string" || body.contentType.toLowerCase() !== "text") fail();
  const checkedHeaders = headers(item.internetMessageHeaders);
  const rfcId = item.internetMessageId == null ? null : bounded(item.internetMessageId, 998);
  const dedup = id.length <= 993 ? `m365:${id}` : `m365:sha256:${createHash("sha256").update(id).digest("hex")}`;
  const conversation = item.conversationId == null ? null : bounded(item.conversationId, 4096, true);
  const inReplyTo = messageId(checkedHeaders.values.get("in-reply-to")?.[0] ?? null);
  const threadKey = conversation ? `m365-thread:${createHash("sha256").update(conversation).digest("hex")}`
    : checkedHeaders.checked.references[0] ?? inReplyTo ?? dedup;
  return { kind: "message", providerMessageId: id, parentFolderId: bounded(item.parentFolderId, 4096, true),
    payload: { messageId: dedup, inReplyTo, fromAddr: sender.address, fromName: sender.name,
      toAddrs: recipients(item.toRecipients), ccAddrs: recipients(item.ccRecipients), subject: bounded(item.subject, 998),
      bodyText: bounded(body.content, 1_000_000), bodyHtml: null,
      receivedAt: instant(item.receivedDateTime ?? (item.isDraft ? item.createdDateTime : null)), threadKey,
      headers: checkedHeaders.checked },
    metadata: { providerMessageId: id, internetMessageId: rfcId, hasAttachments: item.hasAttachments,
      externalAttachmentMetadata: attachmentMetadata(item.attachments) } };
}
