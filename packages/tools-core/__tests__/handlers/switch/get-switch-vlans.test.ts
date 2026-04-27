import { describe, it, expect, vi } from "vitest";
import getSwitchVlans from "../../../src/handlers/switch/get-switch-vlans.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      switchSvc: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

describe("get_switch_vlans", () => {
  it("hits /vlans", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const r = await getSwitchVlans.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith("/vlans", expect.anything());
  });
});
