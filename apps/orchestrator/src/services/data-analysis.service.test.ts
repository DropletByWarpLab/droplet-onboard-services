import { describe, expect, it, vi } from "vitest";
vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "token", SANDBOX_TRANSFORM_TIMEOUT_MS: 1000 } }));
import { createDataAnalysisClient, readAnalysisBytes } from "./data-analysis.service.js";
const RESULT = { output: 42, stdout: "", stdoutTruncated: false, artifacts: [], sources: [], warnings: [] };
describe("analysis sandbox transport", () => {
  it("never dials an unconfigured service", async () => {
    const fetchImpl = vi.fn();
    await expect(createDataAnalysisClient({ serviceToken: "", fetchImpl }).analyze("output=1", {}, [])).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("sends only explicit analysis data with the service bearer and bounded execution controls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(RESULT)));
    expect(await createDataAnalysisClient({ fetchImpl }).analyze("output=42", {}, [])).toEqual(RESULT);
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe("http://sandbox:8030/analysis");
    expect(call[1].headers.Authorization).toBe("Bearer token");
    expect(call[1].redirect).toBe("error");
    expect(JSON.parse(call[1].body)).toEqual({ code: "output=42", inputs: {}, sources: [], timeoutMs: 1000, outputCapBytes: 1048576 });
  });
  it("caps streams even without Content-Length and cancels readers", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel });
    await expect(readAnalysisBytes(body, 10)).rejects.toThrow("exceeds 10 bytes");
    expect(cancel).toHaveBeenCalled();
  });
  it("does not await an uncooperative peer's cancellation after a byte refusal", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { return new Promise(() => {}); } });
    await expect(readAnalysisBytes(body, 10)).rejects.toThrow("exceeds 10 bytes");
  });
  it("bounds stalled body reads even when the stream ignores cancellation", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
    const reading = readAnalysisBytes(body, 10, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("relays code errors and rejects non-JSON/invalid envelopes", async () => {
    await expect(createDataAnalysisClient({ fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "ZeroDivisionError at line 1" }))) }).analyze("output=1/0", {}, [])).rejects.toThrow("ZeroDivisionError at line 1");
    await expect(createDataAnalysisClient({ fetchImpl: vi.fn().mockResolvedValue(new Response("html")) }).analyze("output=1", {}, [])).rejects.toMatchObject({ code: "UNREACHABLE" });
    await expect(createDataAnalysisClient({ fetchImpl: vi.fn().mockResolvedValue(new Response("{}")) }).analyze("output=1", {}, [])).rejects.toThrow("invalid result");
  });
});
