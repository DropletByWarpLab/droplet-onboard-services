import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestLogger } from "./request-logger.js";
import { runWithRequestId } from "../lib/request-context.js";

// Minimal http-ish req/res doubles: pino-http only needs an EventEmitter res
// (it logs the "request completed" line on the `finish` event) plus method/url
// on req.
function mockRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader() {},
    setHeader() {},
    end() {},
  });
}
function mockReq(requestId?: string) {
  return Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/x",
    headers: {},
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

describe("requestLogger requestId tagging (WARP-108)", () => {
  it("tags the finish-event 'request completed' line with req.requestId even after the ALS context has exited", () => {
    // Regression guard: pino serialises child bindings first and mixin output
    // second (last-wins), so a marker-emitting mixin would clobber customProps
    // here and log "no-request-context". The mixin must stay silent off-context.
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = mockReq("REAL-FINISH-ID");
    const res = mockRes();
    // Attach inside the ALS context, then let it exit before `finish` fires —
    // exactly how the real middleware chain behaves.
    runWithRequestId("REAL-FINISH-ID", () => {
      logger(req as never, res as never);
    });
    res.emit("finish");
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.requestId).toBe("REAL-FINISH-ID");
  });

  it("tags in-handler req.log lines with the live ALS id", () => {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = mockReq("REAL-HANDLER-ID") as ReturnType<typeof mockReq> & {
      log: { info: (msg: string) => void };
    };
    const res = mockRes();
    runWithRequestId("REAL-HANDLER-ID", () => {
      logger(req as never, res as never);
      req.log.info("doing work");
    });
    const line = JSON.parse(lines[lines.length - 1]);
    expect(line.requestId).toBe("REAL-HANDLER-ID");
  });
});
