/**
 * WARP-1453 — `email_send` LLM tool.
 *
 * The narrowest gate of the five email tools: owner/admin ONLY (the
 * send route's human set — family may draft but never send; service
 * and guest refused too), zero HTTP otherwise. X-Droplet-User identity
 * forwarding (AUTH_REQUIRED when ctx.userId is absent). Write tier +
 * confirmation — mail leaves the LAN.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import emailSend from "../../../src/handlers/email/send.js";
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
    new Response(
      JSON.stringify({
        id: "d1",
        status: "queued",
        message: "Queued for SMTP send by the email-indexer service",
      }),
      { status: 202 },
    ),
  );
}

function postWithStatus(status: number): Mock {
  return vi.fn().mockResolvedValue(new Response("{}", { status }));
}

function expectError(
  res: Awaited<ReturnType<typeof emailSend.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("email_send", () => {
  describe("role gate (WARP-1453) — owner/admin only", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const post = vi.fn();
        const res = await emailSend.handler(
          { draftId: "d1" },
          ctxWith({ post, role, userId: "romain" }),
        );
        expectError(res, "FORBIDDEN");
        if (!res.ok) {
          expect(res.error.message).toBe(
            "sending email requires the owner or admin role",
          );
        }
        expect(post).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin"] as const)("role %s passes", async (role) => {
      const res = await emailSend.handler(
        { draftId: "d1" },
        ctxWith({ post: okPost(), role, userId: "romain" }),
      );
      expect(res.ok).toBe(true);
    });
  });

  it("missing ctx.userId → AUTH_REQUIRED with NO HTTP call", async () => {
    const post = vi.fn();
    const res = await emailSend.handler(
      { draftId: "d1" },
      ctxWith({ post, role: "owner" }),
    );
    expectError(res, "AUTH_REQUIRED");
    expect(post).not.toHaveBeenCalled();
  });

  it("forwards X-Droplet-User on the send call (WARP-1453)", async () => {
    const post = okPost();
    const res = await emailSend.handler(
      { draftId: "d1" },
      ctxWith({ post, role: "admin", userId: "romain" }),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/email/drafts/d1/send",
      {},
      {
        headers: { Accept: "application/json", "X-Droplet-User": "romain" },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "email_send",
        draftId: "d1",
        status: "queued",
        summary: "Queued for SMTP send by the email-indexer service",
      });
    }
  });

  it("missing draftId → INVALID_ARGS with NO HTTP call", async () => {
    const post = vi.fn();
    const res = await emailSend.handler(
      {},
      ctxWith({ post, role: "owner", userId: "romain" }),
    );
    expectError(res, "INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [451, "OFF_LAN_BLOCKED"],
    [404, "NOT_FOUND"],
    [409, "ALREADY_DISPATCHED"],
    [500, "EMAIL_SEND_FAILED"],
  ] as const)("maps %s to %s", async (status, code) => {
    const res = await emailSend.handler(
      { draftId: "d1" },
      ctxWith({ post: postWithStatus(status), role: "owner", userId: "romain" }),
    );
    expectError(res, code);
  });
});
