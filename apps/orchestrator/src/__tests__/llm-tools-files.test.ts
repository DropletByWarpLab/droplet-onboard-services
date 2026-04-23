import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock the Nextcloud client surface the file tools call through.
const ncUploadFile = vi.fn().mockResolvedValue(undefined);
const ncDeleteFile = vi.fn().mockResolvedValue(undefined);
const ncCreateDirectory = vi.fn().mockResolvedValue(undefined);
const ncMoveFile = vi.fn().mockResolvedValue(undefined);
const ncCopyFile = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/nextcloud.client.js", () => ({
  ncUploadFile: (...a: unknown[]) => ncUploadFile(...a),
  ncDeleteFile: (...a: unknown[]) => ncDeleteFile(...a),
  ncCreateDirectory: (...a: unknown[]) => ncCreateDirectory(...a),
  ncMoveFile: (...a: unknown[]) => ncMoveFile(...a),
  ncCopyFile: (...a: unknown[]) => ncCopyFile(...a),
  // Read tools also live in the registry but aren't exercised here.
  ncListFiles: vi.fn(),
  ncSearchFiles: vi.fn(),
  ncListRecents: vi.fn(),
}));

// Mock the gRPC embedder so search_content tests are deterministic.
const grpcEmbedText = vi.fn();
const isGrpcAvailable = vi.fn();
vi.mock("../services/ai-gateway.grpc-client.js", () => ({
  grpcEmbedText: (...a: unknown[]) => grpcEmbedText(...a),
  isGrpcAvailable: () => isGrpcAvailable(),
}));

// Other modules llm-tools.ts imports but these tests don't exercise.
vi.mock("../services/openwrt.client.js", () => ({}));
vi.mock("../services/frigate.client.js", () => ({}));
vi.mock("../services/health-monitor.service.js", () => ({}));
vi.mock("../config.js", () => ({
  config: {
    CAMERA_DISCOVERY_URL: "http://camera-discovery:8000",
  },
}));

import { dispatchTool } from "../services/llm-tools.js";

const ncToken = "test-token";
const userId = "alice";

function makeCtx(overrides: Partial<{ userId: string; ncToken: string }> = {}) {
  const $queryRawUnsafe = vi.fn().mockResolvedValue([
    { path: "/Notes/idea.md", score: 0.92, text: "the rest of that idea..." },
  ]);
  return {
    prisma: { $queryRawUnsafe } as unknown as PrismaClient,
    userId: overrides.userId === undefined ? userId : overrides.userId,
    ncToken: overrides.ncToken === undefined ? ncToken : overrides.ncToken,
    _queryRawUnsafe: $queryRawUnsafe,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isGrpcAvailable.mockReturnValue(true);
  grpcEmbedText.mockResolvedValue([new Array(384).fill(0.1)]);
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
    it(`${tool} returns auth_required without ncToken`, async () => {
      const ctx = makeCtx({ ncToken: "" });
      const res = (await dispatchTool(
        tool,
        { path: "/foo", from_path: "/foo", to_path: "/bar", new_name: "x", content: "x" },
        ctx,
      )) as { error?: string };
      expect(res.error).toBe("auth_required");
    });

    it(`${tool} returns auth_required without userId`, async () => {
      const ctx = makeCtx({ userId: "" });
      const res = (await dispatchTool(
        tool,
        { path: "/foo", from_path: "/foo", to_path: "/bar", new_name: "x", content: "x" },
        ctx,
      )) as { error?: string };
      expect(res.error).toBe("auth_required");
    });
  }
});

