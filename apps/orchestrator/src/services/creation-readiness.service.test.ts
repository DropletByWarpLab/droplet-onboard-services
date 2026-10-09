import { describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { probeCreationService, probeCreationSpeech } from "./creation-readiness.service.js";

describe("bounded local readiness probes", () => {
  it("does not dial a service whose credential is absent", async () => {
    const fetcher = vi.fn();
    expect(await probeCreationService("http://doc-render:8020", "", AbortSignal.timeout(100), fetcher)).toEqual({ state: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses a metadata GET, bearer and no redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"version":1,"formats":["pdf"],"office":true}'));
    expect(await probeCreationService("http://doc-render:8020/", "token", AbortSignal.timeout(100), fetcher)).toMatchObject({ state: "ready" });
    expect(fetcher).toHaveBeenCalledWith("http://doc-render:8020/capabilities", expect.objectContaining({ headers: { Authorization: "Bearer token" }, redirect: "error" }));
    expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  });
  it.each([new Response("[]"), new Response("x".repeat(8193)), new Response("secret private path", { status: 503 })])("discards invalid/oversized/upstream-error data", async (response) => {
    expect(await probeCreationService("http://doc-render:8020", "token", AbortSignal.timeout(100), vi.fn().mockResolvedValue(response))).toEqual({ state: "offline" });
  });
  it("bounds fetch and body peers that ignore abort/cancel", async () => {
    const started = Date.now();
    expect(await probeCreationService("http://sandbox:8030", "token", AbortSignal.timeout(20), vi.fn(() => new Promise<Response>(() => {})))).toEqual({ state: "offline" });
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
    expect(await probeCreationService("http://sandbox:8030", "token", AbortSignal.timeout(20), vi.fn().mockResolvedValue(new Response(body)))).toEqual({ state: "offline" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it.each([false, true])("speaks only Wyoming describe and accepts fragmented v1/v2 metadata (v2=%s)", async (v2) => {
    let command = "";
    const info = { tts: [{ voices: [{ name: "private-name", installed: true }] }] };
    const metadata = JSON.stringify(info);
    const wire = v2 ? JSON.stringify({ type: "info", data_length: Buffer.byteLength(metadata), payload_length: 0 }) + "\n" + metadata : JSON.stringify({ type: "info", data: info, payload_length: 0 }) + "\n";
    const server = net.createServer((socket) => {
      socket.once("data", (data) => { command += data.toString(); socket.write(wire.slice(0, 15)); setTimeout(() => socket.end(wire.slice(15)), 5); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      expect(await probeCreationSpeech(`tcp://127.0.0.1:${port}`, AbortSignal.timeout(1000))).toEqual({ state: "ready", data: { installed: true } });
      expect(JSON.parse(command)).toMatchObject({ type: "describe", data: {} });
      expect(command).not.toMatch(/synthesize|text|voice/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("closes the local speech socket on timeout", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(await probeCreationSpeech(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, AbortSignal.timeout(20))).toEqual({ state: "offline" });
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it.each(['{"type":"info","data_length":17000}\n', '{"type":"info","payload_length":1}\n', '{"type":"error","data":{"text":"secret path"}}\n', "x".repeat(32_769)])("discards unsafe speech protocol metadata without echo", async (wire) => {
    const server = net.createServer((socket) => socket.once("data", () => socket.end(wire)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(await probeCreationSpeech(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, AbortSignal.timeout(1000))).toEqual({ state: "offline" });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
