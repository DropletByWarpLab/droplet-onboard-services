import { describe, it, expect, vi } from "vitest";
import addPortForward from "../../../src/handlers/network/add-port-forward.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      routing: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
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

describe("add_port_forward", () => {
  it("flags write+confirmation", () => {
    expect(addPortForward.requiresWrite).toBe(true);
    expect(addPortForward.requiresConfirmation).toBe(true);
  });

  it("rejects missing fields", async () => {
    const r = await addPortForward.handler({ name: "x" }, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("posts the full body and defaults proto to tcp", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await addPortForward.handler(
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22" },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/firewall/port-forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "ok" }), { status: 202 }));
    const r = await addPortForward.handler(
      { name: "n", src_port: "1", dest_ip: "x", dest_port: "1", proto: "udp" },
      ctxWithPost(post),
    );
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });
});
