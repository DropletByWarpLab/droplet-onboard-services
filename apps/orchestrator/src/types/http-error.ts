/**
 * HttpError — a tiny typed-error base for routes that want to throw an error
 * carrying an HTTP status straight to the global error handler.
 *
 * Mirrors the shape of `RouterError` and `DeviceRegistryError`: a numeric
 * `status`, a string `code`, and a `toJSON()` the routes (or the global
 * handler) can forward to the client as `{ error, code, status }`.
 *
 * The global error handler (`middleware/error-handler.ts`) honors `err.status`
 * for any error, so `throw HttpError.notFound(...)` from inside a route's
 * `try/catch → next(e)` flow yields the right status without per-route mapping.
 *
 * This is intentionally minimal — for richer cloud-provider semantics use the
 * `http-errors` package (also honored by the handler via `statusCode`); for
 * domain errors keep using `RouterError` / `DeviceRegistryError`.
 */

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    // Restore prototype chain for `instanceof` across the TS → ES target gap.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
    };
  }

  static badRequest(message = "Bad request"): HttpError {
    return new HttpError(message, 400, "BAD_REQUEST");
  }

  static unauthorized(message = "Unauthorized"): HttpError {
    return new HttpError(message, 401, "UNAUTHORIZED");
  }

  static forbidden(message = "Forbidden"): HttpError {
    return new HttpError(message, 403, "FORBIDDEN");
  }

  static notFound(message = "Not found"): HttpError {
    return new HttpError(message, 404, "NOT_FOUND");
  }

  static conflict(message = "Conflict"): HttpError {
    return new HttpError(message, 409, "CONFLICT");
  }

  static internal(message = "Internal server error"): HttpError {
    return new HttpError(message, 500, "INTERNAL");
  }
}
