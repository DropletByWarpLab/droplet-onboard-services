import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setPortVlan from "../../../src/handlers/switch/set-port-vlan.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1462: dispatches through `ctx.http.orchestrator`
// (`POST /api/switch/vlans/:vlanId/membership`), never the bearer-less
// `ctx.http.switchSvc` the switch service 403s.
function ctxWithPost(post: Mock): ToolContext {
  return {
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      switchSvc: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

  it("posts to /api/switch/vlans/<id>/membership through the orchestrator (WARP-1462)", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const ctx = ctxWithPost(post);
    await setPortVlan.handler(
      { vlan_id: 100, ports: [{ port: 1, tagged: false, member: true }] },
      ctx,
    );
    expect(post).toHaveBeenCalledWith(
      "/api/switch/vlans/100/membership",
      { ports: [{ port: 1, tagged: false, member: true }] },
    );
    // WARP-1462: never call the switch service directly (the 403 seam).
    expect(ctx.http.switchSvc.post).not.toHaveBeenCalled();
  });

  // Audit 2026-08-06: the membership endpoint REPLACED the VLAN's member list,
  // so an agent moving one port wiped the rest (on the main LAN: the router,
  // the AP and the appliance). The endpoint now defaults to merge; this
  // handler must not assert an intent the model never expressed, and must be
  // able to carry a genuine full-replacement when the model does mean it.
  it("omits mode when the model did not ask for one (endpoint default applies)", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await setPortVlan.handler(
      { vlan_id: 100, ports: [{ port: 1, tagged: false, member: true }] },
      ctxWithPost(post),
    );
    expect(post.mock.calls[0][1]).not.toHaveProperty("mode");
  });

  it("forwards an explicit replace so a full-membership write stays possible", async () => {
    const post = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const ports = [
      { port: 1, tagged: false, member: true },
      { port: 9, tagged: true, member: true },
    ];
    await setPortVlan.handler({ vlan_id: 100, ports, mode: "replace" }, ctxWithPost(post));
    expect(post).toHaveBeenCalledWith("/api/switch/vlans/100/membership", {
      ports,
      mode: "replace",
    });
  });

  it("rejects an unknown mode instead of posting it", async () => {
    const post = vi.fn();
    const r = await setPortVlan.handler(
      { vlan_id: 100, ports: [], mode: "clobber" },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("advertises both modes on its input schema", () => {
    const props = (setPortVlan.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(props.mode?.enum).toEqual(["merge", "replace"]);
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
