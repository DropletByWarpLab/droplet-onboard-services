/**
 * Pipe a fetch()/undici Response body (a web ReadableStream) into an
 * outgoing HTTP response without letting a mid-stream failure crash the
 * process.
 *
 * `Readable.pipe()` does NOT forward source errors to the destination —
 * an errored source just unpipes, and with no "error" listener on the
 * converted Readable the error re-throws as an uncaughtException and
 * takes the whole orchestrator down. That is exactly what happened on
 * the single-box: the camera stream routes wire
 * `req.on("close", () => ctrl.abort())`, so closing a live-view tab
 * aborted the upstream Frigate fetch mid-pipe and the orchestrator
 * fataled on "This operation was aborted" (uncaughtException →
 * full restart, every API down for the duration).
 *
 * AbortError (our own close→abort wiring) and TimeoutError (the routes'
 * AbortSignal.timeout bound) are expected unwind paths and stay silent;
 * anything else is logged. Either way the only safe move once headers
 * are out is to drop the socket.
 */
import { Readable, type Writable } from "node:stream";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("pipe-upstream");

export function pipeUpstreamBody(body: unknown, res: Writable): void {
  const stream = Readable.fromWeb(body as never);

  stream.on("error", (err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    if (name !== "AbortError" && name !== "TimeoutError") {
      logger.warn(
        { err },
        "upstream stream failed mid-pipe — dropping the response socket",
      );
    }
    res.destroy();
  });

  // The destination can fail too (e.g. write-after-disconnect). pipe()'s
  // internal handler unpipes but re-throws when nothing else listens —
  // same crash, other side. The response is already doomed; just make
  // sure the upstream socket is released.
  res.on("error", () => stream.destroy());

  // And when the client vanishes on a route that only wired
  // AbortSignal.timeout (no req-close abort), releasing the upstream on
  // response close beats buffering against backpressure until the
  // timeout fires.
  res.on("close", () => stream.destroy());

  stream.pipe(res);
}
