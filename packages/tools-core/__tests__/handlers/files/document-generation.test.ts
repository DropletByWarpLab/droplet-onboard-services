/**
 * WARP-2212 — the three document-generation tools.
 *
 * What these pin, beyond "it calls the route":
 *
 *   - The extension is the caller's declared INTENT. A mismatch is refused,
 *     never corrected — writing PDF bytes under a .txt name, or renaming the
 *     user's file to suit us, is exactly the kind of guess this repo does not
 *     make.
 *   - The route's refusals reach the model with their REASON intact. A 409
 *     means "that name is taken, pick another", which the model can only act
 *     on if it is told; collapsing every failure into one opaque error is how
 *     an agent loop burns its iterations retrying the same thing.
 *   - The hop carries the caller's Nextcloud credentials, so the document
 *     lands in the caller's storage rather than a service account's.
 */
import { describe, it, expect, vi } from "vitest";
import createPdfReport from "../../../src/handlers/files/create-pdf-report.js";
import createWordDocument from "../../../src/handlers/files/create-word-document.js";
import createSpreadsheet from "../../../src/handlers/files/create-spreadsheet.js";
import type { ToolContext } from "../../../src/types.js";

function makeCtx(response: { ok: boolean; status: number; data?: unknown }) {
  const post = vi.fn().mockResolvedValue(response);
  const ctx = {
    userId: "alice",
    ncToken: "nc-token",
    http: { nextcloud: { post } },
  } as unknown as ToolContext;
  return { ctx, post };
}

const OK = {
  ok: true,
  status: 200,
  data: {
    path: "/Documents/q3.pdf",
    filename: "q3.pdf",
    bytes: 4096,
    mimeType: "application/pdf",
  },
};

describe("create_pdf_report", () => {
  it("is registered as a write tool that needs no confirmation", () => {
    // It creates a NEW file at a path the user named; the route refuses an
    // existing one, so the destructive case cannot arise.
    expect(createPdfReport.requiresWrite).toBe(true);
    expect(createPdfReport.requiresConfirmation).toBe(false);
  });

  it("sends the spec to the render route with the caller's credentials", async () => {
    const { ctx, post } = makeCtx(OK);
    const res = await createPdfReport.handler(
      { path: "/Documents/q3.pdf", title: "Q3", body_markdown: "# Hello" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/render",
      {
        path: "/Documents/q3.pdf",
        format: "pdf",
        title: "Q3",
        body_markdown: "# Hello",
      },
      { headers: { "X-Nextcloud-Token": "nc-token", "X-Nextcloud-User": "alice" } },
    );
  });

  it("returns the path and size so a caller can open the result", async () => {
    const { ctx } = makeCtx(OK);
    const res = await createPdfReport.handler(
      { path: "/Documents/q3.pdf", title: "Q3" },
      ctx,
    );
    expect(res.ok && res.data).toMatchObject({
      path: "/Documents/q3.pdf",
      filename: "q3.pdf",
      bytes: 4096,
      mimeType: "application/pdf",
    });
  });

  it("refuses a path whose extension does not match the format", async () => {
    const { ctx, post } = makeCtx(OK);
    const res = await createPdfReport.handler(
      { path: "/Documents/q3.txt", title: "Q3" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe("INVALID_ARGS");
    // And it never reached the network — the refusal is local.
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a path with no filename", async () => {
    const { ctx } = makeCtx(OK);
    const res = await createPdfReport.handler({ path: "/Documents/", title: "Q3" }, ctx);
    expect(res.ok).toBe(false);
  });

  it("requires auth before it dispatches", async () => {
    const post = vi.fn();
    const ctx = { http: { nextcloud: { post } } } as unknown as ToolContext;
    const res = await createPdfReport.handler({ path: "/a.pdf", title: "t" }, ctx);
    expect(res.ok === false && res.error.code).toBe("AUTH_REQUIRED");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("the route's refusals reach the model with their reason", () => {
  it("maps 409 to ALREADY_EXISTS and names the file", async () => {
    const { ctx } = makeCtx({
      ok: false,
      status: 409,
      data: { error: "file already exists", path: "/Documents/q3.pdf" },
    });
    const res = await createPdfReport.handler(
      { path: "/Documents/q3.pdf", title: "Q3" },
      ctx,
    );
    expect(res.ok === false && res.error.code).toBe("ALREADY_EXISTS");
    expect(res.ok === false && res.error.message).toContain("/Documents/q3.pdf");
  });

  it("passes a 400 spec rejection through verbatim", async () => {
    const { ctx } = makeCtx({
      ok: false,
      status: 400,
      data: { error: "too many sheets (max 24)" },
    });
    const res = await createSpreadsheet.handler(
      { path: "/a.xlsx", sheets: [{ columns: ["A"], rows: [] }] },
      ctx,
    );
    expect(res.ok === false && res.error.message).toBe("too many sheets (max 24)");
  });

  it("maps 413 to TOO_LARGE", async () => {
    const { ctx } = makeCtx({ ok: false, status: 413, data: {} });
    const res = await createPdfReport.handler({ path: "/a.pdf", title: "t" }, ctx);
    expect(res.ok === false && res.error.code).toBe("TOO_LARGE");
  });

  it("maps 502 to a renderer-unavailable error, not a spec error", async () => {
    const { ctx } = makeCtx({ ok: false, status: 502, data: {} });
    const res = await createPdfReport.handler({ path: "/a.pdf", title: "t" }, ctx);
    expect(res.ok === false && res.error.code).toBe("RENDERER_UNAVAILABLE");
  });
});

describe("create_word_document", () => {
  it("sends format docx", async () => {
    const { ctx, post } = makeCtx({ ...OK, data: { ...OK.data, filename: "q3.docx" } });
    await createWordDocument.handler(
      { path: "/Documents/q3.docx", title: "Q3", body_markdown: "body" },
      ctx,
    );
    expect(post.mock.calls[0][1]).toMatchObject({ format: "docx" });
  });

  it("refuses a .pdf path", async () => {
    const { ctx } = makeCtx(OK);
    const res = await createWordDocument.handler({ path: "/a.pdf", title: "t" }, ctx);
    expect(res.ok === false && res.error.code).toBe("INVALID_ARGS");
  });
});

describe("create_spreadsheet", () => {
  it("sends the sheets array as the spec", async () => {
    const sheets = [{ name: "Q3", columns: ["Region"], rows: [["West"]] }];
    const { ctx, post } = makeCtx({ ...OK, data: { ...OK.data, filename: "q3.xlsx" } });
    await createSpreadsheet.handler({ path: "/Documents/q3.xlsx", sheets }, ctx);
    expect(post.mock.calls[0][1]).toMatchObject({ format: "xlsx", sheets });
  });

  it("refuses an empty sheets array before dispatching", async () => {
    const { ctx, post } = makeCtx(OK);
    const res = await createSpreadsheet.handler({ path: "/a.xlsx", sheets: [] }, ctx);
    expect(res.ok === false && res.error.code).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a .xls path — the renderer writes OOXML, not the legacy format", async () => {
    const { ctx } = makeCtx(OK);
    const res = await createSpreadsheet.handler(
      { path: "/a.xls", sheets: [{ columns: ["A"], rows: [] }] },
      ctx,
    );
    expect(res.ok === false && res.error.code).toBe("INVALID_ARGS");
  });
});
