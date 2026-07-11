import { describe, it, expect, vi } from "vitest";
import setPortVlan from "../../../src/handlers/switch/set-port-vlan.js";
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

describe("set_port_vlan", () => {
  it("flags write+confirmation", () => {
    expect(setPortVlan.requiresWrite).toBe(true);
    expect(setPortVlan.requiresConfirmation).toBe(true);
  });

  it("rejects bad vlan_id", async () => {
    const r = await setPortVlan.handler({ vlan_id: 1, ports: [] }, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("posts to /vlans/<id>/membership", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await setPortVlan.handler(
      { vlan_id: 100, ports: [{ port: 1, tagged: false, member: true }] },
      ctxWithPost(post),
    );
    expect(post).toHaveBeenCalledWith(
      "/vlans/100/membership",
      { ports: [{ port: 1, tagged: false, member: true }] },
    );
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "ok" }), { status: 202 }));
    const r = await setPortVlan.handler({ vlan_id: 100, ports: [] }, ctxWithPost(post));
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });

  // WARP-1176 (PYNET-001): a plan-only write must surface as planned/dry-run,
  // never as an applied change the model relays as done.
  it("annotates a plan-only (dry-run) response as not applied", async () => {
    const body = { status: "planned", vlan_id: 100, ports_updated: 1, dry_run: true };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setPortVlan.handler(
      { vlan_id: 100, ports: [{ port: 1, tagged: false, member: true }] },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      expect(data.dry_run).toBe(true);
      expect(data.applied).toBe(false);
      expect(String(data.warning)).toContain("NOT applied to hardware");
    }
  });

  it("leaves an applied (live-write) response untouched", async () => {
    const body = { status: "ok", vlan_id: 100, ports_updated: 1, dry_run: false };
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await setPortVlan.handler(
      { vlan_id: 100, ports: [{ port: 1, tagged: false, member: true }] },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual(body);
      expect(r.data).not.toHaveProperty("warning");
    }
  });
});
