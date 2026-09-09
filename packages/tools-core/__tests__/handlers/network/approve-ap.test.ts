import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import approveAp from "../../../src/handlers/network/approve-ap.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(post: Mock): ToolContext {
  return {
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("approve_ap (WARP-446)", () => {
  it("metadata declares write + confirmation (admin-tier; changes wireless surface)", () => {
    expect(approveAp.name).toBe("approve_ap");
    expect(approveAp.requiresWrite).toBe(true);
    expect(approveAp.requiresConfirmation).toBe(true);
  });

  it("returns INVALID_ARGS when mac is missing", async () => {
    const post = vi.fn();
    const r = await approveAp.handler({ ssid: "X", encryptionKey: "longpwword" }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns INVALID_ARGS when ssid or encryptionKey is missing", async () => {
    const post = vi.fn();
    const r1 = await approveAp.handler({ mac: "B8:27:EB:00:00:01", encryptionKey: "x" }, ctxWith(post));
    expect(r1.ok).toBe(false);
    const r2 = await approveAp.handler({ mac: "B8:27:EB:00:00:01", ssid: "X" }, ctxWith(post));
    expect(r2.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts to /api/aps/:mac/approve and forwards the body", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ap: { mac: "B8:27:EB:00:00:01", status: "ONLINE" } }), {
        status: 200,
      }),
    );
    const r = await approveAp.handler(
      { mac: "B8:27:EB:00:00:01", ssid: "Droplet", encryptionKey: "longenoughpw" },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/aps/B8%3A27%3AEB%3A00%3A00%3A01/approve",
      { ssid: "Droplet", encryptionKey: "longenoughpw" },
    );
    expect(r.ok).toBe(true);
  });

  it("surfaces orchestrator failures as a typed error", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "AP not found" }), { status: 404 }),
    );
    const r = await approveAp.handler(
      { mac: "B8:27:EB:00:00:99", ssid: "Droplet", encryptionKey: "longenoughpw" },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("APPROVE_FAILED");
  });
});
