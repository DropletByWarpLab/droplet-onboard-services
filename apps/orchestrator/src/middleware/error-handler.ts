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

/**
 * Whether an error's `message` and `code` are safe to surface verbatim to the
 * client. Only our own typed errors — which deliberately carry a client-facing
 * message + a stable, documented `code` — qualify:
 *
 *   - `HttpError` / `RouterError` / `DeviceRegistryError` (own `status`/`code`)
 *   - `ZodError` (validation feedback is the whole point)
 *   - the `http-errors` package (carries `statusCode` + an HTTP-safe message)
 *
 * Anything else — most importantly a raw Prisma `PrismaClientKnownRequestError`,
 * whose `message` embeds model/field/constraint internals and whose `code`
 * (`P2002`/`P2025`) exposes the persistence layer as public API surface — is
 * NOT trusted. Its synthesized 4xx gets a fixed safe message and no `code`;
 * the real text still reaches `logger.error`.
 */
function isClientSafeError(err: unknown): boolean {
  if (err instanceof ZodError) return true;
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (
      name === "HttpError" ||
      name === "RouterError" ||
      name === "DeviceRegistryError"
    ) {
      return true;
    }
    // `http-errors` instances carry a numeric `statusCode` and an
    // HTTP-status-derived message that is safe to return.
    if (typeof (err as { statusCode?: unknown }).statusCode === "number") {
      return true;
    }
  }
  return false;
}

/** Generic, leak-free message for an untrusted error at a given status. */
function safeMessageFor(status: number): string {
  switch (status) {
    case 400:
      return "Bad request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not found";
    case 409:
      return "Conflict";
    default:
      return "Request failed";
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err }, "Unhandled error");

  // If the response has already started streaming, we can't change the status
  // or body — hand off to Express's default handler to abort the connection.
  if (res.headersSent) {
    _next(err);
    return;
  }

  const status = resolveStatus(err) ?? 500;
  const trusted = isClientSafeError(err);
  const rawMessage =
    typeof (err as { message?: unknown })?.message === "string"
      ? (err as { message: string }).message
      : "";

  const body: {
    error: string;
    message: string;
    code?: string;
    details?: unknown;
  } = {
    error: status >= 500 ? "Internal server error" : "Request failed",
    message: "",
  };

  if (status >= 500) {
    // Server faults: redact outside development so we never leak stack/internal
    // detail to clients.
    body.message =
      process.env.NODE_ENV === "development" ? rawMessage : "Something went wrong";
  } else if (trusted) {
    // Client errors from our own typed errors carry a client-facing message —
    // surface it verbatim.
    body.message = rawMessage;
  } else {
    // 4xx synthesized from an untrusted error (e.g. a raw Prisma error mapped
    // to 404/409): the raw message embeds persistence internals, so return a
    // fixed safe message. The real text is preserved in `logger.error` above.
    body.message = safeMessageFor(status);
  }

  // Surface a stable machine-readable `code` ONLY for trusted typed errors.
  // Untrusted errors' `code` (e.g. Prisma `P2002`/`P2025`) would expose the
  // persistence layer as public API surface, so it is withheld.
  if (trusted) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      body.code = code;
    }
  }

  // Surface flattened validation details for Zod failures.
  if (err instanceof ZodError) {
    body.details = err.flatten();
  }

  res.status(status).json(body);
}
