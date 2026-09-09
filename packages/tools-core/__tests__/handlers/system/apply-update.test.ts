/**
 * WARP-1450 — `apply_update` LLM tool.
 *
 * The highest-blast-radius tool in the catalog: dispatches the WARP-539
 * OTA apply via `POST /api/updates/apply-now`. Role-gated (owner/admin,
 * WARP-845 ladder) BEFORE any HTTP; two-phase handler-enforced
 * confirmation (remove_device idiom); and — critically — fire-once
 * semantics: a 202 is terminal success and a dropped connection after
 * the dispatch attempt is APPLY_DISPATCH_UNCONFIRMED, never a retry
 * (the apply may already be restarting services underneath us).
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import applyUpdate from "../../../src/handlers/system/apply-update.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(
  mocks: { get?: Mock; post?: Mock },
  role?: Role,
): { ctx: ToolContext; get: Mock; post: Mock } {
  const get = mocks.get ?? vi.fn();
  const post = mocks.post ?? vi.fn();
  const ctx: ToolContext = {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post, patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ...(role !== undefined ? { role } : {}),
    signal: new AbortController().signal,
  };
  return { ctx, get, post };
}

const PENDING_ROW = {
  id: "du-pending",
  status: "pending",
  channel: "stable",
  releaseTag: "v1.4.2",
  gitSha: "1111222233334444555566667777888899990000",
  builtAt: "2026-07-18T00:00:00.000Z",
  failureReason: null,
  createdAt: "2026-07-19T09:00:00.000Z",
  updatedAt: "2026-07-19T09:00:00.000Z",
};

/** GET /api/updates/status payload with a verified pending row. */
function statusGet(pending: unknown = PENDING_ROW): Mock {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        current: null,
        pending,
        lastVerdict: null,
        degraded: false,
        settings: { channel: "stable", applyWindowCron: "0 3 * * *", autoApply: false },
        applyAvailable: true,
      }),
      { status: 200 },
    ),
  );
}

