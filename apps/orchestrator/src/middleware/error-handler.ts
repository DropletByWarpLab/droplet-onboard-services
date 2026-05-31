import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import pino from "pino";

const logger = pino({ name: "error-handler" });

/**
 * Resolve the HTTP status for an error, in priority order:
 *
 *   1. An explicit `status` / `statusCode` carried by the error. This covers
 *      our typed errors (`HttpError`, `RouterError`, `DeviceRegistryError`)
 *      and the `http-errors` package.
 *   2. A `ZodError` → 400 (request validation failure).
 *   3. A Prisma known-request error, detected by `code`:
 *        - `P2025` (record not found)        → 404
 *        - `P2002` (unique-constraint clash) → 409
 *      Detected by duck-typing on `code` rather than `instanceof`, so test
 *      stand-ins (name === "PrismaClientKnownRequestError" + code) and the real
 *      Prisma class both resolve identically.
 *   4. Fallback → 500.
 *
 * Returns `null` when no specific status applies, so the caller can default.
 */
function resolveStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };

    const explicit = e.status ?? e.statusCode;
    if (typeof explicit === "number" && explicit >= 100 && explicit <= 599) {
      return explicit;
    }

    if (err instanceof ZodError) {
      return 400;
    }

    if (typeof e.code === "string") {
      if (e.code === "P2025") return 404;
      if (e.code === "P2002") return 409;
    }
  }

  return null;
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err }, "Unhandled error");

  const status = resolveStatus(err) ?? 500;

  const body: {
    error: string;
    message: string;
    code?: string;
    details?: unknown;
  } = {
    error: status >= 500 ? "Internal server error" : "Request failed",
    message: "",
  };

  // For server faults (>= 500) redact the message outside development so we
  // never leak stack/internal detail to clients. Client errors (4xx) are
  // safe-to-surface and are always returned verbatim.
  if (status >= 500) {
    body.message =
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong";
  } else {
    body.message = err.message;
  }

  // Surface a stable machine-readable code when the error carries one.
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    body.code = code;
  }

  // Surface flattened validation details for Zod failures.
  if (err instanceof ZodError) {
    body.details = err.flatten();
  }

  res.status(status).json(body);
}