describe("validateNcPath via tools", () => {
  for (const bad of [
    "/../etc/passwd",
    "/foo/../../bar",
    "/foo\0bar",
    "",
    // Percent-encoded traversal — Sabre/DAV decodes these, so validateNcPath
    // must too. See security-review finding on the `validateNcPath` helper.
    "/Notes/%2e%2e/admin/x",
    "/Notes/%2E%2E/admin/x",
    // Double-encoded
    "/Notes/%252e%252e/admin/x",
    // Backslash separator (Nextcloud may treat as a separator on some platforms)
    "/Notes/..\\admin",
    // Malformed percent-encoding
    "/Notes/%zz",
  ]) {
    it(`write_file rejects malformed path ${JSON.stringify(bad)}`, async () => {
      const ctx = makeCtx();
      const res = (await dispatchTool(
        "write_file",
        { path: bad, content: "x" },
        ctx,
      )) as { error?: string };
      expect(res.error).toBeTruthy();
      expect(ncUploadFile).not.toHaveBeenCalled();
    });
  }

  it("write_file rejects path longer than 4096 chars", async () => {
    const ctx = makeCtx();
    const longPath = "/" + "a".repeat(4096);
    const res = (await dispatchTool(
      "write_file",
      { path: longPath, content: "x" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("path too long");
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("write_file accepts a relative-looking path by prepending '/'", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "write_file",
      { path: "Notes/x.md", content: "x" },
      ctx,
    )) as { written?: string };
    expect(res.written).toBe("/Notes/x.md");
  });
});

describe("write_file", () => {
  it("writes UTF-8 content via ncUploadFile", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "write_file",
      { path: "/Notes/hello.md", content: "Hello world" },
      ctx,
    )) as { written?: string; bytes?: number };
    expect(res.written).toBe("/Notes/hello.md");
    expect(res.bytes).toBe(Buffer.byteLength("Hello world", "utf8"));
    expect(ncUploadFile).toHaveBeenCalledWith(
      ncToken,
      userId,
      "/Notes",
      "hello.md",
      expect.any(Buffer),
    );
  });

  it("decodes valid base64 content", async () => {
    const ctx = makeCtx();
    const b64 = Buffer.from("binary data").toString("base64");
    const res = (await dispatchTool(
      "write_file",
      { path: "/files/bin.dat", content_base64: b64 },
      ctx,
    )) as { written?: string };
    expect(res.written).toBe("/files/bin.dat");
    const callBuffer = ncUploadFile.mock.calls[0][4] as Buffer;
    expect(callBuffer.toString()).toBe("binary data");
  });

  it("rejects malformed base64", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "write_file",
      { path: "/files/bin.dat", content_base64: "not valid base64!!!" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("invalid base64 content");
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("rejects content larger than 10 MB", async () => {
    const ctx = makeCtx();
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const res = (await dispatchTool(
      "write_file",
      { path: "/files/big.txt", content: big },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/content too large/);
    expect(ncUploadFile).not.toHaveBeenCalled();
  });

  it("rejects when neither content nor content_base64 is provided", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "write_file",
      { path: "/files/x.txt" },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/content or content_base64/);
  });

  it("rejects a path that has no filename", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "write_file",
      { path: "/", content: "x" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("path must include a filename");
  });
});

describe("delete_file", () => {
  it("calls ncDeleteFile and reports the deleted path", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "delete_file",
      { path: "/old/junk.txt" },
      ctx,
    )) as { deleted?: string };
    expect(res.deleted).toBe("/old/junk.txt");
    expect(ncDeleteFile).toHaveBeenCalledWith(ncToken, userId, "/old/junk.txt");
  });

  it("refuses to delete root", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool("delete_file", { path: "/" }, ctx)) as {
      error?: string;
    };
    expect(res.error).toBe("refusing to delete root");
    expect(ncDeleteFile).not.toHaveBeenCalled();
  });
});

describe("create_directory", () => {
  it("calls ncCreateDirectory", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "create_directory",
      { path: "/Projects/2026" },
      ctx,
    )) as { created?: string };
    expect(res.created).toBe("/Projects/2026");
    expect(ncCreateDirectory).toHaveBeenCalledWith(ncToken, userId, "/Projects/2026");
  });

  it("refuses to create root", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool("create_directory", { path: "/" }, ctx)) as {
      error?: string;
    };
    expect(res.error).toBe("cannot create root");
    expect(ncCreateDirectory).not.toHaveBeenCalled();
  });
});

describe("rename_file", () => {
  it("renames in place by joining new_name with the parent dir", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "rename_file",
      { path: "/Notes/old.md", new_name: "new.md" },
      ctx,
    )) as { renamed_to?: string };
    expect(res.renamed_to).toBe("/Notes/new.md");
    expect(ncMoveFile).toHaveBeenCalledWith(
      ncToken,
      userId,
      "/Notes/old.md",
      "/Notes/new.md",
      false,
    );
  });

  it("rejects a new_name containing slashes", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "rename_file",
      { path: "/Notes/old.md", new_name: "../escape.md" },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/new_name must be a plain filename/);
    expect(ncMoveFile).not.toHaveBeenCalled();
  });

  for (const bad of [
    ".",
    "..",
    "with/slash",
    "back\\slash",
    "null\0byte",
    // Percent-encoded variants — see security-review finding on validateNcPath.
    "%2e%2e",
    "with%2fslash",
    "with%5cbackslash",
    "%252e%252e", // double-encoded
    "%zz", // malformed
  ]) {
    it(`rejects new_name ${JSON.stringify(bad)}`, async () => {
      const ctx = makeCtx();
      const res = (await dispatchTool(
        "rename_file",
        { path: "/x.md", new_name: bad },
        ctx,
      )) as { error?: string };
      expect(res.error).toBeTruthy();
      expect(ncMoveFile).not.toHaveBeenCalled();
    });
  }

  it("refuses to rename root", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "rename_file",
      { path: "/", new_name: "newroot" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("cannot rename root");
    expect(ncMoveFile).not.toHaveBeenCalled();
  });
});

