/**
 * vpn-reconcile.service.ts — WARP-2694. Keep the router's WireGuard state in
 * step with what the owner has been told exists.
 *
 * Interface creation is lazy: only a peer mint, an overlay approval, or a
 * profile fetch calls `/vpn/setup`, and nothing at boot ever does. That is
 * fine on a box that never changes — and wrong the moment the router does. A
 * factory reset, a reflash, or an OpenWrt upgrade wipes `wg0` and every peer
 * section with it, while Postgres still holds the active rows the dashboard
 * renders as "linked devices". Every one of those devices silently stops
 * connecting and nothing on the box notices, because every read the product
 * makes goes to the database, not the router. Measured on the house unit
 * 2026-09-03: remote access "enabled" for weeks, no interface anywhere.
 *
 * This tick closes that gap the narrow way:
 *
 *   * it acts ONLY when active peer rows exist — a box whose owner never set
 *     up remote access must not grow a udp/51820 listener on the WAN edge
 *     because a timer fired (creating the interface also opens that port,
 *     which is why `create_vpn_interface` is a Tier-3 operation);
 *   * it re-runs the idempotent `/vpn/setup`, which is a no-op while wg0
 *     exists and recreates it when it does not;
 *   * it re-installs any active row whose key the router no longer holds,
 *     from the public key + address the row already carries. No private key
 *     is needed or known: the client keeps its own, so its existing conf
 *     starts working again with no re-enrolment;
 *   * it stops and says so when the router reports `interface_live: false` —
 *     no WireGuard support (WARP-2689) — rather than re-installing peers into
 *     a device that does not exist.
 *
 * Bounded, cron-driven (no `while(true)`), and every router fault is logged
 * and swallowed: the next tick retries, and a routing-service restart must
 * not take the orchestrator down with it.
 */

export interface VpnReconcileDeps {
  prisma: {
    vpnPeer: {
      findMany(args: {
        where: { status: "active" };
        select: { publicKey: true; assignedIp: true; deviceLabel: true };
      }): Promise<Array<{ publicKey: string; assignedIp: string; deviceLabel: string | null }>>;
    };
  };
  router: {
    setup(opts: { listenPort: number; address: string }): Promise<{
      created: boolean;
      interface_live?: boolean | null;
    }>;
    listPeers(iface: string): Promise<Array<{ public_key: string }>>;
    installPeer(opts: {
      interface: string;
      publicKey: string;
      allowedIps: string[];
      persistentKeepalive: number;
      description: string;
    }): Promise<unknown>;
  };
  config: {
    vpnInterface: string;
    listenPort: number;
    serverAddress: string;
    keepaliveSeconds: number;
  };
  logger: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

export interface VpnReconcileResult {
  /** Nothing to reconcile: no active rows, so the router was not touched. */
  skipped: boolean;
  /** `/vpn/setup` reported it (re)created the interface this tick. */
  interfaceCreated: boolean;
  /** The router said the kernel device is missing — peers were NOT installed. */
  routerUnsupported: boolean;
  /** Public keys re-installed this tick. */
  reinstalled: string[];
}

export async function reconcileVpnInterface(
  deps: VpnReconcileDeps,
): Promise<VpnReconcileResult> {
  const { prisma, router, config, logger } = deps;
  const result: VpnReconcileResult = {
    skipped: false,
    interfaceCreated: false,
    routerUnsupported: false,
    reinstalled: [],
  };

  const active = await prisma.vpnPeer.findMany({
    where: { status: "active" },
    select: { publicKey: true, assignedIp: true, deviceLabel: true },
  });
  if (active.length === 0) {
    result.skipped = true;
    return result;
  }

  try {
    const setup = await router.setup({
      listenPort: config.listenPort,
      address: config.serverAddress,
    });
    result.interfaceCreated = setup.created === true;
    if (result.interfaceCreated) {
      logger.warn(
        { iface: config.vpnInterface, activePeers: active.length },
        "vpn: wg interface was missing from the router and has been recreated (WARP-2694)",
      );
    }
    if (setup.interface_live === false) {
      result.routerUnsupported = true;
      logger.error(
        { iface: config.vpnInterface, activePeers: active.length },
        "vpn: router has no WireGuard support — linked devices cannot connect until it is updated (WARP-2689)",
      );
      return result;
    }

    const held = new Set((await router.listPeers(config.vpnInterface)).map((p) => p.public_key));
    for (const row of active) {
      if (held.has(row.publicKey)) continue;
      await router.installPeer({
        interface: config.vpnInterface,
        publicKey: row.publicKey,
        allowedIps: [`${row.assignedIp}/32`],
        persistentKeepalive: config.keepaliveSeconds,
        description: row.deviceLabel ?? "",
      });
      result.reinstalled.push(row.publicKey);
    }
    if (result.reinstalled.length > 0) {
      logger.warn(
        { iface: config.vpnInterface, reinstalled: result.reinstalled.length },
        "vpn: re-installed linked devices the router had lost (WARP-2694)",
      );
    }
  } catch (err) {
    logger.warn({ err }, "vpn: reconcile tick failed — will retry next tick");
  }
  return result;
}
