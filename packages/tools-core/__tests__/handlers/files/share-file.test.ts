import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import shareFile from "../../../src/handlers/files/share-file.js";
import { runApproved } from "../../helpers/approve.js";
import { runApproved } from "../../helpers/approve.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  post: ReturnType<typeof vi.fn>,
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

const SECRET = "hunter2-hunter2";

/** ShareDetail-shaped 200 body (the route passes ncCreateShareV2 through). */
function shareResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 101,
      url: "https://nc.example/s/AbCdEf",
      token: "AbCdEf",
      shareType: 3,
      permissions: 1,
      path: "/Docs/report.md",
      expireDate: "2026-07-27",
      hasPassword: false,
      note: null,
      shareWith: null,
      shareWithDisplayName: null,
      uidOwner: "alice",
      ownerDisplayName: "Alice",
      stime: 1753000000,
      ...overrides,
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  // Pin Date.now() so the computed default expiry (7 days) is deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// WARP-2002 — the confirmation token is bound to the SHARE PARAMETERS, not
// just the path. Approving a view-only, password-protected, 7-day link must
// not authorise a public editable one for the same file. Mutation that proves
// these bite: drop `allowEdit` (or `passwordProtected`, or `expireDate`) from
// the fingerprint in share-file.ts — each case below turns red.
describe("share_file — token is bound to the link's blast radius", () => {
  async function tokenFor(
    args: Record<string, unknown>,
    ctx: Parameters<typeof shareFile.handler>[1],
  ): Promise<string> {
    const first = await runApproved(shareFile, args, ctx);
    if (first.ok) throw new Error("expected confirmation_required");
    const details = first.error.details as { confirmationToken?: string };
    if (typeof details?.confirmationToken !== "string") {
      throw new Error("no token minted");
    }
    return details.confirmationToken;
  }

  it("a token approved for a VIEW-ONLY link cannot mint an EDITABLE one", async () => {
    const post = vi.fn();
    const ctx = ctxWith(post);
    const token = await tokenFor({ path: "/Docs/report.md" }, ctx);
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", allow_edit: true, confirmation_token: token },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("a token approved for a PASSWORD-PROTECTED link cannot mint an open one", async () => {
    const post = vi.fn();
    const ctx = ctxWith(post);
    const token = await tokenFor(
      { path: "/Docs/report.md", password: "correct-horse" },
      ctx,
    );
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", confirmation_token: token },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("a token approved for one expiry cannot mint a longer-lived link", async () => {
    const post = vi.fn();
    const ctx = ctxWith(post);
    const token = await tokenFor(
      { path: "/Docs/report.md", expires_days: 1 },
      ctx,
    );
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", expires_days: 90, confirmation_token: token },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("a token approved for one PATH cannot share a different file", async () => {
    const post = vi.fn();
    const ctx = ctxWith(post);
    const token = await tokenFor({ path: "/Docs/report.md" }, ctx);
    const r = await runApproved(shareFile, 
      { path: "/Docs/salaries.xlsx", confirmation_token: token },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("the matching parameters DO execute, so the above are not vacuous", async () => {
    const post = vi.fn().mockResolvedValue(shareResponse());
    const ctx = ctxWith(post);
    const token = await tokenFor({ path: "/Docs/report.md" }, ctx);
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", confirmation_token: token },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("share_file", () => {
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", confirmed: true },
      ctxWith(post, { ncToken: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    if (!r.ok) expect(r.error.message).toContain("sign back in with their password");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", confirmed: true },
      ctxWith(post, { userId: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects traversal paths with INVALID_PATH before any HTTP", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/../etc/passwd", confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
    expect(post).not.toHaveBeenCalled();
  });

  for (const bad of [0, 91, 1.5, "7"]) {
    it(`rejects expires_days ${JSON.stringify(bad)} with INVALID_ARGS`, async () => {
      const post = vi.fn();
      const r = await runApproved(shareFile, 
        { path: "/Docs/report.md", expires_days: bad, confirmed: true },
        ctxWith(post),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
      expect(post).not.toHaveBeenCalled();
    });
  }

  it("rejects a too-short password WITHOUT echoing it", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: "short7!", confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(JSON.stringify(r)).not.toContain("short7!");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a too-long password WITHOUT echoing it", async () => {
    const post = vi.fn();
    const tooLong = "p".repeat(65);
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: tooLong, confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(JSON.stringify(r)).not.toContain(tooLong);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects non-boolean allow_edit with INVALID_ARGS", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", allow_edit: "yes", confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  // Tier-2, handler-enforced: the public-link footgun means NOTHING may be
  // minted before the user has seen "public", the expiry, and the password
  // state, and explicitly approved.
  it("confirmation-first: states PUBLIC + expiry + no password, zero HTTP", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, { path: "/Docs/report.md" }, ctxWith(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.message).toContain("PUBLIC");
      expect(r.error.message).toContain('"/Docs/report.md"');
      // Default 7-day expiry from the pinned clock.
      expect(r.error.message).toContain("2026-07-27");
      expect(r.error.message).toContain("NOT password-protected");
      expect(r.error.details).toMatchObject({
        type: "share_file",
        path: "/Docs/report.md",
        expiresAt: "2026-07-27",
        passwordProtected: false,
        allowEdit: false,
      });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("confirmation echo flags password protection without echoing the password", async () => {
    const post = vi.fn();
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: SECRET, expires_days: 30 },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("password-protected");
      expect(r.error.message).toContain("2026-08-19");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(post).not.toHaveBeenCalled();
  });

  it("confirmed: creates the share with the exact route, body, and NC identity headers", async () => {
    const post = vi.fn().mockResolvedValue(shareResponse());
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", confirmed: true },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledWith(
      "/share",
      {
        path: "/Docs/report.md",
        shareType: 3,
        permissions: 1, // view-only preset (read bit)
        expireDate: "2026-07-27",
      },
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
        type: "share_file",
        path: "/Docs/report.md",
        url: "https://nc.example/s/AbCdEf", // bound to the response's url field
        expiresAt: "2026-07-27",
        passwordProtected: false,
        allowEdit: false,
      });
    }
  });

  it("allow_edit maps to the file-safe edit bitmask (read|update = 3)", async () => {
    const post = vi.fn().mockResolvedValue(shareResponse({ permissions: 3 }));
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", allow_edit: true, confirmed: true },
      ctxWith(post),
    );
    expect(post).toHaveBeenCalledWith(
      "/share",
      expect.objectContaining({ permissions: 3 }),
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { allowEdit: boolean }).allowEdit).toBe(true);
  });

  it("confirmed with password: sends it to the route but NEVER echoes it back", async () => {
    const post = vi.fn().mockResolvedValue(shareResponse({ hasPassword: true }));
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: SECRET, confirmed: true },
      ctxWith(post),
    );
    // The request body must carry the password (the route hashes it)…
    expect(post).toHaveBeenCalledWith(
      "/share",
      expect.objectContaining({ password: SECRET }),
      expect.anything(),
    );
    // …but no response branch may ever contain it.
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({ passwordProtected: true });
    }
  });

  it("omits the password key entirely when none was given", async () => {
    const post = vi.fn().mockResolvedValue(shareResponse());
    await runApproved(shareFile, { path: "/Docs/report.md", confirmed: true }, ctxWith(post));
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect("password" in body).toBe(false);
  });

  it("maps 404 to NOT_FOUND", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 }),
    );
    const r = await runApproved(shareFile, 
      { path: "/gone.txt", password: SECRET, confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toContain("/gone.txt");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("passes a 400 validation error through as INVALID_SHARE", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid share request" }), { status: 400 }),
    );
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: SECRET, confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_SHARE");
      expect(r.error.message).toBe("Invalid share request");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("maps other failures to SHARE_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
    const r = await runApproved(shareFile, 
      { path: "/Docs/report.md", password: SECRET, confirmed: true },
      ctxWith(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SHARE_FAILED");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("metadata: Tier-2 write tool with confirmation", () => {
    expect(shareFile.name).toBe("share_file");
    expect(shareFile.requiresWrite).toBe(true);
    expect(shareFile.requiresConfirmation).toBe(true);
    expect(shareFile.inputSchema).toMatchObject({
      required: ["path"],
      additionalProperties: false,
    });
  });
});
