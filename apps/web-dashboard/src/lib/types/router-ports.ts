/**
 * Router physical-port contract (WARP-1866).
 *
 * The router's counterpart to `types/switch.ts` — same idea, different device.
 * Deliberately NOT the same type: a router jack has no PoE and no per-port
 * VLAN membership, and it has an `absent` state the switch contract has no
 * word for (see `status` below). Sharing one type would mean carrying dead
 * fields on both sides and a `null` that means two different things.
 *
 * Served by GET /api/network/ports; derived in services/routing/router_ports.py,
 * which is where the honesty rules are documented and tested.
 */

/**
 * What the jack is wired to. `unused` is a real, useful answer — the RB5009's
 * SFP cage is a physical port no interface claims. `other` is an interface we
 * have no vocabulary for, reported rather than guessed at.
 */
export type RouterPortRole = "wan" | "lan" | "guest" | "other" | "unused";

/**
 * `online`   — carrier: something is plugged in and the link is up.
 * `offline`  — the jack is enabled and empty.
 * `disabled` — an operator brought the jack down.
 * `absent`   — no reading at all. An empty SFP cage reports no netifd device,
 *              and "we couldn't measure this" is not the same claim as "this
 *              is down" — the panel renders them differently on purpose.
 */
export type RouterPortStatus = "online" | "offline" | "disabled" | "absent";

export interface RouterPortTraffic {
  rx_bytes: number;
  tx_bytes: number;
}

/**
 * WARP-1907 — why turning THIS jack off needs a second acknowledgement.
 *
 * `WAN_PORT` and `MANAGEMENT_PORT` are not two wordings of one warning; they
 * differ on the fact the user is about to rely on. Cutting a live management
 * jack severs the routing service's own path to the router, so its safe-apply
 * probe fails and OpenWrt restores the old config after a minute. Cutting the
 * WAN leaves the router perfectly reachable on the LAN — the probe succeeds,
 * the change is confirmed, and the house stays offline until somebody puts it
 * back by hand.
 *
 * `reason` is WHY, rendered verbatim — the dashboard cannot derive it, because
 * which interfaces count as management is deployment configuration
 * (`DROPLET_MGMT_INTERFACES`). `instruction` is what to DO about it, kept as a
 * separate field because the drawer shows the reason as a warning before the
 * user has been asked to confirm anything, and "confirm again" there is an
 * instruction to do something nobody has requested.
 */
export interface RouterPortDisableGuard {
  code: "WAN_PORT" | "MANAGEMENT_PORT";
  reason: string;
  instruction?: string;
}

export interface RouterPort {
  /** netdev name — "p1", "sfp", "eth0". Stable identity and the mono label. */
  id: string;
  role: RouterPortRole;
  /** uci interfaces whose traffic reaches this jack, in config order. A bridge
   *  member carries `lan` AND any VLAN riding the bridge (e.g. `guest`). */
  networks: string[];
  present: boolean;
  /**
   * Admin state. NEVER the link indicator: on a DSA switch port this is true
   * for every jack whether or not a cable is in it — the live RB5009 reports
   * `admin_up: true` on five empty ports. Read `link_up`.
   */
  admin_up: boolean | null;
  link_up: boolean;
  speed: string | null;
  duplex: "full" | "half" | null;
  mac: string | null;
  is_sfp: boolean;
  traffic: RouterPortTraffic | null;
  status: RouterPortStatus;
  /** `null` when an ordinary confirm is enough to turn this jack off. */
  disable_guard: RouterPortDisableGuard | null;
}

/** GET /api/network/ports */
export interface RouterPortMap {
  /** `false` = this router shape reports no physical port map; `detail` says
   *  why. Distinct from an unreachable router, which is an error. */
  supported: boolean;
  detail: string | null;
  model: string | null;
  ports: RouterPort[];
}
