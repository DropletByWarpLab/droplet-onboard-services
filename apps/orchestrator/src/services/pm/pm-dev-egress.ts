/**
 * The fetch the GitHub / GitLab development poll dials through (WARP-3535,
 * ADR-069 §9).
 *
 * ── Two layers, and why neither is enough alone ────────────────────────────
 *
 * The REST connector (`@droplet/erp-connector`, ADR-046) already guards every
 * request it makes: an exact registered host, https only, no redirect followed,
 * a `Link` URL a vendor hands back re-checked against the connection's own host.
 * That is WHERE a request may go. It has no owner switch — it cannot know that
 * the owner turned work data's off-LAN channel off — and it hands the hostname to
 * the runtime to resolve, which is the DNS-rebind window its own header
 * documents as open.
 *
 * This fetch is the other half, installed as the connector's `fetchImpl` (the
 * seam it was given for exactly this): the owner's `work_integrations` switch,
 * read IMMEDIATELY before each dial; the SSRF guard (resolve once, vet every
 * answer); and a socket held to the vetted address, with the original Host and
 * SNI and no redirect. The connector's guard runs first — a repository reference
 * it refuses never gets here — and this one runs on whatever it lets through.
 *
 * ── The switch ─────────────────────────────────────────────────────────────
 *
 * `work_integrations` is consulted for a destination that is NOT on the box's own
 * LAN, and only for those: a customer's LAN destination needs no switch (ADR-069
 * §9) but still passes the SSRF guard. With it off nothing is dialled, the
 * credential is never sent, and `blocked` says why so the sync can write
 * "Blocked by egress setting" and wait, instead of reporting an outage.
 *
 * Read-only by construction: any method but GET is refused. The connector it
 * serves cannot write either; this is the floor under that.
 */
import type { PrismaClient } from "@prisma/client";
import { pinnedGet } from "../../lib/outbound-pinned-fetch.js";
import {
  isOutboundUrlBlocked,
  resolvePinnedDestination,
  type PinnedDestination,
} from "../../lib/outbound-url-guard.js";
import { workIntegrationsGate } from "../off-lan-gate.service.js";
import { webhookLocalNetworkFacts } from "./webhook-local-network.js";

/** Why a request was refused BEFORE it was dialled. */
export type DevelopmentEgressBlock = "egress_switch_off" | "destination_not_allowed" | "unresolvable";

const BLOCK_MESSAGE: Record<DevelopmentEgressBlock, string> = {
  egress_switch_off: "blocked by the work_integrations egress setting",
  destination_not_allowed: "destination not allowed",
  unresolvable: "host could not be found",
};

/** Thrown when a dial is refused. The message is a fixed sentence: the operator
 *  detail of the SSRF guard (which address, which rule) never rides on it. */
export class DevelopmentEgressBlockedError extends Error {
  readonly code = "DEV_EGRESS_BLOCKED";
  constructor(readonly reason: DevelopmentEgressBlock) {
    super(BLOCK_MESSAGE[reason]);
    this.name = "DevelopmentEgressBlockedError";
  }
}

export interface DevelopmentFetchDeps {
  /** The SSRF guard. Tests that dial a loopback server replace it. */
  resolveDestination?: (url: string) => Promise<PinnedDestination>;
  /** The socket. */
  get?: typeof pinnedGet;
  /** `work_integrations`. Read before EVERY off-LAN dial. */
  gate?: () => Promise<boolean>;
}

export interface DevelopmentFetch {
  /** The connector's `fetchImpl`. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Why the most recent call was refused before it was dialled, or `null` if it
   * was not (it succeeded, or failed on the wire). The connector wraps every
   * thrown error as "could not be reached"; this is how the caller tells the
   * owner's switch from the network.
   */
  readonly blocked: DevelopmentEgressBlock | null;
}

/** `RequestInit.headers` in any of its three shapes, as a lowercase-keyed record
 *  when it came as a `Headers` or a list, untouched when it was already one. */
function headersOf(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init.map(([k, v]) => [k.toLowerCase(), v]));
  return { ...(init as Record<string, string>) };
}

/** A `Response` may not carry a body on these. */
const NULL_BODY = new Set([101, 204, 205, 304]);

export function createDevelopmentFetch(
  prisma: Pick<PrismaClient, "offLanAllowlistChannel">,
  deps: DevelopmentFetchDeps = {},
): DevelopmentFetch {
  const resolveDestination =
    deps.resolveDestination ?? ((url) => resolvePinnedDestination(url, { local: () => webhookLocalNetworkFacts() }));
  const get = deps.get ?? pinnedGet;
  const gate = deps.gate ?? (() => workIntegrationsGate(prisma));
  let blocked: DevelopmentEgressBlock | null = null;

  const refuse = (reason: DevelopmentEgressBlock): never => {
    blocked = reason;
    throw new DevelopmentEgressBlockedError(reason);
  };

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    blocked = null;
    if ((init.method ?? "GET").toUpperCase() !== "GET") {
      throw new Error("the development fetch is read-only: only GET is allowed");
    }

    // The SSRF guard. A guard that fails for ANY reason — including one that is
    // not its own refusal, like an unreadable interface list — refuses: "I could
    // not tell" must never resolve to "go ahead".
    let dest: PinnedDestination;
    try {
      dest = await resolveDestination(input);
    } catch (err) {
      return refuse(isOutboundUrlBlocked(err) && err.reason === "unresolvable" ? "unresolvable" : "destination_not_allowed");
    }

    // The owner's switch — off-LAN only, read right before the dial. A throw is a
    // refusal for the same reason.
    if (dest.scope === "public") {
      let open = false;
      try {
        open = await gate();
      } catch {
        open = false;
      }
      if (!open) return refuse("egress_switch_off");
    }

    const res = await get(dest, { headers: headersOf(init.headers), signal: init.signal ?? undefined });
    return new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status, headers: res.headers });
  };

  return {
    fetch: fetchImpl,
    get blocked() {
      return blocked;
    },
  };
}
