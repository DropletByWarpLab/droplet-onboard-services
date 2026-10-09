/** Refuse app-origin cookie writes to dashboard APIs before reading a body. */
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { requestAuthority, requestIsHttps, resolveTrustedOrigin, resolveTrustedOriginUrl } from "../lib/trusted-origin.js";

/** Hosts the box genuinely serves: IP literals, mDNS `.local`, LAN `.lan`, the
 *  canonical name and configured origins. Any other Host is attacker-chosen
 *  (DNS rebinding) and gets no same-origin shortcut. */
async function isServedHost(host: string): Promise<boolean> {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return true;
  if (/\.(local|lan)$/.test(host)) return true;
  return (await resolveTrustedOrigin()).allowedHosts.has(host);
}

/** The only port the dashboard is served on; any other port is another service. */
const DASHBOARD_PORT = "443";

/** Same-origin proof: https only, Origin host+port == the request's own host+port. */
async function isSameOrigin(url: URL, req: Parameters<RequestHandler>[0]): Promise<boolean> {
  if (url.protocol !== "https:" || !requestIsHttps(req)) return false;
  const self = requestAuthority(req);
  if (!self) return false;
  const originPort = url.port || "443";
  const originHost = url.hostname; // lower-cased; IPv6 keeps brackets
  return originHost === self.host && originPort === self.port
    && originPort === DASHBOARD_PORT && (await isServedHost(self.host));
}

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
          // Same-origin (https, identical host AND port, a host the box serves)
          // is not CSRF: a cross-site page cannot make a browser send that pair.
          // Keeps IP / mDNS access working. Plain http and unknown hosts fall
          // through to the allowlist. X-Forwarded-Host is never consulted.
          if (url.origin === origin && await isSameOrigin(url, req)) { next(); return; }
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
