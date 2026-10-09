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
import createSlideDeck from "../../../src/handlers/files/create-slide-deck.js";
import { parseChatMedia } from "@droplet/shared-types";
import type { ToolContext } from "../../../src/types.js";

function makeCtx(response: { ok: boolean; status: number; data?: unknown }) {
  const post = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(response.data ?? {}), { status: response.status, headers: { "content-type": "application/json" } })));
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
      media: {
        kind: "file",
        path: "/Documents/q3.pdf",
        downloadUrl: "/api/files/download?path=%2FDocuments%2Fq3.pdf",
      },
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

  it("preserves uncertainty when the route times out during a save", async () => {
    const { ctx } = makeCtx({ ok: false, status: 408, data: {} });
    const result = await createSlideDeck.handler({ path: "/deck.pptx", title: "Review", slides: [{ title: "Results", bullets: ["Hello"] }], both: true }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN", message: expect.stringContaining("before retrying") } });
    expect(parseChatMedia(result)).toEqual([]);
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
    const sheets = [{ name: "Q3", columns: ["Region", "Total"], rows: [["West", 2], ["East", 3], ["Total", null]],
      formulas: [{ cell: "B4", expression: "SUM(B2:B3)" }],
      chart: { kind: "bar", category_column: 1, value_column: 2 },
    }];
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

describe("create_slide_deck", () => {
  const slides = [{ title: "Results", bullets: ["Revenue grew", "Costs fell"] }];

  it.each(["pdf", "pptx"])("dispatches %s with the caller credentials and returns a file card", async (format) => {
    const path = `/Documents/deck.${format}`;
    const mimeType = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const { ctx, post } = makeCtx({ ...OK, data: { ...OK.data, path, filename: `deck.${format}`, mimeType } });
    const res = await createSlideDeck.handler({ path, title: "Review", slides }, ctx);
    expect(post).toHaveBeenCalledWith("/render", { path, format, title: "Review", slides }, {
      headers: { "X-Nextcloud-Token": "nc-token", "X-Nextcloud-User": "alice" },
    });
    expect(res.ok && res.data).toMatchObject({ path, mimeType, media: { kind: "file", path, mimeType } });
  });

  it("rejects empty decks, mismatched filenames and unauthenticated writes before dispatch", async () => {
    const { ctx, post } = makeCtx(OK);
    for (const args of [
      { path: "/a.pdf", title: "Review", slides: [] },
      { path: "/a.txt", title: "Review", slides },
    ]) expect((await createSlideDeck.handler(args, ctx)).ok).toBe(false);
    const unauthenticated = { ...ctx, ncToken: undefined };
    expect(await createSlideDeck.handler({ path: "/a.pptx", title: "Review", slides }, unauthenticated))
      .toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("returns no deliverable on a failed write", async () => {
    const { ctx } = makeCtx({ ok: false, status: 409, data: { path: "/a.pptx" } });
    expect(await createSlideDeck.handler({ path: "/a.pptx", title: "Review", slides }, ctx))
      .toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS" } });
  });

  const ack = (path: string) => new Response(JSON.stringify({ path, filename: path.split("/").pop(), bytes: 2048, mimeType: path.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), { status: 200 });

  it.each(["pdf", "pptx"])("exports both formats from a %s destination with two acknowledged cards", async (format) => {
    const other = format === "pdf" ? "pptx" : "pdf";
    const path = `/Documents/deck.${format}`;
    const { ctx, post } = makeCtx(OK);
    post.mockReset().mockResolvedValueOnce(ack(path)).mockResolvedValueOnce(ack(`/Documents/deck.${other}`));
    const imageSlides = [{ title: "Photo", image: { path: "/Photos/product.png", caption: "Product" } }];
    const result = await createSlideDeck.handler({ path, both: true, title: "Review", slides: imageSlides, theme: "dark" }, ctx);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(["/render", { path: `/Documents/deck.${other}`, format: other, title: "Review", slides: imageSlides, theme: "dark" }, expect.objectContaining({ headers: { "X-Nextcloud-Token": "nc-token", "X-Nextcloud-User": "alice" }, signal: expect.any(AbortSignal) })]);
    expect(result).toMatchObject({ ok: true, data: { complete: true, exportErrors: [], artifacts: [{ path }, { path: `/Documents/deck.${other}` }] } });
    expect(result.ok && parseChatMedia(result.data).map((item) => item.kind === "file" ? item.path : undefined)).toEqual([path, `/Documents/deck.${other}`]);
  });

  it("keeps a confirmed primary card when the companion already exists", async () => {
    const { ctx, post } = makeCtx(OK);
    post.mockReset().mockResolvedValueOnce(ack("/deck.pptx")).mockResolvedValueOnce(new Response(JSON.stringify({ path: "/deck.pdf" }), { status: 409 }));
    const result = await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx);
    expect(result).toMatchObject({ ok: true, data: { complete: false, artifacts: [{ path: "/deck.pptx" }], exportErrors: [{ path: "/deck.pdf", code: "ALREADY_EXISTS" }] } });
    expect(result.ok && parseChatMedia(result.data)).toHaveLength(1);
  });

  it("reports an unknown companion outcome without dropping the confirmed primary", async () => {
    const { ctx, post } = makeCtx(OK);
    post.mockReset().mockResolvedValueOnce(ack("/deck.pptx")).mockRejectedValueOnce(new Error("private token and transport details"));
    const result = await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx);
    expect(result).toMatchObject({ ok: true, data: { complete: false, artifacts: [{ path: "/deck.pptx" }], exportErrors: [{ code: "OUTCOME_UNKNOWN" }] } });
    expect(JSON.stringify(result)).not.toContain("private token");
  });

  it("does not start a companion after cancellation or a failed primary", async () => {
    const { ctx, post } = makeCtx(OK);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    post.mockImplementationOnce(() => { controller.abort(); return Promise.resolve(ack("/deck.pptx")); });
    expect(await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx)).toMatchObject({ ok: true, data: { complete: false, exportErrors: [{ code: "CANCELLED" }] } });
    expect(post).toHaveBeenCalledTimes(1);
    const failed = makeCtx({ ok: false, status: 409 });
    expect((await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, failed.ctx)).ok).toBe(false);
    expect(failed.post).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "response-body"])("bounds a non-cooperating companion %s and returns the saved primary", async (hang) => {
    vi.useFakeTimers();
    try {
      const { ctx, post } = makeCtx(OK);
      post.mockReset().mockResolvedValueOnce(ack("/deck.pptx"));
      if (hang === "transport") post.mockImplementationOnce(() => new Promise(() => {}));
      else post.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(() => {}) });
      const pending = createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx);
      await vi.advanceTimersByTimeAsync(55_001);
      const result = await pending;
      expect(result).toMatchObject({ ok: true, data: { complete: false, artifacts: [{ path: "/deck.pptx" }], exportErrors: [{ code: "OUTCOME_UNKNOWN" }] } });
      expect(post.mock.calls[1][2].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["transport", "response-body"])("bounds an unacknowledged primary %s without inventing a file or starting a companion", async (hang) => {
    vi.useFakeTimers();
    try {
      const { ctx, post } = makeCtx(OK);
      if (hang === "transport") post.mockImplementation(() => new Promise(() => {}));
      else post.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
      const pending = createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx);
      await vi.advanceTimersByTimeAsync(55_001);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
      expect(parseChatMedia(result)).toEqual([]);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][2].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not dispatch an already cancelled export", async () => {
    const { ctx, post } = makeCtx(OK);
    ctx.signal = AbortSignal.abort();
    expect(await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx)).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("does not repeat a write when acknowledged metadata has an unexpected extension", async () => {
    const { ctx, post } = makeCtx(OK);
    post.mockResolvedValueOnce(ack("/deck.txt"));
    expect(await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx)).toMatchObject({ ok: true, data: { complete: false, artifacts: [{ path: "/deck.txt" }], exportErrors: [{ code: "RENDER_FAILED" }] } });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: "/../escape.pptx" }, { path: "relative.pptx" }, { bytes: -1 }, { bytes: 0 }, { filename: "" },
  ])("does not fabricate a primary card from malformed storage metadata", async (invalid) => {
    const { ctx, post } = makeCtx({ ...OK, data: { ...OK.data, path: "/deck.pptx", filename: "deck.pptx", ...invalid } });
    expect(await createSlideDeck.handler({ path: "/deck.pptx", both: true, title: "Review", slides }, ctx)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED" } });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
