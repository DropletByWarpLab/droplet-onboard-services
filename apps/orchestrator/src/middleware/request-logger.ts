import pinoHttp from "pino-http";
import pino from "pino";
import { getRequestId } from "../lib/request-context.js";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

/**
 * Query parameters that carry a bearer-equivalent secret. They are scrubbed
 * from `req.query` on every route (the logged URL keeps only its path), so a log bundle
 * never carries a replayable credential. Add a name here when a route takes
 * one in the query string.
 *   - `token` — overlay link token (WARP-1474), calendar feed token.
 *   - `sig`   — signed recordings-segment URL (WARP-3122); `u`/`exp` alone
 *               are harmless without it.
 *   - `t`     — signed clip-share token (clips.service `signShareUrl`).
 */
export const SECRET_QUERY_PARAMS: readonly string[] = ["token", "sig", "t"];

const REDACTED = "[Redacted]";

/** pino-http req serializer (receives the std-serialized req). */
function scrubReq(req: { url?: string; query?: Record<string, unknown> } & Record<string, unknown>) {
  const out = { ...req };
  // WARP-3193 SEC-DATA-4: log the path only, never the query string.
  if (typeof out.url === "string") out.url = out.url.split("?", 1)[0];
  if (out.query && typeof out.query === "object") {
    const query = { ...out.query };
    for (const name of SECRET_QUERY_PARAMS) if (name in query) query[name] = REDACTED;
    out.query = query;
  }
  return out;
}

/**
 * The pino `redact` paths of the request logger. Exported so a test can prove
 * each one is a valid, effective path on a bare logger (pino-http's own
 * serializers drop `req.body` / `res.body` before redaction runs, so the body
 * entries are defence in depth that no end-to-end request can exercise).
 */
export const REQUEST_LOG_REDACT_PATHS: readonly string[] = [
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
  // WARP-3122: the signed-segment signature (see SECRET_QUERY_PARAMS,
  // which the req serializer also scrubs from `req.query`).
  "req.query.sig",
  "req.body.sign_public_key_pem",
  'req.headers["x-overlay-pop"]',
  // WARP-3193 SEC-DATA-2: the user's Nextcloud app-password rides on
  // every file tool call; the other two carry service credentials.
  'req.headers["x-nextcloud-token"]',
  'req.headers["x-droplet-auth"]',
  'req.headers["x-api-key"]',
  "res.body.token",
  // WARP-3513: a bay drive's recovery key is the master secret for the drive's
  // data. POST /storage/command/confirm returns it ONCE (the confirm that runs the
  // one-time reveal) as `{ recoveryKey }` (the host calls it `recovery_key`);
  // redact both spellings on any request/response body a future serializer might
  // emit, so the key can never ride out of the box in a log bundle.
  "res.body.recoveryKey",
  "res.body.recovery_key",
  "req.body.recoveryKey",
  "req.body.recovery_key",
];

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
      paths: [...REQUEST_LOG_REDACT_PATHS],
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
    // WARP-3122 + WARP-3193 SEC-DATA-4: `redact` cannot reach inside the `url`
    // string, so a custom req serializer logs the path only and scrubs
    // SECRET_QUERY_PARAMS from `req.query` (pino-http wraps it around the
    // standard serializer).
    serializers: { req: scrubReq },
    level: opts.level ?? (isTest ? "silent" : "info"),
    customProps: (req) => ({
      requestId:
        (req as typeof req & { requestId?: string }).requestId ??
        "no-request-context",
    }),
  });
}

export const requestLogger = createRequestLogger();
