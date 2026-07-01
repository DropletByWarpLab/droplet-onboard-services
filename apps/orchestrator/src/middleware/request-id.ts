import type { Request, Response, NextFunction } from "express";
import {
  newRequestId,
  sanitizeRequestId,
  runWithRequestId,
} from "../lib/request-context.js";

/**
 * WARP-108. Adopt a valid inbound `x-request-id` or mint a fresh one, stash it
 * on `req.requestId` (so pino-http's finish-time log can read it), echo it on
 * the response, and run the rest of the request inside the ALS context so every
 * downstream log line and outbound call carries the same id.
 *
 * Mounted BEFORE the pino-http request logger.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = sanitizeRequestId(
    (req.headers["x-request-id"] as string | undefined) ?? undefined,
  );
  const id = inbound ?? newRequestId();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader("x-request-id", id);
  runWithRequestId(id, () => next());
}
