/**
 * vpn-reconcile.service.ts — WARP-2694. Keep the router's WireGuard interface
 * in step with what the owner has been told exists.
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
 *   * it re-installs the active rows' peers ONLY when `/vpn/setup` reports it
 *     actually (re)created the interface this tick (`created === true`) — the
 *     one unambiguous "the router lost everything" signal. See the big
 *     comment on the re-install gate for why a per-row "this key is missing"
 *     test is NOT safe;
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
  /**
   * WARP-2686 — re-check that a row is STILL active immediately before its
   * peer is (re)installed, closing the window between the tick's `findMany`
   * and the install where a concurrent revoke could mark the row revoked.
   * Optional: when absent the tick proceeds without the re-check (the
   * re-install gate below already makes the race vanishingly rare). Wired in
   * production to a `vpnPeer.findFirst({ where: { publicKey, status: 'active' } })`.
   */
  isStillActive?: (publicKey: string) => Promise<boolean>;
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
  /**
   * The interface was recreated with a NEW server key, so the linked devices'
   * existing configs (which carry the OLD server public key) will not
   * reconnect until they are re-added. Re-installing their peers is necessary
   * but NOT sufficient — the owner has to re-link. Logged loudly; surfaced
   * here so a caller can raise a notification.
   */
  relinkRequired: boolean;
  /**
   * The interface exists but is missing peers the DB has as active, WITHOUT a
   * recreate this tick — i.e. an in-flight/staged revoke or a partial state
   * this tick deliberately did NOT act on. Count for visibility only.
   */
  unreconciledMissing: number;
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
    relinkRequired: false,
    unreconciledMissing: 0,
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

    // WARP-2689 — kernel truth, three-valued. `false` (router has no WireGuard
    // support) must stop us before installing peers into a device that is not
    // there; `null`/absent (router cannot report) is NOT a stop.
    if (setup.interface_live === false) {
      result.routerUnsupported = true;
      logger.error(
        { iface: config.vpnInterface, activePeers: active.length },
        "vpn: router has no WireGuard support — linked devices cannot connect until it is updated (WARP-2689)",
      );
      return result;
    }

    const held = new Set((await router.listPeers(config.vpnInterface)).map((p) => p.public_key));
    const missing = active.filter((row) => !held.has(row.publicKey));

    // ── THE RE-INSTALL GATE — why it is `created`, not `!held.has(key)` ──
    //
    // A peer missing from the router while its row is active looks identical
    // to two very different situations, and uci cannot tell them apart:
    //   (a) the router was wiped (reflash / factory-reset / upgrade) — the
    //       whole interface and every section is gone. THIS is what WARP-2694
    //       exists to repair.
    //   (b) an owner REVOKED a device and the revoke is staged: DELETE removed
    //       the peer's uci section (so it is gone from listPeers) but the
    //       apply/reload has not settled, so the orchestrator deliberately
    //       keeps the row `active` (REVOKE_STAGED / the idle-expiry sweep's
    //       staged branch) to retry. There is no revoke-pending column to key
    //       on (the durable fix — a `revoking` state — is a separate ticket).
    //
    // Re-installing on "row active AND key absent" would, in case (b),
    // re-create the exact peer the owner just removed — silently reversing a
    // revoke of, say, a stolen phone, and re-persisting it into the router so
    // it survives the very reload that would have evicted it. So we re-install
    // ONLY on `setup.created === true`: the interface was genuinely (re)created
    // THIS tick, which is case (a) and only case (a). A missing peer with the
    // interface already up (case b, or a partial loss) is logged, never acted
    // on. The cost is that a peer lost without a full interface recreate is
    // not auto-restored here (it self-heals on the device's next profile fetch
    // / re-approval); that is the safe direction — never resurrect a revoke.
    if (missing.length > 0 && !result.interfaceCreated) {
      result.unreconciledMissing = missing.length;
      logger.warn(
        { iface: config.vpnInterface, missing: missing.length, held: held.size },
        "vpn: linked devices are missing from the interface but it was not recreated this tick — " +
          "treating as an in-flight revoke / partial state, NOT re-installing (WARP-2694/WARP-2686)",
      );
      return result;
    }

    if (result.interfaceCreated) {
      logger.warn(
        { iface: config.vpnInterface, activePeers: active.length },
        "vpn: wg interface was missing from the router and has been recreated (WARP-2694)",
      );
      // WARP-2694 — a recreated interface has a NEW server keypair, so the
      // clients' existing .conf files (which pin the OLD server public key)
      // cannot handshake even once their peer is back on the router. Say so;
      // do not let the re-install below read as full recovery.
      result.relinkRequired = true;
      logger.error(
        { iface: config.vpnInterface, activePeers: active.length },
        "vpn: wg interface was recreated with a NEW server key — linked devices must be re-added; " +
          "their existing configurations carry the previous key and will not reconnect on their own (WARP-2694)",
      );

      for (const row of missing) {
        // WARP-2686 — do not re-install a row a concurrent revoke has just
        // retired, even inside the wipe path.
        if (deps.isStillActive && !(await deps.isStillActive(row.publicKey))) {
          logger.warn(
            { publicKey: row.publicKey },
            "vpn: skipping re-install — row is no longer active (revoked concurrently)",
          );
          continue;
        }
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
          "vpn: re-installed linked devices onto the recreated interface (WARP-2694)",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "vpn: reconcile tick failed — will retry next tick");
  }
  return result;
}
