/**
 * Device pairing routes (ADR-071 slices B + C, WARP-3739): one registrar, three
 * devices, one behaviour.
 *
 *   router  GET  /network/router/pairing        pairing card state (owner/admin/family)
 *           POST /network/router/pair           claim + persist       (owner/admin)
 *           POST /network/router/pair/persist   retry the persist leg (owner/admin)
 *   switch  the same three under /network/switch/...
 *   AP      the same three under /network/aps/:mac/..., per access point
 *
 * The POSTs are the owner's confirmed click (the dashboard asks first, ADR-014),
 * not an AI action: `requireRole`, never `requireRoleOrMcpService`. No route here
 * ever returns the password; the service writes one CommandAuditLog row per
 * attempt (`service` = router-pairing | switch-pairing | ap-pairing).
 */
import type { Request, Response, NextFunction, Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import type { DevicePairingService } from "../services/device-pairing.service.js";
import { normalizeMac } from "../lib/mac.js";

/**
 * The same floor as every other network read (network-status.routes.ts
 * `requireNetworkMember`, WARP-3632). Restated here rather than imported so this
 * module does not pull the whole status-route graph in for one line.
 */
const requireNetworkMember = requireRoleOrMcpService("owner", "admin", "family");

export interface DevicePairingRouteDeps {
  prisma: PrismaClient;
  service: DevicePairingService;
}

export function publicBody(r: {
  ok: boolean;
  persisted: boolean;
  host?: string;
  model?: string;
  paired_at?: string;
  error?: string;
  code?: string;
}) {
  const { ok, persisted, host, model, paired_at, error, code } = r;
  return { ok, persisted, host, model, paired_at, error, code };
}

/** `/network/router` -> the singleton device; `/network/aps/:mac` -> one AP. */
function registerAt(router: Router, base: string, service: DevicePairingService, perDevice: boolean): void {
  /** The AP's MAC in routing's canonical form, or null (a 404, like the AP routes). */
  const deviceId = (req: Request): string | undefined | null => {
    if (!perDevice) return undefined;
    try {
      return normalizeMac(String(req.params.mac));
    } catch {
      return null;
    }
  };
  const notFound = (res: Response) =>
    res.status(404).json({ ok: false, persisted: false, error: "AP not found", code: "AP_NOT_FOUND" });

  router.get(`${base}/pairing`, requireNetworkMember, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = deviceId(req);
      if (id === null) return void notFound(res);
      res.json(perDevice ? await service.getPairingView(id) : await service.getPairingView());
    } catch (err) {
      next(err);
    }
  });

  router.post(`${base}/pair`, requireRole("owner", "admin"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = deviceId(req);
      if (id === null) return void notFound(res);
      const result = perDevice ? await service.pair(req.user?.id, id) : await service.pair(req.user?.id);
      res.status(result.httpStatus).json(publicBody(result));
    } catch (err) {
      next(err);
    }
  });

  router.post(`${base}/pair/persist`, requireRole("owner", "admin"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = deviceId(req);
      if (id === null) return void notFound(res);
      const result = perDevice
        ? await service.persistPending(req.user?.id, id)
        : await service.persistPending(req.user?.id);
      res.status(result.httpStatus).json(publicBody(result));
    } catch (err) {
      next(err);
    }
  });
}

export function registerRouterPairingRoutes(router: Router, deps: DevicePairingRouteDeps): void {
  registerAt(router, "/network/router", deps.service, false);
}

export function registerSwitchPairingRoutes(router: Router, deps: DevicePairingRouteDeps): void {
  registerAt(router, "/network/switch", deps.service, false);
}

/**
 * Per access point. ADR-071 §2.3: ONE `ap_openwrt_password` for every AP, so
 * pairing a second AP replaces the first one's credential (see the routing README).
 */
export function registerApPairingRoutes(router: Router, deps: DevicePairingRouteDeps): void {
  registerAt(router, "/network/aps/:mac", deps.service, true);
}
