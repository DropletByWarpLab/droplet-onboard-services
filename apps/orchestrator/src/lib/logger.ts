import pino from "pino";
import { getRequestId } from "./request-context.js";

/**
 * Canonical orchestrator logger factory. The `mixin` runs on every log call
 * and stamps the current request id (from AsyncLocalStorage) onto the line, so
 * deep service-layer logs carry the same `requestId` as request handlers
 * without threading it through call signatures (WARP-108).
 *
 * `dest` is for tests only (a writable sink); production omits it and pino
 * writes JSON to stdout as before.
 */
export function createLogger(
  name: string,
  dest?: { write: (s: string) => void },
): pino.Logger {
  const opts: pino.LoggerOptions = {
    name,
    mixin() {
      return { requestId: getRequestId() ?? "no-request-context" };
    },
  };
  return dest ? pino(opts, dest as pino.DestinationStream) : pino(opts);
}
