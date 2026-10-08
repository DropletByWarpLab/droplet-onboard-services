import { describe, expect, it, vi } from "vitest";
import officeFile from "../../../src/handlers/files/office-file.js";
import type { ToolContext } from "../../../src/types.js";
const INSPECT = { action: "inspect", source: { path: "/report.docx", filename: "report.docx" }, format: "docx", paragraphs: [{ id: "word/document.xml:p:0", text: "Original" }], returnedItems: 1, totalItems: 1, truncated: false, warnings: [] };
const REVISE = { action: "revise", source_path: "/report.docx", path: "/revised.docx", changes: { text: [{ id: "word/document.xml:p:0", text: "Revised" }] } };
const SAVED = { action: "revise", format: "docx", path: "/revised.docx", filename: "revised.docx", bytes: 4000, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", warnings: [] };
function context(body: unknown = INSPECT, status = 200) {
  const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return { post, ctx: { userId: "alice", ncToken: "token", signal: new AbortController().signal, http: { nextcloud: { post } } } as unknown as ToolContext };
}
describe("office_file", () => {
  it("defaults to inspection and carries actor headers to the visible route hop", async () => {
    const { post, ctx } = context();
    expect(await officeFile.handler({ source_path: "/report.docx" }, ctx)).toMatchObject({ ok: true, data: { action: "inspect", paragraphs: INSPECT.paragraphs, truncated: false } });
    expect(post).toHaveBeenCalledWith("/office", { action: "inspect", source_path: "/report.docx" }, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "token" }, signal: ctx.signal });
    expect(officeFile.requiresWrite).toBe(true); expect(officeFile.requiresConfirmation).toBe(false);
    expect(JSON.stringify(officeFile.inputSchema).length + officeFile.description.length).toBeLessThan(2000);
  });
  it("inspects an owned attachment without requiring a File Store connection", async () => {
    const { ctx, post } = context(); ctx.ncToken = undefined;
    expect((await officeFile.handler({ item_id: "attachment-1" }, ctx)).ok).toBe(true);
    expect(post.mock.calls[0][1]).toEqual({ action: "inspect", item_id: "attachment-1" });
  });
  it("returns a file card only after a validated save acknowledgement", async () => {
    const { post, ctx } = context(SAVED);
    expect(await officeFile.handler(REVISE, ctx)).toMatchObject({ ok: true, data: { path: "/revised.docx", media: { kind: "file", path: "/revised.docx", size: 4000 } } });
    expect(post.mock.calls[0][1]).toEqual(REVISE);
  });
  it.each([{ action: "other", source_path: "/report.docx" }, {}, { source_path: "/report.docx", item_id: "attachment" }, { source_path: "/../report.docx" }, { source_path: "/%252e%252e/report.docx" }, { source_path: "/report.pdf" }, { item_id: "../../etc" }, { source_path: "/report.docx", changes: {} }, { ...REVISE, path: "/report.docx" }, { ...REVISE, path: "/revised.pptx" }, { ...REVISE, path: "/Dept/revised.docx" }, { ...REVISE, path: "/%2fhidden.docx" }, { ...REVISE, changes: { text: [] } }, { ...REVISE, changes: { text: [{}], cells: [{}] } }, { ...REVISE, changes: { network: true } }])("refuses invalid source/destination/action before I/O %j", async (input) => {
    const { post, ctx } = context(); expect((await officeFile.handler(input, ctx)).ok).toBe(false); expect(post).not.toHaveBeenCalled();
  });
  it("requires signed-in identity and credentials for File Store reads/writes", async () => {
    const { post, ctx } = context(); ctx.userId = undefined;
    expect(await officeFile.handler({ item_id: "attachment-1" }, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    ctx.userId = "alice"; ctx.ncToken = undefined;
    expect((await officeFile.handler(REVISE, ctx)).ok).toBe(false); expect(post).not.toHaveBeenCalled();
  });
  it.each([[409, "ALREADY_EXISTS"], [400, "INVALID_FILE"], [404, "NOT_FOUND"], [429, "OFFICE_BUSY"], [408, "TIMEOUT"], [413, "TOO_LARGE"], [503, "OFFICE_UNAVAILABLE"]])("preserves actionable refusal %s", async (status, code) => {
    const { ctx } = context({ error: "Readable reason" }, status as number);
    expect(await officeFile.handler(REVISE, ctx)).toMatchObject({ ok: false, error: { code, message: "Readable reason" } });
  });
  it.each([{ path: "/victim.docx" }, { format: "xlsx" }, { bytes: 0 }, { bytes: 11 * 1024 * 1024 }, { filename: "wrong.docx" }, { mimeType: "text/html" }])("refuses forged save metadata %j", async (bad) => {
    const { ctx } = context({ ...SAVED, ...bad }); expect((await officeFile.handler(REVISE, ctx)).ok).toBe(false);
  });
  it("does not pass through peer-supplied media on an inspection", async () => {
    const { ctx } = context({ ...INSPECT, media: { path: "/victim.html" } });
    expect(await officeFile.handler({ source_path: "/report.docx" }, ctx)).not.toHaveProperty("data.media");
  });
});
