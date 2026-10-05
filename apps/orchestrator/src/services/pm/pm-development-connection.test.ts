import { describe, expect, it, vi } from "vitest";
import type { DevelopmentFetchDeps } from "./pm-dev-egress.js";

const stubs = vi.hoisted(() => ({ factory: vi.fn(), guarded: vi.fn() }));
vi.mock("../erp-provider.js", () => ({ cloudMaterialFromRow: () => ({ connectionId: "c1" }), connectorForProvider: stubs.factory }));
vi.mock("./pm-dev-egress.js", async () => ({ ...await vi.importActual("./pm-dev-egress.js"), createDevelopmentFetch: stubs.guarded }));
import { listDevelopmentRepositories } from "./pm-development.service.js";

describe("development connection snapshot at the dial", () => {
  it.each(["DISABLED", "rotation", "configuration", "unreadable"])("refuses %s after constructing a connector", async (change) => {
    const original = { id: "c1", provider: "github", providerConfig: { owner: "one" }, providerTokensEnc: "sealed-one", status: "CONNECTED" };
    const current = change === "DISABLED" ? { ...original, status: "DISABLED" } : change === "rotation" ? { ...original, providerTokensEnc: "sealed-two" } : { ...original, providerConfig: { owner: "two" } };
    const findUnique = change === "unreadable" ? vi.fn().mockRejectedValue(new Error("db unavailable")) : vi.fn().mockResolvedValue(current);
    const prisma = { integrationConnection: { findFirst: vi.fn().mockResolvedValue(original), findUnique } };
    let guard: DevelopmentFetchDeps["connectionCurrent"];
    stubs.guarded.mockImplementation((_prisma, deps: DevelopmentFetchDeps) => { guard = deps.connectionCurrent; return { fetch: vi.fn(), blocked: null }; });
    stubs.factory.mockReturnValue({ readDevelopment: async () => ({ status: "ok", items: [] }) });
    await listDevelopmentRepositories(prisma as never, "github");
    expect(guard).toBeTypeOf("function");
    if (change === "unreadable") await expect(guard!()).rejects.toThrow("db unavailable");
    else await expect(guard!()).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1" } }));
  });
});
