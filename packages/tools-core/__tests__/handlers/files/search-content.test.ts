// WARP-437: covers the new `enhance` input block on search_content.
// Baseline behaviour (no enhance, query length, SEARCH_UNAVAILABLE, etc.)
// is exercised in legacy.test.ts. This file focuses on the parseEnhance
// pipeline + how the handler forwards (or drops) the field.

import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getTool } from "../../../src/index.js";
import type { ToolContext } from "../../../src/types.js";

function makeCtx(searchHybrid: Mock): ToolContext {
  return {
    prisma: {} as PrismaClient,
    http: {
      nextcloud: {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    } as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    searchHybrid,
    userId: "alice",
    ncToken: "test-token",
    signal: new AbortController().signal,
  };
}

describe("search_content tool — enhance input (WARP-437)", () => {
  const tool = getTool("search_content")!;

  it("forwards enhance to ctx.searchHybrid when fully provided", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      { query: "test query", enhance: { hyde: true, multiQuery: true, n: 3 } },
      makeCtx(searchHybrid),
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "test query",
      limit: 10,
      enhance: { hyde: true, multiQuery: true, n: 3 },
    });
  });

  it("forwards enhance=undefined when not provided", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler({ query: "test query" }, makeCtx(searchHybrid));
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "test query",
      limit: 10,
      enhance: undefined,
    });
  });

  it("ignores malformed enhance fields (wrong types / out-of-range n)", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      {
        query: "x x",
        enhance: { hyde: "yes", multiQuery: 1, n: 99 } as unknown,
      },
      makeCtx(searchHybrid),
    );
    // All three fields filtered out by parseEnhance → enhance becomes undefined.
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "x x",
      limit: 10,
      enhance: undefined,
    });
  });

  it("drops n when below 2 (n=1) but keeps valid sibling fields", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      { query: "x x", enhance: { hyde: true, n: 1 } },
      makeCtx(searchHybrid),
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "x x",
      limit: 10,
      enhance: { hyde: true },
    });
  });

  it("drops n when above 5 (n=6) but keeps valid sibling fields", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      { query: "x x", enhance: { multiQuery: true, n: 6 } },
      makeCtx(searchHybrid),
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "x x",
      limit: 10,
      enhance: { multiQuery: true },
    });
  });

  it("accepts partial enhance (e.g. just hyde)", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      { query: "x x", enhance: { hyde: true } },
      makeCtx(searchHybrid),
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "x x",
      limit: 10,
      enhance: { hyde: true },
    });
  });

  it("treats non-object enhance (string / number / array) as undefined", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    await tool.handler(
      { query: "x x", enhance: "hyde" as unknown },
      makeCtx(searchHybrid),
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "x x",
      limit: 10,
      enhance: undefined,
    });
  });
});
