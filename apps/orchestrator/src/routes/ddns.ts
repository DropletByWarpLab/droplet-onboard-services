/**
 * Dynamic DNS routes — currently only DuckDNS, the free option that solves
 * the "what hostname goes in the WireGuard peer config?" problem when the
 * user's home router doesn't have a static IP.
 *
 * This is admin-only: dynamic DNS is a network-wide config affecting every
 * VPN peer's reachability. A family user shouldn't be able to repoint the
 * household's domain.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  fetchDuckDnsStatus,
  setDuckDnsConfig,
} from "../services/openwrt.client.js";
import { requireRole } from "../middleware/auth.js";

// WARP-171: legacy `isAdmin(req)` inlined-and-removed; both endpoints
// below use `requireRole("owner", "admin")` mounted as middleware so
// the 403 short-circuits before any handler-local validation.

// Subdomain/token grammars match the routing service Pydantic schemas so
// invalid input is rejected here instead of round-tripping through HTTP.
//
// `token` is optional: when omitted the routing service preserves the
// existing /etc/config/ddns password value, supporting the wizard's
// "keep stored token" path for returning customers (re-entering the
// Internet step via VPN Back or a wizard re-run). When present it must
// still meet the min(10)/max(128) DuckDNS shape.
const setSchema = z.object({
  subdomain: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
      message:
        "Subdomain must be lowercase letters, digits, or hyphens (no leading/trailing hyphen, no dots).",
    }),
  token: z.string().min(10).max(128).optional(),
  enabled: z.boolean().optional(),
});

export function createDdnsRouter(): Router {
  const router = Router();

  router.get(
    "/ddns/duckdns",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const status = await fetchDuckDnsStatus();
        res.json(status);
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/ddns/duckdns",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      try {
        const result = await setDuckDnsConfig(parsed.data);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
