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
    if (origin && !/^Bearer [^\s]+$/.test(req.header("authorization") ?? "")) {
      try {
        const url = new URL(origin);
        const allowed = new Set((config.corsAllowedOrigins ?? []).map((v) => new URL(v).origin));
        allowed.add(await resolveTrustedOriginUrl(req));
        // App listeners are never dashboard origins, even if CORS is widened.
        if (url.port === "8443" || url.origin !== origin || !allowed.has(url.origin)) {
          res.status(403).json({ error: "foreign_origin_refused" }); return;
        }
      } catch { res.status(403).json({ error: "foreign_origin_refused" }); return; }
    }
  }
  next();
};
