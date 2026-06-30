import pinoHttp from "pino-http";
import { createLogger } from "../lib/logger.js";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export const requestLogger = pinoHttp({
  logger: createLogger("http"),
  level: isTest ? "silent" : "info",
  // The auto "request completed" line fires on the response `finish` event,
  // where the ALS context may already have exited — so read the id stashed on
  // the request by requestIdMiddleware. The per-log object wins over the mixin,
  // so this line is always tagged. In-handler `req.log.*` lines are covered by
  // the mixin while the ALS context is live.
  customProps: (req) => ({
    requestId:
      (req as typeof req & { requestId?: string }).requestId ??
      "no-request-context",
  }),
});
