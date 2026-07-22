import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestLogger } from "./request-logger.js";
import { runWithRequestId } from "../lib/request-context.js";

// Minimal http-ish req/res doubles: pino-http only needs an EventEmitter res
// (it logs the "request completed" line on the `finish` event) plus method/url
// on req.
function mockRes(headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader() {},
    getHeaders: () => headers,
    setHeader() {},
    end() {},
  });
}
function mockReq(requestId?: string, headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/x",
    headers,
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

describe("requestLogger credential redaction (WARP-1015)", () => {
  // pino-std-serializers' default req serializer emits headers VERBATIM, so
  // without a redact list every authenticated request writes its Bearer JWT /
  // Basic app-password / session cookie into production logs (and from there
  // into WARP-823 log bundles). Seed real-shaped credentials and prove no log
  // line ever carries them.
  const BEARER = "Bearer SECRET-ACCESS-JWT-abc123";
  const COOKIE = "droplet_session=SECRET-SESSION-VALUE";
  const SET_COOKIE = "droplet_session=SECRET-NEW-SESSION; HttpOnly";

  function runLoggedRequest() {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = mockReq("REDACT-ID", {
      authorization: BEARER,
      cookie: COOKIE,
    }) as ReturnType<typeof mockReq> & {
      log: { info: (msg: string) => void };
    };
    const res = mockRes({ "set-cookie": SET_COOKIE });
    runWithRequestId("REDACT-ID", () => {
      logger(req as never, res as never);
      req.log.info("in-handler line");
    });
    res.emit("finish");
    return lines;
  }

  it("never logs the authorization or cookie request headers", () => {
    const output = runLoggedRequest().join("");
    expect(output).not.toContain(BEARER);
    expect(output).not.toContain(COOKIE);
  });

  it("never logs the set-cookie response header", () => {
    const output = runLoggedRequest().join("");
    expect(output).not.toContain(SET_COOKIE);
  });

  it("replaces the redacted headers with the pino placeholder", () => {
    const lines = runLoggedRequest();
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.headers.authorization).toBe("[Redacted]");
    expect(completion.req.headers.cookie).toBe("[Redacted]");
  });
});

describe("requestLogger overlay QR link-token redaction (WARP-1474)", () => {
  // The overlay QR link token is bearer-equivalent (returned once; only its
  // sha256 hash is stored). The client status PoP header is a live signature.
  // Neither may ever land in a log line.
  const POP = "SECRET-OVERLAY-POP-SIGNATURE-base64==";

  it("redacts the X-Overlay-PoP request header", () => {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = mockReq("POP-ID", { "x-overlay-pop": POP });
    const res = mockRes();
    runWithRequestId("POP-ID", () => {
      logger(req as never, res as never);
    });
    res.emit("finish");
    const output = lines.join("");
    expect(output).not.toContain(POP);
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.headers["x-overlay-pop"]).toBe("[Redacted]");
  });

  // AC2 defense-in-depth: some clients pass the redeem token in the query
  // string, which pino-std-serializers DOES emit under `req.query`. Without
  // `req.query.token` in the redact list it rides straight into the log line.
  it("redacts req.query.token (a token passed as a query param)", () => {
    const SECRET_TOKEN = "PLAINTEXT-OVERLAY-LINK-TOKEN-q1w2e3";
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    // pino-http's default req serializer emits `req.query`, so force a
    // serialize via an explicit `req.log.info({ req })` — the exact shape a
    // future body/query-logging serializer would produce.
    const req = Object.assign(mockReq("QTOK-ID"), {
      query: { token: SECRET_TOKEN },
    }) as unknown as ReturnType<typeof mockReq> & {
      query: { token: string };
      log: { info: (obj: unknown, msg: string) => void };
    };
    const res = mockRes();
    runWithRequestId("QTOK-ID", () => {
      logger(req as never, res as never);
      req.log.info({ req }, "explicit req serialize");
    });
    const output = lines.join("");
    expect(output).not.toContain(SECRET_TOKEN);
    const line = JSON.parse(lines[lines.length - 1]);
    expect(line.req.query.token).toBe("[Redacted]");
  });
});
