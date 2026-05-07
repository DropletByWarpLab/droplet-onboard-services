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
});
