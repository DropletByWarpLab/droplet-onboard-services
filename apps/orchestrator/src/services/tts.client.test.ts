import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { parseTtsUrl, synthesizeWav, TtsUnavailableError, TTS_PCM_BYTES } from "./tts.client.js";

const META = { rate: 24000, width: 2, channels: 1 };
function event(type: string, data: unknown = null, payload: Buffer = Buffer.alloc(0), v2 = false): Buffer {
  const block = Buffer.from(JSON.stringify(data ?? {}));
  return Buffer.concat([Buffer.from(JSON.stringify({ type, ...(v2 ? { data_length: block.length } : { data }), payload_length: payload.length }) + "\n"), ...(v2 ? [block] : []), payload]);
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function peer(reply: (type: string, data: Record<string, unknown>, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const requests: { type: string; data: Record<string, unknown> }[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        requests.push(message); reply(message.type, message.data, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  return { url: `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests };
}
function success(pcm: Buffer, v2 = false, meta = META): Buffer {
  return Buffer.concat([event("audio-start", meta, undefined, v2), event("audio-chunk", meta, pcm, v2), event("audio-stop", null, undefined, v2)]);
}
async function rejected(response: Buffer, code = "PROTOCOL_ERROR") {
  const mock = await peer((_type, _data, socket) => socket.end(response));
  await expect(synthesizeWav({ url: mock.url, text: "Hello" })).rejects.toMatchObject({ name: "TtsUnavailableError", code });
}

describe("local speech configuration and input", () => {
  it("parses bounded TCP addresses including IPv6 without exposing config values", () => {
    expect(parseTtsUrl("tcp://kokoro-tts:10200")).toEqual({ host: "kokoro-tts", port: 10200 });
    expect(parseTtsUrl("tcp://[::1]:10200")).toEqual({ host: "::1", port: 10200 });
    for (const value of ["", "http://host:10200", "tcp://host:0", "tcp://host:65536", "tcp://host:10200/path", "tcp://user:secret@host:10200", "tcp://host:10200?x=1"]) {
      expect(() => parseTtsUrl(value)).toThrow(TtsUnavailableError);
      try { parseTtsUrl(value); } catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });
  it.each(["", "  ", "x".repeat(2001), "hi\0", "hi\ud800"])("rejects invalid text before connecting", async (text) => {
    await expect(synthesizeWav({ url: "tcp://localhost:10200", text })).rejects.toMatchObject({ code: "INVALID_TEXT" });
  });
  it("rejects malformed voice, invalid time budgets and already aborted requests", async () => {
    await expect(synthesizeWav({ url: "tcp://localhost:10200", text: "hello", voice: "../../model" })).rejects.toMatchObject({ code: "INVALID_VOICE" });
    await expect(synthesizeWav({ url: "tcp://localhost:10200", text: "hello", timeoutMs: 60_001 })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(synthesizeWav({ url: "tcp://localhost:10200", text: "hello", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("Wyoming PCM framing and WAV", () => {
  it.each([false, true])("writes a true PCM WAV from fragmented v2=%s packets", async (v2) => {
    const pcm = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10, 0x20, 0x80, 0x00]);
    const response = success(pcm, v2);
    const mock = await peer((_type, _data, socket) => {
      let offset = 0;
      const send = () => { if (socket.destroyed) return; socket.write(response.subarray(offset, offset + 3)); offset += 3; if (offset < response.length) setImmediate(send); };
      send();
    });
    const result = await synthesizeWav({ url: mock.url, text: "  Hello\nworld  " });
    expect(mock.requests).toEqual([{ type: "synthesize", data: { text: "Hello\nworld" }, payload_length: 0 }]);
    expect(result.wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(result.wav.readUInt32LE(4)).toBe(pcm.length + 36);
    expect(result.wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(result.wav.readUInt16LE(20)).toBe(1);
    expect(result.wav.readUInt16LE(22)).toBe(1);
    expect(result.wav.readUInt32LE(24)).toBe(24000);
    expect(result.wav.readUInt32LE(28)).toBe(48000);
    expect(result.wav.readUInt16LE(32)).toBe(2);
    expect(result.wav.readUInt16LE(34)).toBe(16);
    expect(result.wav.toString("ascii", 36, 40)).toBe("data");
    expect(result.wav.readUInt32LE(40)).toBe(pcm.length);
    expect(result.wav.subarray(44)).toEqual(pcm);
    expect(result.durationSeconds).toBe(pcm.length / 48000);
  });
  it("accepts legacy Piper's 22050 Hz and preserves sample bytes across multiple chunks", async () => {
    const meta = { ...META, rate: 22050 };
    const mock = await peer((_type, _data, socket) => socket.end(Buffer.concat([event("audio-start", meta), event("audio-chunk", null, Buffer.from([1, 2])), event("audio-chunk", meta, Buffer.from([3, 4])), event("audio-stop")])));
    const result = await synthesizeWav({ url: mock.url, text: "Hi" });
    expect(result.sampleRate).toBe(22050); expect(result.wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
  it.each([false, true])("only sends an optional voice after installed catalog approval (v2=%s)", async (v2) => {
    const mock = await peer((type, _data, socket) => socket.write(type === "describe" ? event("info", { tts: [{ voices: [{ name: "af_heart", installed: true }] }] }, undefined, v2) : success(Buffer.from([1, 2]), v2)));
    const result = await synthesizeWav({ url: mock.url, text: "Hi", voice: "af_heart" });
    expect(mock.requests.map((r) => r.type)).toEqual(["describe", "synthesize"]);
    expect(mock.requests[1].data.voice).toEqual({ name: "af_heart" }); expect(result.voice).toBe("af_heart");
  });
  it.each([false, undefined])("refuses uninstalled voice flag %s without requesting synthesis", async (installed) => {
    const mock = await peer((_type, _data, socket) => socket.write(event("info", { tts: [{ voices: [{ name: "not-bundled", installed }] }] })));
    await expect(synthesizeWav({ url: mock.url, text: "Hi", voice: "not-bundled" })).rejects.toMatchObject({ code: "INVALID_VOICE" });
    expect(mock.requests.map((r) => r.type)).toEqual(["describe"]);
  });
  it.each(["busy", "invalid-voice", "invalid-text", "synthesis-failed"])("keeps backend %s failures readable without peer details", async (backendCode) => {
    const mock = await peer((_type, _data, socket) => socket.end(event("error", { code: backendCode, text: "secret /internal/model user text" }, undefined, true)));
    try { await synthesizeWav({ url: mock.url, text: "Hi" }); throw new Error("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(TtsUnavailableError); expect(String(error)).not.toMatch(/secret|internal|user text/); }
  });
});

describe("untrusted speech stream bounds", () => {
  it.each([
    Buffer.from("{not json}\n"),
    Buffer.from(JSON.stringify({ type: "audio-start", data: [] }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-start", data_length: -1 }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-start", data_length: 1.5 }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-start", data_length: 16385 }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-chunk", payload_length: 1048577 }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-chunk", payload_length: "2" }) + "\n"),
    Buffer.from(JSON.stringify({ type: "audio-chunk", payload_length: -2 }) + "\n"),
    Buffer.concat([Buffer.from('{"type":"audio-start","data_length":2}\n'), Buffer.from("[]")]),
    Buffer.from("x".repeat(16385)),
    event("audio-chunk", META, Buffer.from([1, 2])),
    event("audio-stop"),
    Buffer.concat([event("audio-start", META), event("audio-stop")]),
    Buffer.concat([event("audio-start", META), event("audio-start", META)]),
    Buffer.concat([event("audio-start", META), event("audio-chunk", META, Buffer.from([1]))]),
    Buffer.concat([event("audio-start", META), event("audio-chunk", { ...META, rate: 16000 }, Buffer.from([1, 2]))]),
    Buffer.concat([event("audio-start", META), event("audio-chunk", META)]),
  ])("rejects malformed, premature or inconsistent frames (%#)", async (response) => rejected(response));
  it.each([{ ...META, rate: 7999 }, { ...META, rate: 48001 }, { ...META, rate: "24000" }, { ...META, width: 4 }, { ...META, channels: 2 }])("rejects unsupported format %j", async (meta) => rejected(event("audio-start", meta)));
  it("caps duration and decoded PCM bytes independently", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    await rejected(Buffer.concat([event("audio-start", META), ...Array.from({ length: 9 }, () => event("audio-chunk", META, chunk))]), "TOO_LARGE");
    const meta = { ...META, rate: 48000 };
    await rejected(Buffer.concat([event("audio-start", meta), ...Array.from({ length: Math.ceil(TTS_PCM_BYTES / chunk.length) + 1 }, () => event("audio-chunk", meta, chunk))]), "TOO_LARGE");
  });
  it("caps frame counts even for tiny legal PCM chunks", async () => rejected(Buffer.concat([event("audio-start", META), ...Array.from({ length: 2048 }, () => event("audio-chunk", META, Buffer.from([0, 0])))])));
  it("times out, honors cancellation, releases permits and refuses excess concurrency", async () => {
    const silent = await peer(() => {});
    await expect(synthesizeWav({ url: silent.url, text: "Hi", timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const first = new AbortController(), second = new AbortController();
    const running = [synthesizeWav({ url: silent.url, text: "Hi", signal: first.signal }), synthesizeWav({ url: silent.url, text: "Hi", signal: second.signal })];
    await expect(synthesizeWav({ url: silent.url, text: "Hi" })).rejects.toMatchObject({ code: "BUSY" });
    first.abort(); second.abort();
    expect((await Promise.allSettled(running)).map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await expect(synthesizeWav({ url: silent.url, text: "Hi", timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("reports truncated streams as unavailable and never emits partial WAV", async () => {
    await rejected(Buffer.concat([event("audio-start", META), event("audio-chunk", META, Buffer.from([1, 2]))]), "UNREACHABLE");
    const mock = await peer((_type, _data, socket) => socket.end('{"type":"audio-start"'));
    await expect(synthesizeWav({ url: mock.url, text: "Hi" })).rejects.toMatchObject({ code: "UNREACHABLE" });
  });
});
