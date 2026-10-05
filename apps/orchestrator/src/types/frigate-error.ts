/**
 * FrigateNotFoundError — typed "Frigate answered 404" error (WARP-2975).
 *
 * `frigate.client.ts` used to signal a missing event / thumbnail with a bare
 * `new Error("event_not_found")` / `new Error("thumbnail_not_found")`, and the
 * routes recovered the meaning by comparing `err.message` to the same string.
 * That coupling is invisible to the compiler: reword the message and the route
 * silently turns a 404 into a 502/500.
 *
 * Callers branch on `err instanceof FrigateNotFoundError` (and, when more than
 * one code is possible, `err.code`) — never on the message. The message is
 * kept equal to the code so logs and any generic `next(err)` path read exactly
 * as before.
 *
 * Lives in `types/` (like `SwitchAuthError`) rather than in `frigate.client.ts`
 * so a route can import it while tests replace the client module wholesale.
 */

export const FRIGATE_NOT_FOUND_CODES = [
  "event_not_found",
  "thumbnail_not_found",
  // WARP-3509 — the review media routes: no such review row, no preview clip.
  "review_not_found",
  "preview_not_found",
] as const;

export type FrigateNotFoundCode = (typeof FRIGATE_NOT_FOUND_CODES)[number];

export class FrigateNotFoundError extends Error {
  readonly code: FrigateNotFoundCode;

  constructor(code: FrigateNotFoundCode) {
    super(code);
    this.name = "FrigateNotFoundError";
    this.code = code;
  }
}

/**
 * FrigateUpstreamError — Frigate answered, but with a status the caller cannot
 * use (WARP-3509).
 *
 * The counterpart of `FrigateNotFoundError` for every other non-2xx: a 5xx, a
 * 405 from a path the running Frigate does not serve that way (the 0.13-era
 * `POST /api/review/<id>/viewed` is one on 0.17), a 401/403/422. The clients
 * throw a plain `Error("Frigate <what>: <status>")` for these and
 * `isUpstreamUnavailable` recognises that message only for 5xx, so a route
 * that wants "Frigate is not giving me what I need" as ONE case (the WARP-3105
 * degrade contract) could only get it by matching on the message — the same
 * coupling WARP-2975 removed for the not-found case above.
 *
 * The message keeps the `Frigate <what>: <status>` shape so logs and any
 * generic `next(err)` path read as before. `detail` is for the answer that is
 * a 2xx and still unusable (a proxy's HTML page where JSON was due, a body
 * that died mid-transfer); `cause` keeps the error that proved it.
 */
export class FrigateUpstreamError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, detail?: string, cause?: unknown) {
    super(
      `Frigate ${operation}: ${status}${detail ? ` (${detail})` : ""}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "FrigateUpstreamError";
    this.status = status;
  }
}
