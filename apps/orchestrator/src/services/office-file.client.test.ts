import { describe, expect, it, vi } from "vitest";
import { createOfficeFileClient, readOfficeBytes, OFFICE_MIME, OfficeFileError } from "./office-file.client.js";
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100)]);
const INSPECT = { format: "docx", paragraphs: [{ id: "word/document.xml:p:0", text: "Hello" }], totalItems: 1, returnedItems: 1, truncated: false, warnings: [] };
function client(response: Response, options: { timeoutMs?: number } = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  return { fetchImpl, api: createOfficeFileClient({ fetchImpl, baseUrl: "http://doc-render:8020/", serviceToken: "service-token", ...options }) };
}
describe("offline Office client", () => {
  it("sends only OOXML bytes, format and operations using the local service bearer", async () => {
    const { api, fetchImpl } = client(new Response(JSON.stringify(INSPECT), { headers: { "content-type": "application/json" } }));
    expect(await api.inspect(ZIP, "docx")).toEqual(INSPECT);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://doc-render:8020/office");
    expect(options.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer service-token" });
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body)).toEqual({ action: "inspect", format: "docx", content_base64: ZIP.toString("base64") });
    expect(JSON.stringify(options)).not.toContain("nextcloud");
  });
  it("returns revised bytes only with the expected MIME and OOXML signature", async () => {
    const { api, fetchImpl } = client(new Response(ZIP, { headers: { "content-type": OFFICE_MIME.docx } }));
    const changes = { text: [{ id: "word/document.xml:p:0", text: "Updated" }] };
    expect(await api.revise(ZIP, "docx", changes)).toEqual(ZIP);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).changes).toEqual(changes);
  });
  it.each([{}, { ...INSPECT, format: "pptx" }, { ...INSPECT, returnedItems: 201 }, { ...INSPECT, paragraphs: [{ id: 1, text: "bad" }] }, { ...INSPECT, paragraphs: [{ id: "p", text: "x".repeat(4001) }] }])("refuses malformed inspections %j", async (result) => {
    const { api } = client(new Response(JSON.stringify(result))); await expect(api.inspect(ZIP, "docx")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("validates XLSX cell values and declared returned counts", async () => {
    const result = { ...INSPECT, format: "xlsx", paragraphs: undefined, sheets: [{ name: "Sheet1", cellCount: 1, cells: [{ sheet: "Sheet1", cell: "A1", value: 2 }] }] };
    const { api } = client(new Response(JSON.stringify(result))); expect((await api.inspect(ZIP, "xlsx")).returnedItems).toBe(1);
    const invalid = client(new Response(JSON.stringify({ ...result, returnedItems: 0 }))).api;
    await expect(invalid.inspect(ZIP, "xlsx")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it.each([new Response(ZIP, { headers: { "content-type": "text/html" } }), new Response("not Office", { headers: { "content-type": OFFICE_MIME.docx } })])("refuses wrong file type/signature", async (response) => {
    await expect(client(response).api.revise(ZIP, "docx", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("preserves bounded validation reasons and suppresses server dumps", async () => {
    await expect(client(new Response('{"detail":"Macros are unsupported"}', { status: 400 })).api.inspect(ZIP, "docx")).rejects.toMatchObject({ code: "INVALID_FILE", message: "Macros are unsupported" });
    await expect(client(new Response("Traceback: SECRET", { status: 500 })).api.inspect(ZIP, "docx")).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Local Office processing is unavailable." });
  });
  it("fails closed without configured local authentication", async () => {
    const fetchImpl = vi.fn(); const api = createOfficeFileClient({ serviceToken: "", fetchImpl });
    await expect(api.inspect(ZIP, "docx")).rejects.toMatchObject({ code: "UNAVAILABLE" }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds streamed input even when Content-Length lies", async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.enqueue(new Uint8Array(10)); c.close(); } }), { headers: { "content-length": "1" } });
    await expect(readOfficeBytes(response.body, 15)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("propagates caller cancellation and rejects a cancelled read", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readOfficeBytes(new Response(ZIP).body, 1000, controller.signal)).rejects.toBeInstanceOf(OfficeFileError);
    const fetchImpl = vi.fn().mockImplementation((_url, options) => { expect(options.signal.aborted).toBe(true); return Promise.reject(new Error("aborted")); });
    await expect(createOfficeFileClient({ serviceToken: "test", fetchImpl }).inspect(ZIP, "docx", controller.signal)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("does not hang on a peer whose read and cancel never settle", async () => {
    const controller = new AbortController();
    const releaseLock = vi.fn();
    const body = { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock }) } as unknown as ReadableStream<Uint8Array>;
    const pending = readOfficeBytes(body, 1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" }); expect(releaseLock).toHaveBeenCalled();
  });
  it("settles its deadline even if the fetch implementation ignores abort", async () => {
    const api = createOfficeFileClient({ serviceToken: "test", timeoutMs: 10, fetchImpl: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await expect(api.inspect(ZIP, "docx")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
