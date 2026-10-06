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

  // WARP-3193 SEC-DATA-2: every file tool call sends the user's Nextcloud
  // app-password in X-Nextcloud-Token; x-droplet-auth / x-api-key carry
  // service credentials. None may reach a log line.
  it.each([
    ["x-nextcloud-token", "ncAppPw-SECRET-Q7wE9-rT2yU"],
    ["x-droplet-auth", "SECRET-DROPLET-AUTH-a1b2c3d4"],
    ["x-api-key", "SECRET-API-KEY-z9y8x7"],
  ])("redacts the %s request header", (header, secret) => {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = mockReq("HDR-ID", { [header]: secret });
    const res = mockRes();
    runWithRequestId("HDR-ID", () => {
      logger(req as never, res as never);
    });
    res.emit("finish");
    expect(lines.join("")).not.toContain(secret);
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.headers[header]).toBe("[Redacted]");
  });

  // WARP-3193 SEC-DATA-4: the pre-auth calendar feed authenticates by
  // `?token=`, and the default req serializer logs `url` verbatim — so every
  // phone poll wrote a live feed credential into the log. Only the path is
  // logged; the query string never is.
  it("strips the query string from the logged req.url", () => {
    const SECRET = "cm0rowid.SECRET-FEED-TOKEN-base64url";
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = Object.assign(mockReq("URL-ID"), {
      url: `/api/calendar/publish/alice.ics?token=${SECRET}`,
    });
    const res = mockRes();
    runWithRequestId("URL-ID", () => {
      logger(req as never, res as never);
    });
    res.emit("finish");
    expect(lines.join("")).not.toContain(SECRET);
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.url).toBe("/api/calendar/publish/alice.ics");
  });

  it("replaces the redacted headers with the pino placeholder", () => {
    const lines = runLoggedRequest();
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.headers.authorization).toBe("[Redacted]");
    expect(completion.req.headers.cookie).toBe("[Redacted]");
  });
});

describe("requestLogger token redaction", () => {
  // Defense in depth: some clients pass credentials in the query
  // string, which pino-std-serializers DOES emit under `req.query`. Since
  // WARP-3622 the serializer drops `req.query` altogether, so the token cannot
  // ride into a log line whether or not the redact list still names it.
  it("never logs a token passed as a query param", () => {
    const SECRET_TOKEN = "PLAINTEXT-APPLICATION-TOKEN-q1w2e3";
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
    expect(lines.join("")).not.toContain(SECRET_TOKEN);
  });
});

describe("requestLogger webhook URL redaction (WARP-3532)", () => {
  it("redacts a webhook URL if a parsed request body is explicitly logged", () => {
    const secretUrl = "https://hooks.example.com/services/T0/B0/RAW-WEBHOOK-CREDENTIAL";
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = Object.assign(mockReq("WEBHOOK-URL-ID"), {
      body: { url: secretUrl },
    }) as ReturnType<typeof mockReq> & {
      body: { url: string };
      log: { info: (obj: unknown, msg: string) => void };
    };
    const res = mockRes();
    runWithRequestId("WEBHOOK-URL-ID", () => {
      logger(req as never, res as never);
      req.log.info({ req }, "explicit request serialization");
    });
    res.emit("finish");
    expect(lines.join("")).not.toContain("RAW-WEBHOOK-CREDENTIAL");
  });
});

describe("requestLogger secret query params (WARP-3122)", () => {
  const SIG = "SECRET-SEGMENT-SIGNATURE-zz9";
  const url = `/api/cameras/front/playback.segment?after=1&before=2&seg=0.ts&u=u1&exp=9&sig=${SIG}`;

  it("never logs the segment signature, neither in req.url nor in req.query", () => {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = Object.assign(mockReq("SIG-ID"), {
      url,
      originalUrl: url,
      query: { seg: "0.ts", sig: SIG, token: "SECRET-TOKEN-q" },
    }) as unknown as ReturnType<typeof mockReq> & {
      log: { info: (obj: unknown, msg: string) => void };
    };
    const res = mockRes();
    runWithRequestId("SIG-ID", () => {
      logger(req as never, res as never);
      req.log.info({ req }, "explicit req serialize");
    });
    res.emit("finish");
    const output = lines.join("");
    expect(output).not.toContain(SIG);
    expect(output).not.toContain("SECRET-TOKEN-q");
    const completion = JSON.parse(lines[lines.length - 1]);
    expect(completion.req.url).toBe("/api/cameras/front/playback.segment");
  });
});

describe("requestLogger personal data in the request (WARP-3622)", () => {
  // `scrubReq` cut the URL at `?` but still emitted the parsed `req.query`, so a
  // file path or search term reached container logs and the diagnostics bundle.
  const TERM = "salary-review-2026";
  const PATH_PARAM = "alice.martin";

  function serialized() {
    const lines: string[] = [];
    const logger = createRequestLogger({
      dest: { write: (s: string) => lines.push(s) },
      level: "info",
    });
    const req = Object.assign(mockReq("PD-ID"), {
      url: `/api/files/search?q=${TERM}&path=/HR/${TERM}.xlsx`,
      query: { q: TERM, path: `/HR/${TERM}.xlsx` },
      params: { username: PATH_PARAM },
    }) as unknown as ReturnType<typeof mockReq> & {
      log: { info: (obj: unknown, msg: string) => void };
    };
    const res = mockRes();
    runWithRequestId("PD-ID", () => {
      logger(req as never, res as never);
      req.log.info({ req }, "explicit req serialize");
    });
    res.emit("finish");
    return lines;
  }

  it("omits req.query and req.params from the serialized request", () => {
    for (const line of serialized()) {
      const parsed = JSON.parse(line);
      if (parsed.req) {
        expect(parsed.req).not.toHaveProperty("query");
        expect(parsed.req).not.toHaveProperty("params");
      }
    }
  });

  it("a files search request logs neither the term nor the path it asked for", () => {
    const output = serialized().join("");
    expect(output).not.toContain(TERM);
    expect(output).not.toContain(PATH_PARAM);
  });
});
