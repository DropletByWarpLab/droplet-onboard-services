import { describe, it, expect, vi } from "vitest";
import { buildContext, type ContextDeps } from "../src/context.js";

describe("buildContext", () => {
  it("composes a ToolContext with role/user from claims and an AbortSignal", () => {
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: { listDevices: vi.fn() } as never,
      httpFactory: () => ({
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
    };
    const signal = new AbortController().signal;
    const ctx = buildContext(deps, { sub: "u1", role: "admin" }, signal, "ncT");
    expect(ctx.userId).toBe("u1");
    expect(ctx.role).toBe("admin");
    expect(ctx.ncToken).toBe("ncT");
    expect(ctx.signal).toBe(signal);
    expect(ctx.http.routing).toBeDefined();
  });
});
