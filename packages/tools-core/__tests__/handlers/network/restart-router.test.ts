import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import restartRouter from "../../../src/handlers/network/restart-router.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("restart_router", () => {
  it("metadata flags are set for write+confirmation", () => {
    expect(restartRouter.requiresWrite).toBe(true);
    expect(restartRouter.requiresConfirmation).toBe(true);
  });

  it("returns confirmation_required when orchestrator returns 202 (Tier-2 pass-through)", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ reason: "Rebooting the router drops all connections — confirm in the dashboard." }),
        { status: 202 },
      ),
    );
    const r = await restartRouter.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("confirm");
    }
    expect(post).toHaveBeenCalledWith("/api/network/system/reboot", {});
  });

  it("returns ok with data when orchestrator returns 200 (confirmed execution)", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", action: "reboot", operationId: "op-123" }), { status: 200 }),
    );
    const r = await restartRouter.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ status: "ok", action: "reboot", operationId: "op-123" });
    }
  });

  it("returns REBOOT_BLOCKED with the downstream reason on 403", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Router reboot blocked by safety policy." }), { status: 403 }),
    );
    const r = await restartRouter.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REBOOT_BLOCKED");
      expect(r.error.message).toBe("Router reboot blocked by safety policy.");
    }
  });

  it("returns REBOOT_BLOCKED with fallback message when 403 body is unparseable", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 403 }),
    );
    const r = await restartRouter.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REBOOT_BLOCKED");
      expect(r.error.message).toBe("Reboot is blocked or requires owner-level access.");
    }
  });

  it("returns REBOOT_FAILED on other non-ok statuses", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "internal error" }), { status: 500 }),
    );
    const r = await restartRouter.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REBOOT_FAILED");
      expect(r.error.message).toContain("500");
    }
  });
});
