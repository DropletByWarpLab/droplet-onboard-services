import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listFileVersions from "../../../src/handlers/files/list-file-versions.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  get: Mock,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "tok" : opts.ncToken,
    signal: new AbortController().signal,
  };
}

const VERSIONS_PAYLOAD = {
  fileId: 42,
  versions: [
    { versionId: "1752900000", size: 2048, modifiedAt: "2026-07-19T05:20:00.000Z" },
    { versionId: "1752800000", size: 1024, modifiedAt: "2026-07-18T01:33:20.000Z" },
  ],
};

describe("list_file_versions", () => {
  // Same auth gate as read_file (TOOLS-03): both halves of the NC
  // credential are required BEFORE any HTTP.
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const get = vi.fn();
    const r = await listFileVersions.handler(
      { path: "/notes/x.txt" },
      ctxWith(get, { ncToken: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    // The message is the model's only recovery signal — it must say HOW
    // to fix the state, not read as a permissions refusal.
    if (!r.ok) expect(r.error.message).toContain("sign back in with their password");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const get = vi.fn();
    const r = await listFileVersions.handler(
      { path: "/notes/x.txt" },
      ctxWith(get, { userId: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  for (const bad of ["/../etc/passwd", "/foo\0bar", "", "/Notes/%2e%2e/admin/x"]) {
    it(`rejects malformed path ${JSON.stringify(bad)} with INVALID_PATH`, async () => {
      const get = vi.fn();
      const r = await listFileVersions.handler({ path: bad }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
      expect(get).not.toHaveBeenCalled();
    });
  }

  it("lists versions with the exact route path and NC identity headers", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VERSIONS_PAYLOAD), { status: 200 }),
    );
    const r = await listFileVersions.handler({ path: "/Docs/report.md" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/versions?path=${encodeURIComponent("/Docs/report.md")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "list_file_versions",
        path: "/Docs/report.md",
        versions: [
          { versionId: "1752900000", size: 2048, modifiedAt: "2026-07-19T05:20:00.000Z" },
          { versionId: "1752800000", size: 1024, modifiedAt: "2026-07-18T01:33:20.000Z" },
        ],
        count: 2,
      });
    }
  });

  it("empty history is a SUCCESS with count 0 (not an error)", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ fileId: 7, versions: [] }), { status: 200 }),
    );
    const r = await listFileVersions.handler({ path: "/fresh.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "list_file_versions",
        path: "/fresh.txt",
        versions: [],
        count: 0,
      });
    }
  });

  it("maps 404 to NOT_FOUND", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 }),
    );
    const r = await listFileVersions.handler({ path: "/gone.txt" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toContain("/gone.txt");
    }
  });

  it("maps other failures to VERSIONS_UNAVAILABLE", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const r = await listFileVersions.handler({ path: "/x.txt" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VERSIONS_UNAVAILABLE");
  });

  it("maps a malformed 200 body to VERSIONS_UNAVAILABLE", async () => {
    const get = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const r = await listFileVersions.handler({ path: "/x.txt" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VERSIONS_UNAVAILABLE");
  });

  it("metadata: Tier-1 read-only tool", () => {
    expect(listFileVersions.name).toBe("list_file_versions");
    expect(listFileVersions.requiresWrite).toBe(false);
    expect(listFileVersions.requiresConfirmation).toBe(false);
    expect(listFileVersions.inputSchema).toMatchObject({
      required: ["path"],
      additionalProperties: false,
    });
  });
});
