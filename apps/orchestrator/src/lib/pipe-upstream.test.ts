/**
 * pipeUpstreamBody — the camera-route stream pump.
 *
 * The contract under test: a mid-stream upstream failure must NEVER
 * escape as an unhandled "error" event. Pre-fix, the routes did
 * `Readable.fromWeb(body).pipe(res)` bare, so the AbortError fired by
 * the routes' own `req.on("close", () => ctrl.abort())` wiring crashed
 * the whole orchestrator the moment a live-view tab closed
 * (uncaughtException: "This operation was aborted").
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { pipeUpstreamBody } from "./pipe-upstream.js";

function controlledBody(): {
  body: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  cancelled: () => boolean;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, controller, cancelled: () => cancelled };
}

describe("pipeUpstreamBody", () => {
  it("pipes upstream chunks through to the response", async () => {
    const res = new PassThrough();
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((r) => res.on("end", () => r()));

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("frame-1"));
        c.enqueue(new TextEncoder().encode("frame-2"));
        c.close();
      },
    });

    pipeUpstreamBody(body, res);
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe("frame-1frame-2");
  });

  it("swallows the client-disconnect AbortError and drops the socket instead of crashing", async () => {
    const { body, controller } = controlledBody();
    const res = new PassThrough();
    const closed = new Promise<void>((r) => res.on("close", () => r()));

    pipeUpstreamBody(body, res);
    controller.enqueue(new TextEncoder().encode("frame-1"));
    // What undici does when ctrl.abort() fires mid-stream:
    controller.error(
      new DOMException("This operation was aborted", "AbortError"),
    );

    // Reaching the assertions without an unhandled "error" event IS the
    // fix — pre-fix this scenario re-threw as an uncaughtException.
    await closed;
    expect(res.destroyed).toBe(true);
  });

  it("drops the socket on a non-abort upstream failure too", async () => {
    const { body, controller } = controlledBody();
    const res = new PassThrough();
    const closed = new Promise<void>((r) => res.on("close", () => r()));

    pipeUpstreamBody(body, res);
    controller.error(new Error("frigate fell over mid-frame"));

    await closed;
    expect(res.destroyed).toBe(true);
  });

  it("cancels the upstream when the response closes first", async () => {
    const { body, controller, cancelled } = controlledBody();
    const res = new PassThrough();

    pipeUpstreamBody(body, res);
    controller.enqueue(new TextEncoder().encode("frame-1"));
    res.destroy();

    await vi.waitFor(() => expect(cancelled()).toBe(true));
  });
});
