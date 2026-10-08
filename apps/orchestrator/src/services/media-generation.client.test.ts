import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createMediaGenerationClient, MediaGenerationError, readMediaBytes, type MediaSpec } from "./media-generation.client.js";

vi.mock("../config.js", () => ({ config: { MEDIA_GEN_URL: "http://media-gen:8040", MEDIA_GEN_SERVICE_TOKEN: "service-token" } }));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const spec: MediaSpec = { kind: "image", prompt: "private prompt", width: 768, height: 768, steps: 20, seed: 123 };
const response = (body: BodyInit = png, headers: Record<string, string> = {}) => new Response(body, { headers: { "Content-Type": "image/png", "X-Media-Seed": "123", "X-Media-Engine": "sdxl", ...headers } });
afterEach(() => vi.restoreAllMocks());

describe("offline media client", () => {
  it("sends only the local spec and bearer over the internal client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const client = createMediaGenerationClient({ fetchImpl });
    const result = await client.render(spec, new AbortController().signal);
    expect(result).toMatchObject({ bytes: png, seed: 123, engine: "sdxl", mimeType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledWith("http://media-gen:8040/render", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer service-token", "Content-Type": "application/json" }, body: JSON.stringify(spec), redirect: "error" }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty("token");
  });
  it("fails closed without a bearer", async () => {
    const fetchImpl = vi.fn();
    await expect(createMediaGenerationClient({ token: "", fetchImpl }).capabilities()).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["not-json", "null", "[]", '{"image":"true","video":false}', '{"image":true}'])("refuses invalid native capability body %s", async (body) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));
    await expect(createMediaGenerationClient({ fetchImpl }).capabilities()).rejects.toBeInstanceOf(MediaGenerationError);
  });
  it("accepts explicit configured booleans", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"image":true,"video":false,"inferenceVerified":false}'));
    expect(await createMediaGenerationClient({ fetchImpl }).capabilities()).toEqual({ image: true, video: false });
    expect(fetchImpl).toHaveBeenCalledWith("http://media-gen:8040/capabilities", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("bounds capabilities and conceals raw transport/model diagnostics", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("x".repeat(8193))).mockRejectedValueOnce(new Error("private prompt credential"));
    const client = createMediaGenerationClient({ fetchImpl });
    await expect(client.capabilities()).rejects.toMatchObject({ status: 413 });
    await expect(client.render(spec, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Local media generation failed or exceeded its deadline." });
  });
  it.each<Record<string, string>>([{}, { "X-Media-Seed": "NaN" }, { "X-Media-Seed": "124" }, { "X-Media-Seed": "2147483648" }, { "X-Media-Engine": "wan" }])("refuses missing or mismatched metadata %j", async (headers) => {
    const res = response(png, headers);
    if (Object.keys(headers).length === 0) res.headers.delete("X-Media-Seed");
    await expect(createMediaGenerationClient({ fetchImpl: vi.fn().mockResolvedValue(res) }).render(spec, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
  it.each([response("bad PNG"), response(png, { "Content-Type": "text/html" })])("refuses wrong output bytes/MIME", async (res) => {
    await expect(createMediaGenerationClient({ fetchImpl: vi.fn().mockResolvedValue(res) }).render(spec, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
  it("checks native MP4 signature and video engine", async () => {
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
    const fetchImpl = vi.fn().mockResolvedValue(response(bytes, { "Content-Type": "video/mp4", "X-Media-Engine": "wan" }));
    expect(await createMediaGenerationClient({ fetchImpl }).render({ ...spec, kind: "video", frames: 17, fps: 16 }, new AbortController().signal)).toMatchObject({ bytes, mimeType: "video/mp4", engine: "wan" });
  });
  it("does not echo backend error bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("private prompt credential", { status: 503 }));
    await expect(createMediaGenerationClient({ fetchImpl }).render(spec, new AbortController().signal)).rejects.toMatchObject({ code: "GENERATION_FAILED", message: "Local media generation failed or exceeded its deadline." });
  });
  it("refuses actual HTTP redirects rather than forwarding specs or credentials to another endpoint", async () => {
    let sinkRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === "/sink") { sinkRequests++; res.writeHead(200); res.end("untrusted destination"); return; }
      res.writeHead(307, { Location: "/sink" }); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no address");
    try {
      const client = createMediaGenerationClient({ baseUrl: `http://127.0.0.1:${address.port}`, fetchImpl: fetch });
      await expect(client.capabilities()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(client.render(spec, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(sinkRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("preserves deadline failure without relaying transport diagnostics", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("private prompt aborted transport"));
    await expect(createMediaGenerationClient({ fetchImpl }).render(spec, controller.signal)).rejects.toMatchObject({ code: "TIMEOUT", status: 408, message: "Local media generation failed or exceeded its deadline." });
  });
  it("caps actual streamed bytes even with a lying Content-Length", async () => {
    await expect(readMediaBytes(new Response(new Uint8Array(9), { headers: { "Content-Length": "1" } }).body, 8)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("aborts a hanging stream and returns even when its cancellation callback hangs", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) });
    const pending = readMediaBytes(stream, 1024, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
