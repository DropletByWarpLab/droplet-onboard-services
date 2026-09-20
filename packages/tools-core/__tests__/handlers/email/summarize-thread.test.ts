/**
 * WARP-1453 — `email_summarize_thread` LLM tool.
 *
 * Role gate (owner/admin/family — the route's human set, zero HTTP
 * otherwise) + X-Droplet-User identity forwarding (AUTH_REQUIRED when
 * ctx.userId is absent).
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import emailSummarizeThread from "../../../src/handlers/email/summarize-thread.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(opts: {
  get?: Mock;
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
        get: opts.get ?? vi.fn(),
        post: vi.fn(),
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

const ANALYSIS = {
  summary: "Vendor asks for a signed PO.",
  callouts: [{ label: "Deadline: Friday" }],
  suggestedActions: [{ label: "Draft reply", safety: "Read" }],
  related: { files: [], threads: [], cameras: [], tools: [] },
};

function okGet(): Mock {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(ANALYSIS), { status: 200 }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof emailSummarizeThread.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

const ARGS = { accountId: "a1", threadId: "t1" };

describe("email_summarize_thread", () => {
  describe("role gate (WARP-1453)", () => {
    it.each([undefined, "guest"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await emailSummarizeThread.handler(
          ARGS,
          ctxWith({ get, role, userId: "romain" }),
        );
        expectError(res, "FORBIDDEN");
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin", "family"] as const)(
      "role %s passes",
      async (role) => {
        const res = await emailSummarizeThread.handler(
          ARGS,
          ctxWith({ get: okGet(), role, userId: "romain" }),
        );
        expect(res.ok).toBe(true);
      },
    );
  });

  it("missing ctx.userId → AUTH_REQUIRED with NO HTTP call", async () => {
    const get = vi.fn();
    const res = await emailSummarizeThread.handler(
      ARGS,
      ctxWith({ get, role: "owner" }),
    );
    expectError(res, "AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("forwards X-Droplet-User on the analysis call (WARP-1453)", async () => {
    const get = okGet();
    const res = await emailSummarizeThread.handler(
      ARGS,
      ctxWith({ get, role: "family", userId: "romain" }),
    );
    expect(get).toHaveBeenCalledWith("/api/email/a1/threads/t1/analysis", {
      headers: { Accept: "application/json", "X-Droplet-User": "romain" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ type: "email_analysis", ...ANALYSIS });
    }
  });

  it("missing args → INVALID_ARGS with NO HTTP call", async () => {
    const get = vi.fn();
    const res = await emailSummarizeThread.handler(
      { threadId: "t1" },
      ctxWith({ get, role: "owner", userId: "romain" }),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("maps 404 to NOT_FOUND", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 404 }));
    const res = await emailSummarizeThread.handler(
      ARGS,
      ctxWith({ get, role: "owner", userId: "romain" }),
    );
    expectError(res, "NOT_FOUND");
  });

  it("maps other non-OK statuses to EMAIL_SUMMARIZE_FAILED", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 503 }));
    const res = await emailSummarizeThread.handler(
      ARGS,
      ctxWith({ get, role: "owner", userId: "romain" }),
    );
    expectError(res, "EMAIL_SUMMARIZE_FAILED");
  });
});
