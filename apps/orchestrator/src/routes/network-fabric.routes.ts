/**
 * Network-fabric inventory routes (WARP-1732, ADR-035 §5).
 *
 *   GET /network/fabric/members → { members: [...] }
 *
 * A read over the `FabricMember` rows the reconciler persists — the edge
 * router, the switch, each AP, and whatever role ships next, each with the
 * anchor MAC that ADR-035 §2 makes their identity plus the last address,
 * version, and PoE facts they announced.
 *
 * **Read-only, and read-only all the way down.** There is no write verb in
 * this module and no device dispatch behind it: the handler serves rows
 * from Postgres and never touches the routing service, so a browser refresh
 * cannot reach a router, switch, or AP. Freshness comes from
 * `lastSeen` — a caller can see a member has gone stale (ADR-035 §6) rather
 * than watching it disappear, which is exactly the property the reconciler's
 * never-delete rule buys.
 *
 * **Auth**: no per-route role gate, matching every other network READ
 * (`/network/status`, `/network/interfaces`, `/network/topology`, and
 * `/api/aps`) — those are open to any authenticated principal so the LLM
 * agent's network tools work under the `service` role. That posture is safe
 * only because `app.ts` mounts the global `authMiddleware` BEFORE
 * `createNetworkRouter`, so an unauthenticated request never reaches here;
 * `network-fabric.routes.test.ts` mounts the production middleware and
 * pins that 401.
 */
import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";

export interface FabricDeps {
  prisma: PrismaClient;
}

export function registerFabricRoutes(router: Router, deps: FabricDeps): void {
  const { prisma } = deps;

  router.get("/network/fabric/members", async (_req, res, next) => {
    try {
      // Most-recently-seen first: the fabric's live members lead, anything
      // that has gone quiet sinks to the bottom where its `lastSeen` reads
      // as the answer to "when did we last hear from it".
      const members = await prisma.fabricMember.findMany({
        orderBy: { lastSeen: "desc" },
      });
      // Rows are already the domain shape (camelCase, PoE as nullable ints),
      // so there is nothing to map — serving them verbatim keeps one
      // definition of the contract instead of a hand-copied second one.
      res.json({ members });
    } catch (err) {
      next(err);
    }
  });
}