describe("move_file & copy_file", () => {
  it("move_file passes overwrite flag through to ncMoveFile", async () => {
    const ctx = makeCtx();
    await dispatchTool(
      "move_file",
      { from_path: "/a.txt", to_path: "/b.txt", overwrite: true },
      ctx,
    );
    expect(ncMoveFile).toHaveBeenCalledWith(ncToken, userId, "/a.txt", "/b.txt", true);
  });

  it("move_file defaults overwrite to false", async () => {
    const ctx = makeCtx();
    await dispatchTool("move_file", { from_path: "/a.txt", to_path: "/b.txt" }, ctx);
    expect(ncMoveFile).toHaveBeenCalledWith(ncToken, userId, "/a.txt", "/b.txt", false);
  });

  it("move_file rejects identical from_path/to_path", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "move_file",
      { from_path: "/x.txt", to_path: "/x.txt" },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/same/);
    expect(ncMoveFile).not.toHaveBeenCalled();
  });

  it("move_file refuses to move root", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "move_file",
      { from_path: "/", to_path: "/dest" },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/root/);
  });

  it("copy_file passes overwrite flag through", async () => {
    const ctx = makeCtx();
    await dispatchTool(
      "copy_file",
      { from_path: "/a.txt", to_path: "/b.txt", overwrite: true },
      ctx,
    );
    expect(ncCopyFile).toHaveBeenCalledWith(ncToken, userId, "/a.txt", "/b.txt", true);
  });

  it("copy_file refuses root as either source or destination", async () => {
    const ctx = makeCtx();
    const res1 = (await dispatchTool(
      "copy_file",
      { from_path: "/", to_path: "/dest" },
      ctx,
    )) as { error?: string };
    expect(res1.error).toMatch(/root/);
    const res2 = (await dispatchTool(
      "copy_file",
      { from_path: "/src.txt", to_path: "/" },
      ctx,
    )) as { error?: string };
    expect(res2.error).toMatch(/root/);
    expect(ncCopyFile).not.toHaveBeenCalled();
  });
});

describe("search_content", () => {
  it("rejects a query shorter than 2 characters", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "search_content",
      { query: "a" },
      ctx,
    )) as { error?: string };
    expect(res.error).toMatch(/at least 2/);
    expect(grpcEmbedText).not.toHaveBeenCalled();
  });

  it("returns embedding_service_unavailable when gRPC is down", async () => {
    isGrpcAvailable.mockReturnValue(false);
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("embedding_service_unavailable");
  });

  it("rejects non-finite vector elements from a misbehaving embedder", async () => {
    grpcEmbedText.mockResolvedValueOnce([[0.1, NaN, 0.3]]);
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("embedding_service_returned_invalid_vector");
  });

  it("queries pgvector and returns ranked results", async () => {
    const ctx = makeCtx();
    const res = (await dispatchTool(
      "search_content",
      { query: "voltage regulator", limit: 5 },
      ctx,
    )) as { query?: string; results?: Array<{ path: string }> };
    expect(res.query).toBe("voltage regulator");
    expect(res.results).toHaveLength(1);
    expect(res.results?.[0].path).toBe("/Notes/idea.md");

    expect(ctx._queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [, vecLiteral, calledUser, calledLimit] =
      ctx._queryRawUnsafe.mock.calls[0];
    expect(vecLiteral).toMatch(/^\[/);
    expect(calledUser).toBe(userId);
    expect(calledLimit).toBe(5);
  });

  it("clamps limit to [1, 50]", async () => {
    const ctx = makeCtx();
    await dispatchTool(
      "search_content",
      { query: "voltage regulator", limit: 9999 },
      ctx,
    );
    const [, , , calledLimit] = ctx._queryRawUnsafe.mock.calls[0];
    expect(calledLimit).toBe(50);
  });

  it("requires userId", async () => {
    const ctx = makeCtx({ userId: "" });
    const res = (await dispatchTool(
      "search_content",
      { query: "voltage regulator" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("auth_required");
  });
});
