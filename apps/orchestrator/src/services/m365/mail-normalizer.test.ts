import { describe, expect, it } from "vitest";
import { microsoftMailNeedsHydration, parseMicrosoftMailMessage, MicrosoftMailUnavailableError } from "./mail-normalizer.js";
import { prepareEmailIngest } from "../email/mail-ingest.service.js";

export function graphMessage(id = "Immutable-A", extra: Record<string, unknown> = {}) {
  return { id, internetMessageId: "<real-message@example.test>", conversationId: "thread-case-sensitive", parentFolderId: "inbox",
    subject: "Project update", body: { contentType: "text", content: "The complete message\nwith all its paragraphs." },
    from: { emailAddress: { address: "alice@example.test", name: "Alice" } },
    sender: { emailAddress: { address: "delegate@example.test", name: "Delegate" } },
    toRecipients: [{ emailAddress: { address: "owner@example.test", name: "Owner" } }], ccRecipients: [],
    receivedDateTime: "2026-10-05T10:00:00Z", createdDateTime: "2026-10-05T09:00:00Z", isDraft: false, hasAttachments: false,
    internetMessageHeaders: [{ name: "References", value: "<root@example.test> <parent@example.test>" },
      { name: "In-Reply-To", value: "<parent@example.test>" }, { name: "Auto-Submitted", value: "auto-replied" }], ...extra };
}

describe("Microsoft full message normalization", () => {
  it("keeps full text, RFC identity/headers, provider threading and represented author", () => {
    const result = parseMicrosoftMailMessage(graphMessage(), "owner@example.test");
    expect(result).toMatchObject({ kind: "message", providerMessageId: "Immutable-A", metadata: {
      providerMessageId: "Immutable-A", internetMessageId: "<real-message@example.test>", hasAttachments: false },
      payload: { messageId: "m365:Immutable-A", inReplyTo: "parent@example.test", fromAddr: "alice@example.test",
        bodyText: "The complete message\nwith all its paragraphs.", bodyHtml: null,
        headers: { references: ["root@example.test", "parent@example.test"], autoSubmitted: "auto-replied" } } });
    if (result.kind !== "message") throw new Error("expected message");
    expect(result.payload.threadKey).toMatch(/^m365-thread:[a-f0-9]{64}$/);
    expect(prepareEmailIngest("account", result.payload, { ...result.metadata, externalAttachmentMetadata: undefined }).payload).toEqual(result.payload);
  });
  it("keeps immutable ids case sensitive and does not merge equal RFC ids", () => {
    const upper = parseMicrosoftMailMessage(graphMessage("ABC"), "owner@example.test");
    const lower = parseMicrosoftMailMessage(graphMessage("abc"), "owner@example.test");
    expect(upper).not.toEqual(lower);
    if (upper.kind === "message" && lower.kind === "message") {
      expect(upper.payload.messageId).not.toBe(lower.payload.messageId);
      expect(upper.payload.threadKey).toBe(lower.payload.threadKey);
    }
  });
  it("requests hydration for read-state-only updates and absent full headers", () => {
    expect(microsoftMailNeedsHydration({ id: "ABC", isRead: true })).toBe(true);
    const item = graphMessage(); delete (item as Record<string, unknown>).internetMessageHeaders;
    expect(microsoftMailNeedsHydration(item)).toBe(true);
    expect(microsoftMailNeedsHydration(graphMessage())).toBe(false);
    expect(microsoftMailNeedsHydration({ id: "ABC", "@removed": { reason: "deleted" } })).toBe(false);
  });
  it("supports BCC-only mail without inventing recipients", () => {
    const parsed = parseMicrosoftMailMessage(graphMessage("bcc", { toRecipients: [] }), "owner@example.test");
    if (parsed.kind !== "message") throw new Error("expected message");
    expect(parsed.payload.toAddrs).toEqual([]);
    expect(prepareEmailIngest("account", parsed.payload, { ...parsed.metadata, externalAttachmentMetadata: undefined }).payload.toAddrs).toEqual([]);
  });
  it("excludes unsent drafts so their later sent body can be archived accurately", () => {
    expect(parseMicrosoftMailMessage(graphMessage("draft", { from: null, sender: null, isDraft: true,
      receivedDateTime: null, toRecipients: [] }), "owner@example.test"))
      .toEqual({ kind: "excluded", providerMessageId: "draft", reason: "draft" });
  });
  it("retains truthful remote attachment metadata without hashes or downloadable bytes", () => {
    const parsed = parseMicrosoftMailMessage(graphMessage("attachment", { hasAttachments: true, attachments: [{
      id: "attachment-id", name: "report.pdf", size: 123, contentType: "application/pdf", isInline: false,
      contentBytes: "NEVER_STORE_THIS" }] }), "owner@example.test");
    expect(parsed).toMatchObject({ metadata: { externalAttachmentMetadata: [{ filename: "report.pdf", size: 123, status: "remote_only" }] } });
    expect(JSON.stringify(parsed)).not.toContain("NEVER_STORE_THIS");
    if (parsed.kind === "message") expect(parsed.payload.attachments).toBeUndefined();
  });
  it.each([
    { body: { contentType: "html", content: "<script>private body</script>" } },
    { body: { contentType: "text" } }, { from: null, sender: null }, { receivedDateTime: "not a date" },
    { toRecipients: [{}] }, { internetMessageHeaders: null }, { isDraft: "false" },
  ])("fails incomplete or malformed content with a fixed error", (extra) => {
    expect(() => parseMicrosoftMailMessage(graphMessage("secret-provider-id", extra), "owner@example.test"))
      .toThrow(MicrosoftMailUnavailableError);
    try { parseMicrosoftMailMessage(graphMessage("secret-provider-id", extra), "owner@example.test"); }
    catch (error) { expect(String(error)).not.toContain("secret-provider-id"); expect(String(error)).not.toContain("private body"); }
  });
  it("represents folder removal separately from message archive deletion", () => {
    expect(parseMicrosoftMailMessage({ id: "moved", "@removed": { reason: "deleted" } }, "owner@example.test"))
      .toEqual({ kind: "removed", providerMessageId: "moved" });
    expect(() => parseMicrosoftMailMessage({ id: "x", "@removed": null }, "owner@example.test")).toThrow(MicrosoftMailUnavailableError);
  });
});
