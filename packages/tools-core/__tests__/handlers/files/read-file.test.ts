import { describe, it, expect, vi } from "vitest";
import readFile from "../../../src/handlers/files/read-file.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  get: ReturnType<typeof vi.fn>,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    // Default to an authenticated session so the happy-path tests
    // exercise the read; auth-gate tests override these explicitly.
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "tok" : opts.ncToken,
    signal: new AbortController().signal,
  };
}

describe("read_file", () => {
  it("rejects missing path", async () => {
    const get = vi.fn();
    const r = await readFile.handler({}, ctxWith(get));
    expect(r.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  // TOOLS-03: must require an authenticated Nextcloud session, like the
  // write file-tools do.
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const get = vi.fn();
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get, { ncToken: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    // The message is the model's only recovery signal: it must say HOW to
    // fix the state (password re-login re-provisions the file credential),
    // not read as a permissions refusal the model apologizes for.
    if (!r.ok) expect(r.error.message).toContain("sign back in with their password");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const get = vi.fn();
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get, { userId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  // TOOLS-03: traversal must be rejected at the tool boundary (the same
  // validateNcPath the write tools run), before any HTTP call.
  for (const bad of [
    "/../etc/passwd",
    "/foo/../../bar",
    "/foo\0bar",
    "",
    "/Notes/%2e%2e/admin/x",
    "/Notes/%252e%252e/admin/x",
    "/Notes/..\\admin",
    "/Notes/%zz",
  ]) {
    it(`rejects malformed path ${JSON.stringify(bad)} with INVALID_PATH`, async () => {
      const get = vi.fn();
      const r = await readFile.handler({ path: bad }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
      expect(get).not.toHaveBeenCalled();
    });
  }

  it("attaches the Nextcloud auth headers on the download call", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/download?path=${encodeURIComponent("/notes/x.txt")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
  });

  it("returns text content for text/* responses", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("hello world", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ path: "/notes/x.txt", content: "hello world" });
  });

  it("caps text at 10,000 characters", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("a".repeat(20000), { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const r = await readFile.handler({ path: "/big.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { content: string }).content.length).toBe(10000);
  });

  it("flags binary content types", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(" ", { status: 200, headers: { "content-type": "image/png" } }),
    );
    const r = await readFile.handler({ path: "/p.png" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { error: string }).error).toMatch(/Binary/);
  });

  it("error on 404", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const r = await readFile.handler({ path: "/missing" }, ctxWith(get));
    expect(r.ok).toBe(false);
  });
});

// ── WARP-1372: the download proxy reports application/octet-stream for
// plainly-readable files (md/csv/txt on the staging box), and the
// header-only gate refused every one — killing the search→read→answer
// path (~12/36 staging eval rows per run). The handler must sniff
// undeclared content like the file-indexer's watcher does (WARP-1139)
// instead of trusting the header.
describe("read_file — octet-stream sniffing (WARP-1372)", () => {
  it("reads a UTF-8 text file reported as application/octet-stream", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("# Home maintenance log\n\nBoiler serviced 10/02/2026.", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/Home/log.md" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.error).toBeUndefined();
      expect(data.content).toContain("Boiler serviced");
    }
  });

  it("tolerates a multibyte char split at the sniff boundary", async () => {
    // 4095 ASCII bytes + 'é' (2 bytes) puts the second byte of the char
    // exactly past a 4096-byte sniff head — a truncated char is not
    // evidence of binary content (same rule as watcher.py's sniffer).
    const body = "a".repeat(4095) + "é — fin";
    const get = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/notes/long.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.error).toBeUndefined();
      expect(data.content).toContain("fin");
    }
  });

  it("still refuses genuine binary content with the explanatory note", async () => {
    // PNG-ish header: NUL and high bytes that are not valid UTF-8.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    const get = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/photo.png" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.content).toBeUndefined();
      expect(data.error).toContain("Binary file");
    }
  });
});
