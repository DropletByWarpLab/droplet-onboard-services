/**
 * WARP-1453 — `email_draft_reply` LLM tool.
 *
 * Role gate (owner/admin/family — the route's human set, zero HTTP
 * otherwise) + X-Droplet-User identity forwarding (AUTH_REQUIRED when
 * ctx.userId is absent). Write tier (persists an EmailDraft row) but
 * no confirmation — send is the destructive surface.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import emailDraftReply from "../../../src/handlers/email/draft-reply.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(opts: {
  post?: Mock;
  role?: Role;
  userId?: string;
}): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: vi.fn(),
        post: opts.post ?? vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    signal: new AbortController().signal,
  };
}

function okPost(): Mock {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "d1", status: "draft" }), {
      status: 201,
    }),
  );
}

function expectError(
  res: Awaited<ReturnType<typeof emailDraftReply.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

const ARGS = {
  accountId: "a1",
  threadId: "t1",
  toAddrs: ["c@d.com"],
  subject: "Re: Hello",
  body: "Sounds good.",
};

describe("email_draft_reply", () => {
  describe("role gate (WARP-1453)", () => {
    it.each([undefined, "guest"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const post = vi.fn();
        const res = await emailDraftReply.handler(
          ARGS,
          ctxWith({ post, role, userId: "romain" }),
        );
        expectError(res, "FORBIDDEN");
        expect(post).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin", "family"] as const)(
      "role %s passes",
      async (role) => {
        const res = await emailDraftReply.handler(
          ARGS,
          ctxWith({ post: okPost(), role, userId: "romain" }),
        );
        expect(res.ok).toBe(true);
      },
    );
  });

  it("missing ctx.userId → AUTH_REQUIRED with NO HTTP call", async () => {
    const post = vi.fn();
    const res = await emailDraftReply.handler(
      ARGS,
      ctxWith({ post, role: "owner" }),
    );
    expectError(res, "AUTH_REQUIRED");
    expect(post).not.toHaveBeenCalled();
  });

  it("forwards X-Droplet-User on the draft-create call (WARP-1453)", async () => {
    const post = okPost();
    const res = await emailDraftReply.handler(
      ARGS,
      ctxWith({ post, role: "family", userId: "romain" }),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/email/a1/drafts",
      {
        threadId: "t1",
        toAddrs: ["c@d.com"],
        ccAddrs: undefined,
        subject: "Re: Hello",
        body: "Sounds good.",
        draftedByDroplet: true,
      },
      {
        headers: { Accept: "application/json", "X-Droplet-User": "romain" },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "email_draft",
        draftId: "d1",
        status: "draft",
        summary: "Reply drafted. The operator can review and send it.",
      });
    }
  });

  it("missing accountId → INVALID_ARGS with NO HTTP call", async () => {
    const post = vi.fn();
    const res = await emailDraftReply.handler(
      { toAddrs: ["c@d.com"], subject: "s", body: "b" },
      ctxWith({ post, role: "owner", userId: "romain" }),
    );
    expectError(res, "INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("maps a non-OK response to EMAIL_DRAFT_FAILED with the route's error detail", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
      }),
    );
    const res = await emailDraftReply.handler(
      ARGS,
      ctxWith({ post, role: "owner", userId: "romain" }),
    );
    expectError(res, "EMAIL_DRAFT_FAILED");
    if (!res.ok) {
      expect(res.error.message).toBe("Account not found");
    }
  });
});
