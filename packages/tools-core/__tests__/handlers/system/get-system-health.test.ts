import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getSystemHealth from "../../../src/handlers/system/get-system-health.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("get_system_health", () => {
  it("returns the orchestrator's aggregate-health snapshot", async () => {
    const body = { status: "ok", services: { db: true, redis: true } };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await getSystemHealth.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
    expect(get).toHaveBeenCalledWith("/api/orchestrator/health", expect.anything());
  });

  it("surfaces HEALTH_FAILED on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    const r = await getSystemHealth.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEALTH_FAILED");
      expect(r.error.message).toContain("503");
    }
  });
});
