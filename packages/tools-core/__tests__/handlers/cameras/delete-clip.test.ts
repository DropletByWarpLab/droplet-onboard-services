import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import deleteClip from "../../../src/handlers/cameras/delete-clip.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * delete_clip permanently removes a camera event's recording clip.
 * The invariant pinned here is the handler-enforced two-step (same
 * contract as memory_forget): without `confirmed: true` the handler
 * must answer confirmation_required WITHOUT any HTTP call — the agent
 * can never delete footage in a single unattended tool call.
 */
function ctxWith(orchestratorDelete: Mock): ToolContext {
  return {
    http: {
      orchestrator: {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: orchestratorDelete,
      },
      cameras: {} as ToolContext["http"]["cameras"],
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

describe("delete_clip", () => {
  it("first (unconfirmed) call → confirmation_required echoing the event id, NO HTTP call", async () => {
    const del = vi.fn();
    const r = await deleteClip.handler({ event_id: "ev-1" }, ctxWith(del));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.message).toContain("ev-1");
      expect(r.error.message).toContain("permanently");
      expect(r.error.details).toMatchObject({ type: "delete_clip", event_id: "ev-1" });
    }
    expect(del).not.toHaveBeenCalled();
  });

  it("confirmed: false is the same as unconfirmed — no HTTP call", async () => {
    const del = vi.fn();
    const r = await deleteClip.handler(
      { event_id: "ev-1", confirmed: false },
      ctxWith(del),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(del).not.toHaveBeenCalled();
  });

  it("confirmed happy path: DELETEs the orchestrator event route and reports deleted", async () => {
    const del = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const r = await deleteClip.handler(
      { event_id: "ev-1", confirmed: true },
      ctxWith(del),
    );

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("/api/cameras/events/ev-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ type: "delete_clip", event_id: "ev-1", deleted: true });
    }
  });

  it("maps orchestrator 404 to NOT_FOUND", async () => {
    const del = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Event not found" }), { status: 404 }),
    );
    const r = await deleteClip.handler(
      { event_id: "missing", confirmed: true },
      ctxWith(del),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it.each([403, 451])("maps orchestrator %i to FORBIDDEN", async (status) => {
    const del = vi.fn().mockResolvedValue(new Response("nope", { status }));
    const r = await deleteClip.handler(
      { event_id: "ev-1", confirmed: true },
      ctxWith(del),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("maps any other orchestrator failure to DELETE_FAILED", async () => {
    const del = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const r = await deleteClip.handler(
      { event_id: "ev-1", confirmed: true },
      ctxWith(del),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("DELETE_FAILED");
      expect(r.error.message).toContain("502");
    }
  });

  it("rejects a missing/empty event_id with INVALID_ARGS, no HTTP call", async () => {
    const del = vi.fn();
    for (const args of [{}, { event_id: "" }, { event_id: "   " }, { event_id: 42 }]) {
      const r = await deleteClip.handler(args as Record<string, unknown>, ctxWith(del));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(del).not.toHaveBeenCalled();
  });

  describe("metadata", () => {
    it("is named delete_clip and flagged write + confirmation", () => {
      expect(deleteClip.name).toBe("delete_clip");
      expect(deleteClip.requiresWrite).toBe(true);
      expect(deleteClip.requiresConfirmation).toBe(true);
    });

    it("schema requires event_id and rejects unknown properties", () => {
      const schema = deleteClip.inputSchema as {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.required).toEqual(["event_id"]);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(["confirmed", "event_id"]);
    });
  });
});
