import pinoHttp from "pino-http";
import pino from "pino";
import { getRequestId } from "../lib/request-context.js";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

// Dedicated pino-http base logger. Its `mixin` emits `requestId` ONLY while a
// request context is live — covering in-handler `req.log.*` lines. It must NOT
// emit the `no-request-context` marker: pino serialises a child logger's
// bindings first and the mixin output second, and JSON last-wins means a mixin
// value overwrites a same-key child binding. The auto "request completed" line
// fires on the response `finish` event, AFTER the ALS context has exited, so we
// carry the id there via `customProps` (read from `req.requestId`, stashed by
// requestIdMiddleware) and keep the mixin silent (`{}`) so it can't clobber that
// binding. Module loggers (`createLogger`) still emit the marker — only this
// pino-http base differs, because only it logs after the context has exited.
/**
 * Build the pino-http request logger. `dest`/`level` are injectable so tests can
 * capture output and assert the requestId tagging (production omits both).
 */
export function createRequestLogger(opts: {
  dest?: pino.DestinationStream;
  level?: pino.LevelWithSilent;
} = {}) {
  const httpBaseOpts: pino.LoggerOptions = {
    name: "http",
    // WARP-1015: the default req serializer emits headers verbatim, so
    // without this list every authenticated request logs its Bearer JWT /
    // Basic app-password / session cookie (and log bundles carry them off
    // the device). Redaction must live on THIS base logger — pino-http only
    // applies its own `redact` option when it creates the logger itself.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        // WARP-1474: the overlay QR link token is a bearer-equivalent secret —
        // it's returned to the owner ONCE and only its sha256 hash is persisted.
        // Redact it (and the client sign-key PEM) on any request/response body
        // that a future serializer or a `req.log.info({ req/res })` call might
        // emit, so a token can never ride out of the box in a log bundle.
        "req.body.token",
        // AC2 defense-in-depth: a client that passes the redeem token as a
        // query param (?token=…) lands it under `req.query.token`, which the
        // default pino req serializer DOES emit — redact it alongside the body
        // copy so neither shape rides out in a log bundle. (The raw `req.url`
        // is unaffected; the routes take the token in the JSON body, not the
        // query string.)
        "req.query.token",
        "req.body.sign_public_key_pem",
        'req.headers["x-overlay-pop"]',
        "res.body.token",
      ],
    },
    mixin() {
      const id = getRequestId();
      return id !== undefined ? { requestId: id } : {};
    },
  };
  const httpBaseLogger = opts.dest
    ? pino(httpBaseOpts, opts.dest)
    : pino(httpBaseOpts);
  return pinoHttp({
    logger: httpBaseLogger,
    level: opts.level ?? (isTest ? "silent" : "info"),
    customProps: (req) => ({
      requestId:
        (req as typeof req & { requestId?: string }).requestId ??
        "no-request-context",
    }),
  });
}

export const requestLogger = createRequestLogger();
