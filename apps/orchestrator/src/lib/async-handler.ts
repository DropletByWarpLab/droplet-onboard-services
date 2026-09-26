/**
 * WARP-3193 QUAL-8 — Express 4 does not catch a rejected promise from an
 * async route handler: the request hangs until the client times out and the
 * rejection surfaces as an unhandled rejection. Wrap a handler that can
 * reject so the error reaches `next()` (and so the global error handler).
 *
 * Apply it where a handler awaits something without its own try/catch; there
 * is no need to rewrite handlers that already catch.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
