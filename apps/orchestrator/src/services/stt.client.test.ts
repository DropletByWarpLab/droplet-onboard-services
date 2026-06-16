/**
 * WARP-844 — Wyoming STT client, exercised against a real in-process TCP
 * server speaking the protocol (JSON header line + binary payload), so
 * the framing is verified end-to-end rather than against mocks.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import {
  parseSttUrl,
  transcribePcm,
  SttUnavailableError,
} from "./stt.client.js";

interface SeenEvent {
  type: string;
  data: Record<string, unknown> | null;
  payloadBytes: number;
}

function startMockWyoming(opts: {
  transcript?: string;
  /** Emit a no-payload ack event before the transcript. */
  ackFirst?: boolean;
  /** Never answer (for timeout tests). */
  silent?: boolean;
}): Promise<{
  port: number;
  events: SeenEvent[];
  close: () => void;
}> {
  const events: SeenEvent[] = [];
  const server = net.createServer((sock) => {
    let buffer = Buffer.alloc(0);
    let pendingPayload = 0;
    let pendingHeader: SeenEvent | null = null;
    sock.on("data", (d) => {
      buffer = Buffer.concat([buffer, d]);
      for (;;) {
        if (pendingPayload > 0) {
          const take = Math.min(pendingPayload, buffer.length);
          buffer = buffer.subarray(take);
          pendingPayload -= take;
          if (pendingPayload > 0) return;
          events.push(pendingHeader!);
          pendingHeader = null;
        }
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;
        const header = JSON.parse(buffer.subarray(0, nl).toString("utf-8"));
        buffer = buffer.subarray(nl + 1);
        const evt: SeenEvent = {
          type: header.type,
          data: header.data ?? null,
          payloadBytes: header.payload_length ?? 0,
        };
        if (evt.payloadBytes > 0) {
          pendingPayload = evt.payloadBytes;
          pendingHeader = evt;
          continue;
        }
        events.push(evt);
        if (evt.type === "audio-stop" && !opts.silent) {
          if (opts.ackFirst) {
            sock.write(
              JSON.stringify({ type: "ack", data: null, payload_length: 0 }) +
                "\n",
            );
          }
          sock.write(
            JSON.stringify({
              type: "transcript",
              data: { text: opts.transcript ?? "hello world" },
              payload_length: 0,
            }) + "\n",
          );
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, events, close: () => server.close() });
    });
  });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("parseSttUrl", () => {
  it("parses the tcp:// convention", () => {
    expect(parseSttUrl("tcp://wyoming-faster-whisper:10300")).toEqual({
      host: "wyoming-faster-whisper",
      port: 10300,
    });
  });
  it("rejects other schemes", () => {
    expect(() => parseSttUrl("http://x:1")).toThrow(SttUnavailableError);
  });
});

describe("transcribePcm", () => {
  it("streams transcribe/audio-start/chunks/audio-stop and returns the transcript", async () => {
    const mock = await startMockWyoming({ transcript: "turn on the lights" });
    cleanup = mock.close;

    // 3000 bytes → two chunks (2560 + 440).
    const pcm = Buffer.alloc(3000, 7);
    const text = await transcribePcm({
      url: `tcp://127.0.0.1:${mock.port}`,
      pcm,
      rate: 16000,
    });

    expect(text).toBe("turn on the lights");
    expect(mock.events.map((e) => e.type)).toEqual([
      "transcribe",
      "audio-start",
      "audio-chunk",
      "audio-chunk",
      "audio-stop",
    ]);
    expect(mock.events[1]!.data).toEqual({
      rate: 16000,
      width: 2,
      channels: 1,
    });
    expect(
      mock.events
        .filter((e) => e.type === "audio-chunk")
        .reduce((n, e) => n + e.payloadBytes, 0),
    ).toBe(3000);
  });

  it("ignores non-transcript events before the transcript", async () => {
    const mock = await startMockWyoming({ transcript: "ok", ackFirst: true });
    cleanup = mock.close;
    const text = await transcribePcm({
      url: `tcp://127.0.0.1:${mock.port}`,
      pcm: Buffer.alloc(100),
      rate: 16000,
    });
    expect(text).toBe("ok");
  });

  it("parses Wyoming v2 framing (data_length block) — transcript text not inline", async () => {
    // v2: header carries data_length; the data dict is a separate JSON
    // block between the header line and the payload. Current rhasspy
    // whisper images ship v1, piper ships v2, and the compose tag
    // floats — both must parse (mirrors voice-io stt.py _read_event).
    const events: SeenEvent[] = [];
    const server = net.createServer((sock) => {
      sock.on("data", () => {
        // Reply immediately with: a v2 ack (with data block) followed by
        // a v2 transcript. Replying on first data is fine — the client
        // ignores everything until `transcript`.
        if (events.length > 0) return;
        events.push({ type: "replied", data: null, payloadBytes: 0 });
        const ackData = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
        sock.write(
          JSON.stringify({ type: "ack", data_length: ackData.length, payload_length: 0 }) +
            "\n",
        );
        sock.write(ackData);
        const tData = Buffer.from(
          JSON.stringify({ text: "v2 framed transcript" }),
          "utf-8",
        );
        sock.write(
          JSON.stringify({
            type: "transcript",
            data_length: tData.length,
            payload_length: 0,
          }) + "\n",
        );
        sock.write(tData);
      });
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as net.AddressInfo).port),
      );
    });
    cleanup = () => server.close();

    const text = await transcribePcm({
      url: `tcp://127.0.0.1:${port}`,
      pcm: Buffer.alloc(100),
      rate: 16000,
    });
    expect(text).toBe("v2 framed transcript");
  });

  it("rejects with SttUnavailableError on timeout", async () => {
    const mock = await startMockWyoming({ silent: true });
    cleanup = mock.close;
    await expect(
      transcribePcm({
        url: `tcp://127.0.0.1:${mock.port}`,
        pcm: Buffer.alloc(100),
        rate: 16000,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(SttUnavailableError);
  });

  it("rejects when nothing listens on the port", async () => {
    await expect(
      transcribePcm({
        url: "tcp://127.0.0.1:1",
        pcm: Buffer.alloc(10),
        rate: 16000,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(SttUnavailableError);
  });
});
