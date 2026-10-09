import { afterEach, describe, expect, it, vi } from "vitest";
import { BIRDSEYE_FRAME_INTERVAL_MS, openBirdseyeStream } from "./frigate.client.js";

const JPEG_A = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B = new Uint8Array([0xff, 0xd8, 9, 9, 0xff, 0xd9]);

function jpeg(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "Content-Type": "image/jpeg" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openBirdseyeStream (Frigate 0.17: /api/birdseye/latest.jpg polled into MJPEG)", () => {
  it("polls the still endpoint, never the dead /api/birdseye MJPEG path", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => jpeg(JPEG_A));
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const resp = await openBirdseyeStream(ctrl.signal);
    ctrl.abort();
    await resp.body?.cancel();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/birdseye/latest.jpg");
    expect(url.searchParams.get("h")).toBe("720");
  });

  it("answers multipart/x-mixed-replace and wraps each frame as an image/jpeg part", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => jpeg(n++ === 0 ? JPEG_A : JPEG_B)));
    const ctrl = new AbortController();
    const resp = await openBirdseyeStream(ctrl.signal);
    expect(resp.headers.get("content-type")).toBe("multipart/x-mixed-replace;boundary=frame");

    const reader = resp.body!.getReader();
    const first = await reader.read();
    const text = Buffer.from(first.value!).toString("latin1");
    expect(text.startsWith("--frame\r\nContent-Type: image/jpeg\r\n")).toBe(true);
    expect(text).toContain(`Content-Length: ${JPEG_A.byteLength}\r\n\r\n`);
    expect(text.endsWith("\r\n")).toBe(true);

    // The second part is the next poll.
    const second = await reader.read();
    expect(Buffer.from(second.value!).toString("latin1")).toContain(
      `Content-Length: ${JPEG_B.byteLength}`,
    );
    ctrl.abort();
    await reader.cancel();
  });

  it("paces polling at roughly the configured frame interval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jpeg(JPEG_A)));
    const ctrl = new AbortController();
    const resp = await openBirdseyeStream(ctrl.signal);
    const reader = resp.body!.getReader();
    await reader.read();
    const t0 = Date.now();
    await reader.read();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(BIRDSEYE_FRAME_INTERVAL_MS - 30);
    ctrl.abort();
    await reader.cancel();
  });

  it("rejects with a 404 message when Frigate has no birdseye still (restream/birdseye off)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Camera not found" }, { status: 404 })),
    );
    await expect(openBirdseyeStream()).rejects.toThrow(/404/);
  });

  it("ends the stream when the client aborts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jpeg(JPEG_A)));
    const ctrl = new AbortController();
    const resp = await openBirdseyeStream(ctrl.signal);
    const reader = resp.body!.getReader();
    await reader.read();
    ctrl.abort();
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it("skips a transient bad frame but ends the stream after repeated failures", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return jpeg(JPEG_A);
        if (calls === 2) throw new Error("socket hang up");
        if (calls === 3) return jpeg(JPEG_B);
        return new Response("boom", { status: 500 });
      }),
    );
    const resp = await openBirdseyeStream();
    const reader = resp.body!.getReader();
    expect((await reader.read()).done).toBe(false); // A
    const recovered = await reader.read(); // failure skipped, then B
    expect(Buffer.from(recovered.value!).toString("latin1")).toContain(
      `Content-Length: ${JPEG_B.byteLength}`,
    );
    // Repeated 500s: the stream closes rather than hanging forever.
    let result = await reader.read();
    while (!result.done) result = await reader.read();
    expect(result.done).toBe(true);
  });
});
