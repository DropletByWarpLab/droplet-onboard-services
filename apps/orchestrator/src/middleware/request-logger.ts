import pinoHttp from "pino-http";
import pino from "pino";
import { getRequestId } from "../lib/request-context.js";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

/** Recovery-key fields are kept exported so focused custody tests can verify the exact redaction paths. */
export const REQUEST_LOG_REDACT_PATHS: readonly string[] = [
  "res.body.recoveryKey",
  "res.body.recovery_key",
  "req.body.recoveryKey",
  "req.body.recovery_key",
];

/** pino-http req serializer (receives the std-serialized req). */
function scrubReq(req: { url?: string } & Record<string, unknown>) {
  const out = { ...req };
  // WARP-3193 SEC-DATA-4: log the path only, never the query string.
  if (typeof out.url === "string") out.url = out.url.split("?", 1)[0];
  // WARP-3622: nor the parsed copies of it. `query` (file paths, search terms,
  // recipients, feed and segment tokens) and `params` (path segments such as a
  // username or share id) are personal data that would ride into container logs
  // and the diagnostics bundle, which redacts secrets, not personal data.
  delete out.query;
  delete out.params;
  return out;
}

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
        // WARP-3532: chat-app webhook URLs carry posting credentials in their
        // path. The current request serializer omits bodies, but keep this
        // secret out if a future handler logs a parsed request object.
        "req.body.url",
        // AC2 defense-in-depth: a client that passes the redeem token as a
        // query param (?token=…) lands it under `req.query.token`, which the
        // default pino req serializer DOES emit — redact it alongside the body
        // copy so neither shape rides out in a log bundle. (The raw `req.url`
        // is unaffected; the routes take the token in the JSON body, not the
        // query string.)
        "req.query.token",
        // WARP-3122: the signed-segment signature (the req serializer also
        // drops `req.query` entirely, WARP-3622).
        "req.query.sig",
        "req.body.sign_public_key_pem",
        'req.headers["x-overlay-pop"]',
        // WARP-3193 SEC-DATA-2: the user's Nextcloud app-password rides on
        // every file tool call; the other two carry service credentials.
        'req.headers["x-nextcloud-token"]',
        'req.headers["x-droplet-auth"]',
        'req.headers["x-api-key"]',
        "res.body.token",
        ...REQUEST_LOG_REDACT_PATHS,
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
    // WARP-3122 + WARP-3193 SEC-DATA-4 + WARP-3622: `redact` cannot reach inside
    // the `url` string, so a custom req serializer logs the path only and drops
    // `req.query` and `req.params` (pino-http wraps it around the standard
    // serializer).
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
