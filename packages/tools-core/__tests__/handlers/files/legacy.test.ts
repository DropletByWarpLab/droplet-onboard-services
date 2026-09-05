// Legacy test moved (and re-shaped) from
// `apps/orchestrator/src/__tests__/llm-tools-files.test.ts` per WARP-102 plan
// task 3.Y. The original test mocked specific `nc*` service functions and
// dispatched via the orchestrator's `dispatchTool()`. After the port, the
// canonical surface is `getTool(name)?.handler(args, ctx)` from
// `@droplet/tools-core`, with file ops calling through `ctx.http.nextcloud`
// instead of bound service helpers. The validation invariants (auth gating,
// path traversal, base64 strictness, root refusal) carry over unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getTool } from "../../../src/index.js";
import type { ToolContext } from "../../../src/types.js";

const ncToken = "test-token";
const userId = "alice";

interface CtxOpts {
  userId?: string;
  ncToken?: string;
  embedText?: ToolContext["embedText"];
  searchHybrid?: ToolContext["searchHybrid"];
  ncPost?: Mock;
  ncDelete?: Mock;
  prisma?: ToolContext["prisma"];
}

function makeCtx(opts: CtxOpts = {}) {
  const ncPost = opts.ncPost ?? vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const ncDelete = opts.ncDelete ?? vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const $queryRawUnsafe = vi.fn().mockResolvedValue([
    { path: "/Notes/idea.md", score: 0.92, text: "the rest of that idea..." },
  ]);
  const ctx: ToolContext = {
    prisma:
      opts.prisma ??
      ({ $queryRawUnsafe } as unknown as PrismaClient),
    http: {
      nextcloud: { get: vi.fn(), post: ncPost, patch: vi.fn(), delete: ncDelete },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    matter: {} as ToolContext["matter"],
    embedText: opts.embedText,
    searchHybrid: opts.searchHybrid,
    userId: opts.userId === undefined ? userId : opts.userId,
    ncToken: opts.ncToken === undefined ? ncToken : opts.ncToken,
    signal: new AbortController().signal,
  };
  return { ctx, ncPost, ncDelete, $queryRawUnsafe };
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler(args, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("file write tools — auth gating", () => {
  for (const tool of [
    "write_file",
    "delete_file",
    "create_directory",
    "rename_file",
    "move_file",
    "copy_file",
  ]) {
    it(`${tool} returns AUTH_REQUIRED without ncToken`, async () => {
      const { ctx } = makeCtx({ ncToken: "" });
      const res = await runTool(
        tool,
        { path: "/foo", from_path: "/foo", to_path: "/bar", new_name: "x", content: "x" },
        ctx,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    });

    it(`${tool} returns AUTH_REQUIRED without userId`, async () => {
      const { ctx } = makeCtx({ userId: "" });
      const res = await runTool(
        tool,
        { path: "/foo", from_path: "/foo", to_path: "/bar", new_name: "x", content: "x" },
        ctx,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    });
  }
});

describe("validateNcPath via tools", () => {
  for (const bad of [
    "/../etc/passwd",
    "/foo/../../bar",
    "/foo\0bar",
    "",
    // Percent-encoded traversal — Sabre/DAV decodes these, so validateNcPath must too.
    "/Notes/%2e%2e/admin/x",
    "/Notes/%2E%2E/admin/x",
    "/Notes/%252e%252e/admin/x",
    "/Notes/..\\admin",
  ]) {
    it(`write_file rejects malformed path ${JSON.stringify(bad)}`, async () => {
      const { ctx, ncPost } = makeCtx();
      const res = await runTool("write_file", { path: bad, content: "x" }, ctx);
      expect(res.ok).toBe(false);
      expect(ncPost).not.toHaveBeenCalled();
    });
  }

  it("write_file rejects path longer than 4096 chars", async () => {
    const { ctx, ncPost } = makeCtx();
    const longPath = "/" + "a".repeat(4096);
    const res = await runTool("write_file", { path: longPath, content: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe("path too long");
    expect(ncPost).not.toHaveBeenCalled();
  });

  // PR #1985 review: a malformed percent escape is a literal, not an error.
  it("write_file accepts a path holding a bare % as written", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("write_file", { path: "/Reports/50% Off.md", content: "x" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { written: string }).written).toBe("/Reports/50% Off.md");
    expect(ncPost).toHaveBeenCalledTimes(1);
  });

  it("write_file accepts a relative-looking path by prepending '/'", async () => {
    const { ctx } = makeCtx();
    const res = await runTool("write_file", { path: "Notes/x.md", content: "x" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { written: string }).written).toBe("/Notes/x.md");
  });

  // WARP-1373: the trailing separator is normalized away for every tool
  // that addresses a directory, but write_file needs a filename — a bare
  // "/Notes/" must not silently become a file literally named "Notes".
  it("write_file still refuses a directory-shaped path", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("write_file", { path: "/Notes/", content: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PATH");
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("create_directory accepts a trailing-slash path", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("create_directory", { path: "/Notes/Archive/" }, ctx);
    expect(res.ok).toBe(true);
    expect(ncPost).toHaveBeenCalledWith(
      "/mkdir",
      expect.objectContaining({ path: "/Notes/Archive" }),
      expect.anything(),
    );
  });

  it("delete_file accepts a trailing-slash directory path", async () => {
    const { ctx, ncDelete } = makeCtx();
    const res = await runTool("delete_file", { path: "/Notes/Archive/" }, ctx);
    expect(res.ok).toBe(true);
    expect(ncDelete).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/Notes/Archive")}`,
      expect.anything(),
    );
  });

  it("move_file normalizes trailing slashes on both endpoints", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("move_file", { from_path: "/a/b/", to_path: "/c/d/" }, ctx);
    expect(res.ok).toBe(true);
    expect(ncPost).toHaveBeenCalledWith(
      "/move",
      expect.objectContaining({ from: "/a/b", to: "/c/d" }),
      expect.anything(),
    );
  });
});

describe("write_file", () => {
  it("uploads UTF-8 content to /upload with dir/filename split", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool(
      "write_file",
      { path: "/Notes/hello.md", content: "Hello world" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { written: string }).written).toBe("/Notes/hello.md");
      expect((res.data as { bytes: number }).bytes).toBe(
        Buffer.byteLength("Hello world", "utf8"),
      );
    }
    expect(ncPost).toHaveBeenCalledWith(
      "/upload",
      expect.objectContaining({
        dir: "/Notes",
        filename: "hello.md",
        contentBase64: Buffer.from("Hello world", "utf8").toString("base64"),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": ncToken,
          "X-Nextcloud-User": userId,
        }),
      }),
    );
  });

  it("decodes valid base64 content", async () => {
    const { ctx, ncPost } = makeCtx();
    const b64 = Buffer.from("binary data").toString("base64");
    const res = await runTool(
      "write_file",
      { path: "/files/bin.dat", content_base64: b64 },
      ctx,
    );
    expect(res.ok).toBe(true);
    const callBody = ncPost.mock.calls[0][1];
    expect(Buffer.from(callBody.contentBase64, "base64").toString()).toBe("binary data");
  });

  it("rejects malformed base64", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool(
      "write_file",
      { path: "/files/bin.dat", content_base64: "not valid base64!!!" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_BASE64");
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("rejects content larger than 10 MB", async () => {
    const { ctx, ncPost } = makeCtx();
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const res = await runTool("write_file", { path: "/files/big.txt", content: big }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TOO_LARGE");
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("rejects when neither content nor content_base64 is provided", async () => {
    const { ctx } = makeCtx();
    const res = await runTool("write_file", { path: "/files/x.txt" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/content or content_base64/);
  });

  it("rejects a path that has no filename", async () => {
    const { ctx } = makeCtx();
    const res = await runTool("write_file", { path: "/", content: "x" }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe("delete_file", () => {
  it("calls nextcloud DELETE and reports the deleted path", async () => {
    const { ctx, ncDelete } = makeCtx();
    const res = await runTool("delete_file", { path: "/old/junk.txt" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { deleted: string }).deleted).toBe("/old/junk.txt");
    expect(ncDelete).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/old/junk.txt")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": ncToken,
          "X-Nextcloud-User": userId,
        }),
      }),
    );
  });

  it("refuses to delete root", async () => {
    const { ctx, ncDelete } = makeCtx();
    const res = await runTool("delete_file", { path: "/" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/root/);
    expect(ncDelete).not.toHaveBeenCalled();
  });
});

describe("create_directory", () => {
  it("calls nextcloud /mkdir", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("create_directory", { path: "/Projects/2026" }, ctx);
    expect(res.ok).toBe(true);
    expect(ncPost).toHaveBeenCalledWith(
      "/mkdir",
      { path: "/Projects/2026" },
      expect.anything(),
    );
  });

  it("refuses to create root", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("create_directory", { path: "/" }, ctx);
    expect(res.ok).toBe(false);
    expect(ncPost).not.toHaveBeenCalled();
  });
});

describe("rename_file", () => {
  it("renames in place by joining new_name with the parent dir", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool(
      "rename_file",
      { path: "/Notes/old.md", new_name: "new.md" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { renamed_to: string }).renamed_to).toBe("/Notes/new.md");
    }
    expect(ncPost).toHaveBeenCalledWith(
      "/move",
      { from: "/Notes/old.md", to: "/Notes/new.md", overwrite: false },
      expect.anything(),
    );
  });

  it("rejects a new_name containing slashes", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool(
      "rename_file",
      { path: "/Notes/old.md", new_name: "../escape.md" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/plain filename/);
    expect(ncPost).not.toHaveBeenCalled();
  });

  for (const bad of [
    ".",
    "..",
    "with/slash",
    "back\\slash",
    "null\0byte",
    "%2e%2e",
    "with%2fslash",
    "with%5cbackslash",
    "%252e%252e",
    "%zz",
  ]) {
    it(`rejects new_name ${JSON.stringify(bad)}`, async () => {
      const { ctx, ncPost } = makeCtx();
      const res = await runTool(
        "rename_file",
        { path: "/x.md", new_name: bad },
        ctx,
      );
      expect(res.ok).toBe(false);
      expect(ncPost).not.toHaveBeenCalled();
    });
  }

  it("refuses to rename root", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool("rename_file", { path: "/", new_name: "newroot" }, ctx);
    expect(res.ok).toBe(false);
    expect(ncPost).not.toHaveBeenCalled();
  });
});

describe("move_file & copy_file", () => {
  it("move_file passes overwrite flag through to /move", async () => {
    const { ctx, ncPost } = makeCtx();
    await runTool(
      "move_file",
      { from_path: "/a.txt", to_path: "/b.txt", overwrite: true },
      ctx,
    );
    expect(ncPost).toHaveBeenCalledWith(
      "/move",
      { from: "/a.txt", to: "/b.txt", overwrite: true },
      expect.anything(),
    );
  });

  it("move_file defaults overwrite to false", async () => {
    const { ctx, ncPost } = makeCtx();
    await runTool("move_file", { from_path: "/a.txt", to_path: "/b.txt" }, ctx);
    expect(ncPost).toHaveBeenCalledWith(
      "/move",
      { from: "/a.txt", to: "/b.txt", overwrite: false },
      expect.anything(),
    );
  });

  it("move_file rejects identical from_path/to_path", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await runTool(
      "move_file",
      { from_path: "/x.txt", to_path: "/x.txt" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/same/);
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("move_file refuses to move root", async () => {
    const { ctx } = makeCtx();
    const res = await runTool("move_file", { from_path: "/", to_path: "/dest" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/root/);
  });

  it("copy_file passes overwrite flag through to /copy", async () => {
    const { ctx, ncPost } = makeCtx();
    await runTool(
      "copy_file",
      { from_path: "/a.txt", to_path: "/b.txt", overwrite: true },
      ctx,
    );
    expect(ncPost).toHaveBeenCalledWith(
      "/copy",
      { from: "/a.txt", to: "/b.txt", overwrite: true },
      expect.anything(),
    );
  });

  it("copy_file refuses root as either source or destination", async () => {
    const { ctx, ncPost } = makeCtx();
    const r1 = await runTool("copy_file", { from_path: "/", to_path: "/dest" }, ctx);
    expect(r1.ok).toBe(false);
    const r2 = await runTool("copy_file", { from_path: "/src.txt", to_path: "/" }, ctx);
    expect(r2.ok).toBe(false);
    expect(ncPost).not.toHaveBeenCalled();
  });
});

describe("search_content", () => {
  it("rejects a query shorter than 2 characters", async () => {
    const searchHybrid = vi.fn();
    const { ctx } = makeCtx({ searchHybrid });
    const res = await runTool("search_content", { query: "a" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/at least 2/);
    expect(searchHybrid).not.toHaveBeenCalled();
  });

  it("returns SEARCH_UNAVAILABLE when ctx.searchHybrid is missing", async () => {
    // WARP-286: the handler delegates to ctx.searchHybrid. When the
    // orchestrator hasn't wired it (e.g. embedder unavailable at
    // context-build time), the handler returns SEARCH_UNAVAILABLE.
    const { ctx } = makeCtx();
    const res = await runTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("SEARCH_UNAVAILABLE");
      expect(res.error.message).toBe("search_unavailable");
    }
  });

  it("returns SEARCH_FAILED when searchHybrid throws", async () => {
    const searchHybrid = vi
      .fn()
      .mockRejectedValue(new Error("ai-gateway unreachable"));
    const { ctx } = makeCtx({ searchHybrid });
    const res = await runTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("SEARCH_FAILED");
      expect(res.error.message).toBe("search_failed");
    }
  });

  it("returns hybrid retrieval results in the wire shape", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([
      {
        source: "nextcloud" as const,
        path: "/Notes/idea.md",
        chunkIdx: 0,
        pageNumber: null,
        brainItemId: null,
        score: 0.92,
        snippet: "the rest of that idea...",
        metadata: null,
      },
    ]);
    const { ctx } = makeCtx({ searchHybrid });
    const res = await runTool(
      "search_content",
      { query: "voltage regulator", limit: 5 },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as {
        query: string;
        results: Array<{ path: string; source: string; score: number }>;
      };
      expect(data.query).toBe("voltage regulator");
      expect(data.results).toHaveLength(1);
      expect(data.results[0].path).toBe("/Notes/idea.md");
      expect(data.results[0].source).toBe("nextcloud");
      expect(data.results[0].score).toBe(0.92);
    }
    expect(searchHybrid).toHaveBeenCalledTimes(1);
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "voltage regulator",
      limit: 5,
      enhance: undefined,
    });
  });

  it("clamps limit to [1, 50]", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    const { ctx } = makeCtx({ searchHybrid });
    await runTool(
      "search_content",
      { query: "voltage regulator", limit: 9999 },
      ctx,
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "voltage regulator",
      limit: 50,
      enhance: undefined,
    });
  });

  it("requires userId", async () => {
    const searchHybrid = vi.fn();
    const { ctx } = makeCtx({ searchHybrid, userId: "" });
    const res = await runTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(searchHybrid).not.toHaveBeenCalled();
  });
});
