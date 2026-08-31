import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import addPortForward from "../../../src/handlers/network/add-port-forward.js";
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
      "/api/network/firewall/port-forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );
  });

  it("returns confirmation_required on 202", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: "ok" }), { status: 202 }));
    const r = await addPortForward.handler(
      { name: "n", src_port: "1", dest_ip: "192.168.1.10", dest_port: "1", proto: "udp" },
      ctxWithPost(post),
    );
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });

  // ── TOOLS-10 — boundary input validation (fail fast before the HTTP call) ──

  it("rejects a non-numeric / out-of-range src_port without calling routing", async () => {
    const post = vi.fn();
    for (const src_port of ["abc", "0", "70000", "-1", "22 ", "08"]) {
      const r = await addPortForward.handler(
        { name: "n", src_port, dest_ip: "10.0.0.5", dest_port: "22" },
        ctxWithPost(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range dest_port", async () => {
    const post = vi.fn();
    const r = await addPortForward.handler(
      { name: "n", src_port: "22", dest_ip: "10.0.0.5", dest_port: "99999" },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a non-IP dest_ip (e.g. a hostname)", async () => {
    const post = vi.fn();
    for (const dest_ip of ["not-an-ip", "10.0.0.999", "10.0.0", "example.com"]) {
      const r = await addPortForward.handler(
        { name: "n", src_port: "22", dest_ip, dest_port: "22" },
        ctxWithPost(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects IPv6 dest_ip (routing service only accepts IPv4)", async () => {
    const post = vi.fn();
    for (const dest_ip of ["fd00::1", "::1", "2001:db8::1"]) {
      const r = await addPortForward.handler(
        { name: "n", src_port: "22", dest_ip, dest_port: "22" },
        ctxWithPost(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts lo-hi port ranges for src_port and dest_port", async () => {
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await addPortForward.handler(
      { name: "range-fwd", src_port: "8000-8100", dest_ip: "10.0.0.5", dest_port: "8000-8100", proto: "tcp" },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalled();
  });

  it("rejects malformed port ranges", async () => {
    const post = vi.fn();
    for (const src_port of ["0-100", "80-70", "abc-def", "8000-70000"]) {
      const r = await addPortForward.handler(
        { name: "n", src_port, dest_ip: "10.0.0.5", dest_port: "22" },
        ctxWithPost(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an unknown proto", async () => {
    const post = vi.fn();
    const r = await addPortForward.handler(
      { name: "n", src_port: "22", dest_ip: "10.0.0.5", dest_port: "22", proto: "sctp" },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });
});
