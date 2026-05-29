/**
 * WARP-465 — contract assertions for the five email tool handlers.
 *
 * Behavioral tests for the search/read/summarize/draft/send tools want
 * either a real Prisma surface or a much larger MCP mock than is
 * worth standing up for a unit suite. This file enforces the
 * sharable invariants:
 *
 *   • each tool is registered with the expected name
 *   • requiresWrite + requiresConfirmation match the documented
 *     Tier (read-only, draft-write, send-write+confirm)
 *   • inputSchema declares the required arg keys callers depend on
 *
 * If a future refactor relaxes a write/confirm flag without touching
 * the docstring, this file fails fast — the same canary that caught
 * the WARP-466 `email_draft_reply: requiresWrite: false` regression.
 */
import { describe, it, expect } from "vitest";
import emailSearch from "../../../src/handlers/email/search.js";
import emailRead from "../../../src/handlers/email/read.js";
import emailSummarizeThread from "../../../src/handlers/email/summarize-thread.js";
import emailDraftReply from "../../../src/handlers/email/draft-reply.js";
import emailSend from "../../../src/handlers/email/send.js";

interface SchemaShape {
  type: string;
  required?: readonly string[];
  properties?: Record<string, unknown>;
}

describe("email tool contracts", () => {
  it("email_search: read-only", () => {
    expect(emailSearch.name).toBe("email_search");
    expect(emailSearch.requiresWrite).toBe(false);
    expect(emailSearch.requiresConfirmation).toBe(false);
    const schema = emailSearch.inputSchema as SchemaShape;
    expect(schema.required).toEqual(expect.arrayContaining(["accountId"]));
  });

  it("email_read: read-only", () => {
    expect(emailRead.name).toBe("email_read");
    expect(emailRead.requiresWrite).toBe(false);
    expect(emailRead.requiresConfirmation).toBe(false);
    const schema = emailRead.inputSchema as SchemaShape;
    expect(schema.required).toEqual(
      expect.arrayContaining(["accountId", "threadId"]),
    );
  });

  it("email_summarize_thread: read-only", () => {
    expect(emailSummarizeThread.name).toBe("email_summarize_thread");
    expect(emailSummarizeThread.requiresWrite).toBe(false);
    expect(emailSummarizeThread.requiresConfirmation).toBe(false);
    const schema = emailSummarizeThread.inputSchema as SchemaShape;
    expect(schema.required).toEqual(
      expect.arrayContaining(["accountId", "threadId"]),
    );
  });

  it("email_draft_reply: write tier, no confirm (draft is reversible)", () => {
    expect(emailDraftReply.name).toBe("email_draft_reply");
    // WARP-466 review caught requiresWrite=false on this handler when
    // it persists EmailDraft rows. Pin requiresWrite=true so a future
    // refactor that drops it fails this test instead of silently
    // bypassing the orchestrator's WRITE_TOOLS RBAC gate.
    expect(emailDraftReply.requiresWrite).toBe(true);
    expect(emailDraftReply.requiresConfirmation).toBe(false);
    const schema = emailDraftReply.inputSchema as SchemaShape;
    expect(schema.required).toEqual(
      expect.arrayContaining(["accountId", "toAddrs", "subject", "body"]),
    );
  });

  it("email_send: write tier + confirmation required", () => {
    expect(emailSend.name).toBe("email_send");
    expect(emailSend.requiresWrite).toBe(true);
    // Send is the destructive surface — mail leaves the LAN.
    expect(emailSend.requiresConfirmation).toBe(true);
    const schema = emailSend.inputSchema as SchemaShape;
    expect(schema.required).toEqual(expect.arrayContaining(["draftId"]));
  });
});
