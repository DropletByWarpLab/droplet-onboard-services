import { describe, it, expect, vi } from "vitest";
import { buildContext, type ContextDeps } from "../src/context.js";

function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: { listDevices: vi.fn() } as never,
    httpFactory: () => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }),
  };
}

describe("buildContext", () => {
  it("composes a ToolContext with role/user from claims and an AbortSignal", () => {
    const deps = buildDeps();
    const signal = new AbortController().signal;
    const ctx = buildContext(deps, { sub: "u1", role: "admin" }, signal, "ncT");
    expect(ctx.userId).toBe("u1");
    expect(ctx.role).toBe("admin");
    expect(ctx.ncToken).toBe("ncT");
    expect(ctx.signal).toBe(signal);
    expect(ctx.http.routing).toBeDefined();
  });

  it("falls back to metaUserId when claims is undefined (stdio trusted path)", () => {
    // Trusted-stdio: orchestrator passes the dashboard user's username
    // via _meta.userId. claims is undefined.
    const ctx = buildContext(buildDeps(), undefined, new AbortController().signal, undefined, "alice");
    expect(ctx.userId).toBe("alice");
  });

  it("prefers claims.sub over metaUserId (HTTP trust boundary)", () => {
    // HTTP path: claims is the JWT-derived authority. Even if a client
    // tried to spoof _meta.userId, the JWT wins.
    const ctx = buildContext(
      buildDeps(),
      { sub: "real-user", role: "admin" },
      new AbortController().signal,
      undefined,
      "spoofed-user",
    );
    expect(ctx.userId).toBe("real-user");
  });

  it("userId is undefined when both claims and metaUserId are missing", () => {
    const ctx = buildContext(buildDeps(), undefined, new AbortController().signal);
    expect(ctx.userId).toBeUndefined();
  });

  it("binds search credentials to the authenticated caller", async () => {
    const deps = buildDeps();
    deps.searchHybrid = vi.fn(async () => []);
    const ctx = buildContext(deps, { sub: "alice", role: "admin" }, new AbortController().signal, "alice-token");
    await ctx.searchHybrid!({ query: "flux", limit: 5, userId: "bob", ncToken: "bob-token" } as never);
    expect(deps.searchHybrid).toHaveBeenCalledWith({
      query: "flux", limit: 5, userId: "alice", ncToken: "alice-token", _enhancement: undefined,
    });
  });

  it("does not let document args override caller identity or token", async () => {
    const deps = buildDeps();
    deps.readDocumentText = vi.fn(async () => ({
      source: null, chunks: [], totalChunks: 0, unreadableChunks: 0, nextChunk: null,
    }));
    const ctx = buildContext(deps, { sub: "alice", role: "admin" }, new AbortController().signal, "alice-token");
    await ctx.readDocumentText!({
      path: "/Droplet/flux.pdf", startChunk: 0, maxChars: 1000,
      userId: "bob", ncToken: "bob-token",
    } as never);
    expect(deps.readDocumentText).toHaveBeenCalledWith({
      path: "/Droplet/flux.pdf", startChunk: 0, maxChars: 1000,
      userId: "alice", ncToken: "alice-token",
    });
  });

  // WARP-3299 — the chat turn's ids reach the handler's context.
  it("carries the chat turn ids (conversation, message, tool call) into the context", () => {
    const ctx = buildContext(
      buildDeps(),
      undefined,
      new AbortController().signal,
      undefined,
      "alice",
      undefined,
      "owner",
      undefined,
      undefined,
      { conversationId: "conv-1", messageId: "msg-1", toolCallId: "call-1" },
    );
    expect(ctx).toMatchObject({ conversationId: "conv-1", messageId: "msg-1", toolCallId: "call-1" });
  });
});
