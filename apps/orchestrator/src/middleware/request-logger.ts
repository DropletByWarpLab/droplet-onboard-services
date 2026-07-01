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
