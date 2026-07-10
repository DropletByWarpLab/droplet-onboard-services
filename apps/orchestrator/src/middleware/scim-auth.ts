/**
 * WARP (SCIM directory sync) — SCIM provisioning-bearer middleware.
 *
 * Guards every /scim/v2/* route. SCIM is a DISTINCT trust boundary from the
 * human session and the SERVICE_TOKEN_* service principals (those carry the
 * `service` ROLE for inbound LLM/tool calls). Okta's SCIM client presents a
 * single dedicated provisioning secret — DROPLET_SCIM_BEARER_TOKEN — which we
 * validate here on EVERY request and NEVER log.
 *
 * Security posture:
 *   - Constant-time compare (timingSafeEqual, length-checked first) so a
 *     token-guessing attacker can't time-slice a match — same idiom as
 *     auth.ts matchServiceToken.
 *   - FAIL CLOSED on an unset secret: if DROPLET_SCIM_BEARER_TOKEN is empty,
 *     every request is rejected (an un-provisioned appliance never accepts an
 *     unauthenticated — or empty-bearer — SCIM call).
 *   - Rejections render the SCIM Error envelope (application/scim+json) with a
 *     401 status, so Okta sees a well-formed SCIM error rather than the
 *     orchestrator's generic auth JSON.
 *
 * This middleware is mounted on the PUBLIC router segment (Okta has no human
 * session) and is the ONLY auth for the SCIM surface — it does NOT fall
 * through to authMiddleware.
 */
import type { Request, Response, NextFunction } from "express";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { recordAccessDenied } from "./auth.js";
import { scimError, SCIM_CONTENT_TYPE } from "../services/scim-resource.js";

/** Constant-time bearer comparison. Empty `expected` (unset secret) always
 *  returns false → fail closed. Length mismatch short-circuits before the
 *  constant-time compare (a length difference isn't secret). */
function bearerMatches(presented: string, expected: string): boolean {
  if (!expected) return false; // fail closed — no secret configured
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function scimAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!presented || !bearerMatches(presented, config.DROPLET_SCIM_BEARER_TOKEN)) {
    // WARP-1062 (audit item B): a rejected SCIM bearer is a policy violation
    // on the provisioning surface — emit the same WARP-237 row as requireRole
    // denials (the row carries only path/method/reason, never the token).
    recordAccessDenied(req, "scim-bearer-invalid");
    // Never log the presented or expected token.
    res
      .status(401)
      .type(SCIM_CONTENT_TYPE)
      .json(scimError(401, "Invalid or missing SCIM provisioning bearer token"));
    return;
  }
  next();
}
