import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import restoreFileVersion from "../../../src/handlers/files/restore-file-version.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  post: Mock,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
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

const ARGS = { path: "/Docs/report.md", version: "1752800000" };

describe("restore_file_version", () => {
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const post = vi.fn();
    const r = await restoreFileVersion.handler(
      { ...ARGS, confirmed: true },
      ctxWith(post, { ncToken: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    if (!r.ok) expect(r.error.message).toContain("sign back in with their password");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const post = vi.fn();
    const r = await restoreFileVersion.handler(
      { ...ARGS, confirmed: true },
      ctxWith(post, { userId: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects traversal paths with INVALID_PATH before any HTTP", async () => {
    const post = vi.fn();
    const r = await restoreFileVersion.handler(
      { path: "/../etc/passwd", version: "1", confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
    expect(post).not.toHaveBeenCalled();
  });

  for (const bad of [undefined, "", "   ", 1752800000]) {
    it(`rejects version ${JSON.stringify(bad)} with INVALID_ARGS`, async () => {
      const post = vi.fn();
      const r = await restoreFileVersion.handler(
        { path: "/Docs/report.md", version: bad, confirmed: true },
        ctxWith(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
      expect(post).not.toHaveBeenCalled();
    });
  }

  // Tier-2, handler-enforced: the first (unconfirmed) call must return
  // confirmation_required with ZERO HTTP — nothing is restored until the
  // user has explicitly approved.
  for (const confirmed of [undefined, false] as const) {
    it(`confirmation-first: confirmed=${String(confirmed)} → confirmation_required, zero HTTP`, async () => {
      const post = vi.fn();
      const r = await restoreFileVersion.handler(
        confirmed === undefined ? { ...ARGS } : { ...ARGS, confirmed },
        ctxWith(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe("confirmation_required");
        expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
        // The echo must name the file AND the version, and state that the
        // current content gets replaced (recoverably — Nextcloud keeps it
        // as the newest version, per ncRestoreVersion's contract).
        expect(r.error.message).toContain('"/Docs/report.md"');
        expect(r.error.message).toContain("1752800000");
        expect(r.error.message).toContain("replace the file's current content");
        expect(r.error.message).toContain("keeps the current content as the newest version");
        expect(r.error.details).toEqual({
          type: "restore_file_version",
          path: "/Docs/report.md",
          version: "1752800000",
        });
      }
      expect(post).not.toHaveBeenCalled();
    });
  }

  it("confirmed: restores via the exact route, body, and NC identity headers", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ restored: { path: "/Docs/report.md", versionId: "1752800000" } }),
        { status: 200 },
      ),
    );
    const r = await restoreFileVersion.handler({ ...ARGS, confirmed: true }, ctxWith(post));
    expect(post).toHaveBeenCalledWith(
      "/versions/restore",
      { path: "/Docs/report.md", versionId: "1752800000" },
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
        type: "restore_file_version",
        path: "/Docs/report.md",
        version: "1752800000",
        restored: true,
      });
    }
  });

  it("maps 404 to NOT_FOUND (the route 404s on the file path)", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 }),
    );
    const r = await restoreFileVersion.handler({ ...ARGS, confirmed: true }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toContain("/Docs/report.md");
    }
  });

  it("maps other failures to RESTORE_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const r = await restoreFileVersion.handler({ ...ARGS, confirmed: true }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RESTORE_FAILED");
  });

  it("metadata: Tier-2 write tool with confirmation", () => {
    expect(restoreFileVersion.name).toBe("restore_file_version");
    expect(restoreFileVersion.requiresWrite).toBe(true);
    expect(restoreFileVersion.requiresConfirmation).toBe(true);
    expect(restoreFileVersion.inputSchema).toMatchObject({
      required: ["path", "version"],
      additionalProperties: false,
    });
  });
});
