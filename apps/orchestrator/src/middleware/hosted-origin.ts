/** Refuse app-origin cookie writes to dashboard APIs before reading a body. */
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { resolveTrustedOriginUrl } from "../lib/trusted-origin.js";

export const hostedOriginGuard: RequestHandler = async (req, res, next) => {
  // Express's default case-insensitive mounts must not become a CSRF bypass.
  const path = req.originalUrl.split("?", 1)[0].toLowerCase();
  // This separately authenticated namespace has its own gateway + app Origin
  // checks. Its writes arrive from 8443, not the dashboard origin.
  if (path === "/api/hosted/relay" || path.startsWith("/api/hosted/relay/")) { next(); return; }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && path.startsWith("/api/")) {
    const origin = req.header("origin");
    const bearer = /^Bearer [^\s]+$/.test(req.header("authorization") ?? "");
    if (origin) {
      try {
        const url = new URL(origin);
        // App listeners are never dashboard origins, even if CORS is widened.
        // Public auth/setup handlers run before Bearer authentication and may
        // use ambient cookies, so even an unverified Bearer cannot exempt apps.
        if (url.port === "8443") {
          res.status(403).json({ error: "foreign_origin_refused" }); return;
        }
        if (!bearer) {
          const allowed = new Set((config.corsAllowedOrigins ?? []).map((v) => new URL(v).origin));
          allowed.add(await resolveTrustedOriginUrl(req));
          if (url.origin !== origin || !allowed.has(url.origin)) {
            res.status(403).json({ error: "foreign_origin_refused" }); return;
          }
        }
      } catch {
        if (!bearer) { res.status(403).json({ error: "foreign_origin_refused" }); return; }
      }
    }
  }
  next();
};
