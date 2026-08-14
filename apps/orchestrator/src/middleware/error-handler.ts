import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("error-handler");

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
    detail?: unknown;
  } = {
    // WARP-807: distinguish 503 (an upstream dependency — the router/routing
    // service — is unavailable) from a genuine 500. The wizard keys off `code`
    // + `message`, but the coarse `error` category shouldn't mislabel a
    // reachability problem as "Internal server error".
    error:
      status === 503
        ? "Service unavailable"
        : status >= 500
          ? "Internal server error"
          : "Request failed",
    message: "",
  };

  if (trusted) {
    // Our own typed errors (`HttpError` / `RouterError` / `DeviceRegistryError`,
    // `ZodError`, `http-errors`) carry a deliberately client-facing message —
    // surface it verbatim, regardless of status.
    //
    // WARP-807 (K3): this notably covers a `RouterError` at the 5xx tier. When
    // OpenWrt/routing is unreachable a WRITE route throws
    // `RouterError.unreachable()` / `.timeout()` / `.disabled()` (now status
    // 503). Those carry an actionable message ("Router summary: fetch failed",
    // "Router supervision is disabled") + a stable `code` the wizard branches
    // on. Redacting them to "Something went wrong" — the previous behavior,
    // since they landed in the `status >= 500` branch below — made the
    // internet/vpn steps render a dead "Internal server error". Trusted typed
    // errors are leak-free by construction, so they bypass redaction.
    body.message = rawMessage;
  } else if (status >= 500) {
    // Server faults from an UNTRUSTED error (a raw `Error`, a Prisma error
    // mapped to 500, etc.): redact outside development so we never leak
    // stack/internal detail to clients. The real text still reaches
    // `logger.error` above.
    body.message =
      process.env.NODE_ENV === "development" ? rawMessage : "Something went wrong";
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
    // WARP-1907: a trusted typed error may also carry a structured `detail` the
    // client has to act on rather than merely display — the router-jack write's
    // `PORT_WRITE_REFUSED` carries the guard the dashboard raises its second
    // confirm from. Gated on `trusted` for exactly the reason `code` is: only
    // our own factories set it, so it is leak-free by construction, and an
    // untrusted error's arbitrary property must never reach a client.
    const detail = (err as { detail?: unknown }).detail;
    if (detail && typeof detail === "object") {
      body.detail = detail;
    }
  }

  // Surface flattened validation details for Zod failures.
  if (err instanceof ZodError) {
    body.details = err.flatten();
  }

  res.status(status).json(body);
}
