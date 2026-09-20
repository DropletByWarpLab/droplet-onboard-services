// WARP-1458 — create_document: new empty Word (.docx) / spreadsheet (.xlsx)
// seeded from embedded OOXML templates, written through the same
// /api/files upload contract as write_file, with a pre-write existence
// probe (GET /download) so an existing file is never clobbered.
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { createHash } from "node:crypto";
import createDocument, {
  DOCX_TEMPLATE_BASE64,
  XLSX_TEMPLATE_BASE64,
} from "../../../src/handlers/files/create-document.js";
import type { ToolContext } from "../../../src/types.js";

const ncToken = "test-token";
const userId = "alice";

interface CtxOpts {
  userId?: string;
  ncToken?: string;
  ncGet?: Mock;
  ncPost?: Mock;
}

function makeCtx(opts: CtxOpts = {}) {
  // Default: probe says "not found" (404), upload succeeds — the happy path.
  const ncGet =
    opts.ncGet ?? vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
  const ncPost =
    opts.ncPost ?? vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const ctx: ToolContext = {
    prisma: {} as ToolContext["prisma"],
    http: {
      nextcloud: { get: ncGet, post: ncPost, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    matter: {} as ToolContext["matter"],
    userId: opts.userId === undefined ? userId : opts.userId,
    ncToken: opts.ncToken === undefined ? ncToken : opts.ncToken,
    signal: new AbortController().signal,
  };
  return { ctx, ncGet, ncPost };
}

const expectedHeaders = expect.objectContaining({
  headers: expect.objectContaining({
    "X-Nextcloud-Token": ncToken,
    "X-Nextcloud-User": userId,
  }),
});

// ── ZIP structure checks (pure Buffer, no deps) ─────────────────────────
//
// A stored-entry zip starts with a local-file-header signature and ends
// with the 22-byte end-of-central-directory record (no archive comment in
// our deterministic templates). Entry names are read out of the central
// directory, not the local headers, because the central directory is what
// unzip implementations treat as authoritative.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function readCentralDirectoryNames(zip: Buffer): string[] {
  // EOCD is the last 22 bytes (comment length 0 in our templates).
  const eocdOffset = zip.length - 22;
  expect(zip.readUInt32LE(eocdOffset)).toBe(EOCD_SIG);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const names: string[] = [];
  let off = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(zip.readUInt32LE(off)).toBe(CENTRAL_SIG);
    const method = zip.readUInt16LE(off + 10);
    expect(method).toBe(0); // stored (no compression) — deterministic bytes
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    names.push(zip.subarray(off + 46, off + 46 + nameLen).toString("ascii"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

describe("create_document — embedded OOXML templates", () => {
  it("docx template is a valid stored-entry zip with the Word parts", () => {
    const zip = Buffer.from(DOCX_TEMPLATE_BASE64, "base64");
    expect(zip.readUInt32LE(0)).toBe(LOCAL_SIG);
    const names = readCentralDirectoryNames(zip);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("word/document.xml");
  });

  it("xlsx template is a valid stored-entry zip with the workbook parts", () => {
    const zip = Buffer.from(XLSX_TEMPLATE_BASE64, "base64");
    expect(zip.readUInt32LE(0)).toBe(LOCAL_SIG);
    const names = readCentralDirectoryNames(zip);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/_rels/workbook.xml.rels");
    expect(names).toContain("xl/worksheets/sheet1.xml");
  });

  // Byte-stability pins: the templates are finished artifacts, not built at
  // runtime. Any edit to the constants must be a deliberate regeneration
  // (see the generation comment in the handler) and must update these pins.
  it("template constants are byte-stable (sha256 pins)", () => {
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    expect(sha(DOCX_TEMPLATE_BASE64)).toBe(
      "37f693e65b46f730d20f126bec596c263a14cd0ef2713f207637c1811be114b5",
    );
    expect(sha(XLSX_TEMPLATE_BASE64)).toBe(
      "7ecac043e303b206c384bb2b9f97d85c764f57849f7de23adb0359e518ee690e",
    );
  });
});

describe("create_document — happy paths", () => {
  it("creates a .docx: probes /download, uploads the docx seed", async () => {
    const { ctx, ncGet, ncPost } = makeCtx();
    const res = await createDocument.handler(
      { path: "/Docs/report.docx" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "create_document",
        path: "/Docs/report.docx",
        kind: "docx",
        created: true,
      });
    }
    expect(ncGet).toHaveBeenCalledWith(
      `/download?path=${encodeURIComponent("/Docs/report.docx")}`,
      expectedHeaders,
    );
    expect(ncPost).toHaveBeenCalledWith(
      "/upload",
      {
        dir: "/Docs",
        filename: "report.docx",
        contentBase64: DOCX_TEMPLATE_BASE64,
      },
      expectedHeaders,
    );
  });

  it("creates an .xlsx at the root: dir '/' and the xlsx seed", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await createDocument.handler({ path: "/budget.xlsx" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "create_document",
        path: "/budget.xlsx",
        kind: "xlsx",
        created: true,
      });
    }
    expect(ncPost).toHaveBeenCalledWith(
      "/upload",
      {
        dir: "/",
        filename: "budget.xlsx",
        contentBase64: XLSX_TEMPLATE_BASE64,
      },
      expectedHeaders,
    );
  });

  it("normalizes a relative-looking path by prepending '/'", async () => {
    const { ctx } = makeCtx();
    const res = await createDocument.handler({ path: "Notes/todo.docx" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { path: string }).path).toBe("/Notes/todo.docx");
    }
  });
});