function postResponse(status: number, body: unknown): Mock {
  return vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function expectError(
  res: Awaited<ReturnType<typeof applyUpdate.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("apply_update", () => {
  describe("role gate FIRST (WARP-845 / WARP-1450)", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with ZERO HTTP, even with confirmed:true",
      async (role) => {
        const { ctx, get, post } = ctxWith({}, role);
        const res = await applyUpdate.handler({ confirmed: true }, ctx);
        expectError(res, "FORBIDDEN");
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
      },
    );
  });

  describe("unconfirmed (first call) — no side effects", () => {
    it("echoes a confirmation naming the pending version, with the restart/quiet warning, and mints NO apply call", async () => {
      const { ctx, get, post } = ctxWith({ get: statusGet() }, "owner");
      const res = await applyUpdate.handler({}, ctx);

      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith("/api/updates/status", {
        headers: { Accept: "application/json" },
      });
      expect(post).not.toHaveBeenCalled();

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe("confirmation_required");
        expect(res.error.code).toBe("CONFIRMATION_REQUIRED");
        // The version being applied…
        expect(res.error.message).toContain("v1.4.2");
        // …the restart warning…
        expect(res.error.message).toMatch(/restart/i);
        // …the mid-apply quiet-period warning…
        expect(res.error.message).toMatch(/go quiet|quiet/i);
        // …and how to watch progress.
        expect(res.error.message).toContain("get_update_status");
        expect(res.error.details).toMatchObject({
          type: "apply_update",
          version: "v1.4.2",
          deviceUpdateId: "du-pending",
        });
      }
    });

    it("confirmed:false behaves like the first call (confirmation echo)", async () => {
      const { ctx, post } = ctxWith({ get: statusGet() }, "admin");
      const res = await applyUpdate.handler({ confirmed: false }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe("confirmation_required");
      expect(post).not.toHaveBeenCalled();
    });

    it("nothing pending → NOTHING_PENDING error, NO confirmation minted, NO apply call", async () => {
      const { ctx, post } = ctxWith({ get: statusGet(null) }, "owner");
      const res = await applyUpdate.handler({}, ctx);
      expectError(res, "NOTHING_PENDING");
      expect(post).not.toHaveBeenCalled();
    });

    it("in-flight applying row → APPLY_IN_PROGRESS instead of a doomed confirmation", async () => {
      const { ctx, post } = ctxWith(
        { get: statusGet({ ...PENDING_ROW, status: "applying" }) },
        "admin",
      );
      const res = await applyUpdate.handler({}, ctx);
      expectError(res, "APPLY_IN_PROGRESS");
      expect(post).not.toHaveBeenCalled();
    });

    it("status endpoint unavailable → STATUS_UNAVAILABLE (no confirmation)", async () => {
      const { ctx, post } = ctxWith(
        { get: vi.fn().mockResolvedValue(new Response("{}", { status: 502 })) },
        "owner",
      );
      const res = await applyUpdate.handler({}, ctx);
      expectError(res, "STATUS_UNAVAILABLE");
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("confirmed dispatch — fire once, never retry", () => {
    it("202 → SUCCESS immediately with deviceUpdateId; exactly ONE POST, zero retries, no status re-check", async () => {
      const post = postResponse(202, { started: true, deviceUpdateId: "du-pending" });
      const { ctx, get } = ctxWith({ post }, "owner");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);

      // Exactly one dispatch — never wait, poll, or re-request after 202.
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/api/updates/apply-now", undefined, {
        headers: { Accept: "application/json" },
      });
      expect(get).not.toHaveBeenCalled();

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({
          type: "apply_update",
          started: true,
          deviceUpdateId: "du-pending",
          note: "apply dispatched — services will restart; check get_update_status for progress",
        });
      }
    });

    it("thrown fetch after the dispatch attempt → APPLY_DISPATCH_UNCONFIRMED, single call, NO retry", async () => {
      const post = vi.fn().mockRejectedValue(new Error("socket hang up"));
      const { ctx } = ctxWith({ post }, "admin");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);

      expectError(res, "APPLY_DISPATCH_UNCONFIRMED");
      expect(post).toHaveBeenCalledTimes(1); // a drop is NOT a retry ticket
      if (!res.ok) {
        expect(res.error.message).toMatch(/may have started/i);
        expect(res.error.message).toContain("get_update_status");
      }
    });

    it("503 apply_unavailable → APPLY_UNAVAILABLE surfacing the server message", async () => {
      const post = postResponse(503, { error: "apply_unavailable" });
      const { ctx } = ctxWith({ post }, "owner");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "APPLY_UNAVAILABLE");
      if (!res.ok) {
        expect(res.error.message).toContain("apply_unavailable");
      }
    });

    it("409 apply_in_progress → APPLY_IN_PROGRESS", async () => {
      const post = postResponse(409, { error: "apply_in_progress" });
      const { ctx } = ctxWith({ post }, "admin");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "APPLY_IN_PROGRESS");
    });

    it("409 nothing_pending → NOTHING_PENDING", async () => {
      const post = postResponse(409, { error: "nothing_pending" });
      const { ctx } = ctxWith({ post }, "owner");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "NOTHING_PENDING");
    });

    it("setup-gate deferral → APPLY_DEFERRED with the server's reason", async () => {
      const post = postResponse(409, {
        error: "deferred_setup_in_progress",
        reason: "appliance setup is in progress",
      });
      const { ctx } = ctxWith({ post }, "owner");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "APPLY_DEFERRED");
      if (!res.ok) {
        expect(res.error.message).toContain("appliance setup is in progress");
      }
    });

    it("deferral matched by outcome shape too (applyPendingUpdate vocabulary)", async () => {
      const post = postResponse(409, { outcome: "deferred_setup_in_progress" });
      const { ctx } = ctxWith({ post }, "admin");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "APPLY_DEFERRED");
    });

    it("other non-OK → APPLY_FAILED", async () => {
      const post = postResponse(500, { error: "boom" });
      const { ctx } = ctxWith({ post }, "owner");
      const res = await applyUpdate.handler({ confirmed: true }, ctx);
      expectError(res, "APPLY_FAILED");
    });
  });
});

describe("apply_update — tool metadata", () => {
  it("is named apply_update and is write + confirmation gated", () => {
    expect(applyUpdate.name).toBe("apply_update");
    expect(applyUpdate.requiresWrite).toBe(true);
    expect(applyUpdate.requiresConfirmation).toBe(true);
  });

  it("takes only the optional confirmed flag", () => {
    const schema = applyUpdate.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(["confirmed"]);
    expect(schema.properties?.confirmed).toMatchObject({ type: "boolean" });
  });

  it("warns about restarts, the quiet period, progress, and auto-rollback in its description", () => {
    expect(applyUpdate.description).toMatch(/restart/i);
    expect(applyUpdate.description).toMatch(/quiet/i);
    expect(applyUpdate.description).toContain("get_update_status");
    expect(applyUpdate.description).toMatch(/rolls? back|rollback/i);
    expect(applyUpdate.description).toMatch(/signature/i);
  });
});
