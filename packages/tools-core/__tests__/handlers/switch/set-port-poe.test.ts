import { describe, it, expect, vi } from "vitest";
import setPortPoe from "../../../src/handlers/switch/set-port-poe.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      switchSvc: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("set_port_poe", () => {
  it("flags write+confirmation", () => {
    expect(setPortPoe.requiresWrite).toBe(true);
    expect(setPortPoe.requiresConfirmation).toBe(true);
  });

  it("rejects port out of range", async () => {
    const r = await setPortPoe.handler({ port: 9, enabled: true }, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("posts /poe/<n>/enable when enabled=true", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await setPortPoe.handler({ port: 3, enabled: true }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/poe/3/enable", undefined);
  });

  it("posts /poe/<n>/disable when enabled=false", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await setPortPoe.handler({ port: 4, enabled: false }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/poe/4/disable", undefined);
  });

  it("returns confirmation_required when switch service returns 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "PoE toggle requires confirmation" }), {
        status: 202,
      }),
    );
    const r = await setPortPoe.handler({ port: 5, enabled: false }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("confirmation");
    }
  });

  // WARP-1176 (PYNET-001): a plan-only write must surface as planned/dry-run,
  // never as an applied change the model relays as done.
  it("annotates a plan-only (dry-run) response as not applied", async () => {
    const body = { status: "planned", port: 3, poe_enabled: true, dry_run: true };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setPortPoe.handler({ port: 3, enabled: true }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      expect(data.dry_run).toBe(true);
      expect(data.applied).toBe(false);
      expect(String(data.warning)).toContain("NOT applied to hardware");
    }
  });

  it("leaves an applied (live-write) response untouched", async () => {
    const body = { status: "ok", port: 3, poe_enabled: true, dry_run: false };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setPortPoe.handler({ port: 3, enabled: true }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual(body);
      expect(r.data).not.toHaveProperty("warning");
    }
  });
});