describe("create_document — kind inference and validation", () => {
  it("accepts a matching explicit kind", async () => {
    const { ctx } = makeCtx();
    const res = await createDocument.handler(
      { path: "/a.xlsx", kind: "xlsx" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { kind: string }).kind).toBe("xlsx");
  });

  it("accepts an uppercase extension and infers the lowercase kind", async () => {
    const { ctx } = makeCtx();
    const res = await createDocument.handler({ path: "/REPORT.DOCX" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { kind: string }).kind).toBe("docx");
  });

  it("rejects a kind/extension mismatch with INVALID_ARGS, no calls", async () => {
    const { ctx, ncGet, ncPost } = makeCtx();
    const res = await createDocument.handler(
      { path: "/a.docx", kind: "xlsx" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(ncGet).not.toHaveBeenCalled();
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind value", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await createDocument.handler(
      { path: "/a.docx", kind: "pdf" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(ncPost).not.toHaveBeenCalled();
  });

  for (const bad of ["/notes.txt", "/archive.zip", "/plain", "/dir.docx/x"]) {
    it(`rejects unsupported extension ${JSON.stringify(bad)}`, async () => {
      const { ctx, ncGet, ncPost } = makeCtx();
      const res = await createDocument.handler({ path: bad }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
      expect(ncGet).not.toHaveBeenCalled();
      expect(ncPost).not.toHaveBeenCalled();
    });
  }

  it("rejects the bare root path", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await createDocument.handler({ path: "/" }, ctx);
    expect(res.ok).toBe(false);
    expect(ncPost).not.toHaveBeenCalled();
  });

  for (const bad of ["/../etc/x.docx", "/Notes/%2e%2e/x.docx", "/foo\0.docx"]) {
    it(`rejects malformed path ${JSON.stringify(bad)}`, async () => {
      const { ctx, ncGet, ncPost } = makeCtx();
      const res = await createDocument.handler({ path: bad }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PATH");
      expect(ncGet).not.toHaveBeenCalled();
      expect(ncPost).not.toHaveBeenCalled();
    });
  }
});

describe("create_document — overwrite protection", () => {
  it("returns FILE_EXISTS without writing when the probe finds the file", async () => {
    const ncGet = vi.fn().mockResolvedValue(new Response("bytes", { status: 200 }));
    const { ctx, ncPost } = makeCtx({ ncGet });
    const res = await createDocument.handler({ path: "/Docs/report.docx" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FILE_EXISTS");
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("fails closed (no write) when the probe errors with a non-404", async () => {
    const ncGet = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const { ctx, ncPost } = makeCtx({ ncGet });
    const res = await createDocument.handler({ path: "/Docs/report.docx" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("WRITE_FAILED");
      expect(res.error.message).toMatch(/pre-check.*500/);
    }
    expect(ncPost).not.toHaveBeenCalled();
  });
});

describe("create_document — auth gate", () => {
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const { ctx, ncGet, ncPost } = makeCtx({ ncToken: "" });
    const res = await createDocument.handler({ path: "/a.docx" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(ncGet).not.toHaveBeenCalled();
    expect(ncPost).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const { ctx, ncPost } = makeCtx({ userId: "" });
    const res = await createDocument.handler({ path: "/a.docx" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(ncPost).not.toHaveBeenCalled();
  });
});

describe("create_document — write failure mapping", () => {
  it("maps an upload failure to WRITE_FAILED with the upstream status", async () => {
    const ncPost = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const { ctx } = makeCtx({ ncPost });
    const res = await createDocument.handler({ path: "/a.docx" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("WRITE_FAILED");
      expect(res.error.message).toBe("nextcloud returned 502");
    }
  });
});

describe("create_document — tool metadata", () => {
  it("carries the write_file trust tier: write-intent, no confirmation", () => {
    expect(createDocument.name).toBe("create_document");
    expect(createDocument.requiresWrite).toBe(true);
    expect(createDocument.requiresConfirmation).toBe(false);
  });

  it("input schema requires path, allows only path+kind", () => {
    const schema = createDocument.inputSchema as {
      required: readonly string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["path"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["kind", "path"]);
  });

  it("description names the Files app / OnlyOffice editing surface", () => {
    expect(createDocument.description).toMatch(/OnlyOffice/);
    expect(createDocument.description).toMatch(/\.docx/);
    expect(createDocument.description).toMatch(/\.xlsx/);
  });
});
