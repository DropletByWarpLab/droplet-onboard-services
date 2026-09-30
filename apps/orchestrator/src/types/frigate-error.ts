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

export const FRIGATE_NOT_FOUND_CODES = ["event_not_found", "thumbnail_not_found"] as const;

export type FrigateNotFoundCode = (typeof FRIGATE_NOT_FOUND_CODES)[number];

export class FrigateNotFoundError extends Error {
  readonly code: FrigateNotFoundCode;

  constructor(code: FrigateNotFoundCode) {
    super(code);
    this.name = "FrigateNotFoundError";
    this.code = code;
  }
}
