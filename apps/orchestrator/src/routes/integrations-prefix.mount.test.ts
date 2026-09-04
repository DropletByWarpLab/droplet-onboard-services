/**
 * WARP-2485 — the `/api/integrations` prefix is shared by more than one
 * router, so "which router answers this URL?" is decided by mount order in
 * `app.ts`. That made the mount-order comment there load-bearing, and it was
 * wrong: it claimed the SaaS credential router is mounted *after* the ERP
 * router, while the mount that name most obviously points at sits below it.
 *
 * The comment's real claim was never about order at all — it was that the
 * routers' paths do not overlap, which is what makes order irrelevant. This
 * file checks that claim instead of restating it.
 *
 * Two levels, because they fail differently:
 *
 *  1. No two routers register the SAME method+path. An exact duplicate makes
 *     the later mount permanently unreachable — dead code that still reads
 *     like a live route.
 *  2. No two routers register patterns that a single concrete URL could match.
 *     This is the one that matters: `GET /integrations/:id` on the Eaglesoft
 *     router and `GET /integrations/credentials` on the credential router are
 *     different strings, but the first swallows the second.
 *
 * Nothing is mocked but `config` — the routers ARE the subject, and
 * `router.stack` is read off the real Express instances the app mounts.
 *
 * When PR #1829 (WARP-2463) lands it adds a third router under this prefix,
 * `createErpDriftRouter` (`/integrations/drift/:connectionId`). Add it to
 * ROUTERS below. It overlaps `/integrations/:provider/credentials` on the
 * single URL `/integrations/drift/credentials`, so that change must either
 * make the patterns disjoint or record the exception here deliberately —
 * which is exactly the decision this file exists to force into the open.
 */
import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createIntegrationsRouter } from "./integrations.js";
import { createSaasCredentialsRouter } from "./saas-credentials.js";
import { createErpRouter } from "./erp.js";
// WARP-2500 — the third router under this prefix, which the header above asks
// the lander of PR #1829 to add. It is here now because WARP-2500 introduces
// the first `/integrations/:provider/<verb>` patterns, and `:provider` is
// exactly the shape that could swallow `/integrations/:connectionId/drift`.
// Enumerating it is what turns "they don't overlap" from a claim into a check.
import { createErpDriftRouter } from "./erp-drift.js";

/** None of these factories touch Prisma while registering routes; the stub is
 *  only here so the constructors get the shape they expect. */
const prisma = { integrationConnection: { findFirst: vi.fn() } } as never;

const ROUTERS: ReadonlyArray<{ name: string; router: Router }> = [
  { name: "createIntegrationsRouter", router: createIntegrationsRouter(prisma) },
  { name: "createSaasCredentialsRouter", router: createSaasCredentialsRouter(prisma) },
  { name: "createErpRouter", router: createErpRouter(prisma) },
  { name: "createErpDriftRouter", router: createErpDriftRouter(prisma) },
];

interface Registered {
  readonly owner: string;
  readonly method: string;
  readonly path: string;
  readonly segments: readonly string[];
}

/**
 * Express 4 keeps one `Layer` per `router.METHOD(path, ...)` call, each with a
 * `route` carrying the literal path string and a method map.
 *
 * The path is asserted to be a plain, metacharacter-free string: the overlap
 * check below compares patterns segment by segment, and a RegExp, an array of
 * paths, or a `*`/`?`/`+`/`()` pattern would silently make that comparison
 * under-approximate — reporting "disjoint" for routes that are not. Failing
 * loudly here is the difference between an invariant and a wish.
 */
function registeredRoutes(owner: string, router: Router): Registered[] {
  const stack = (router as unknown as { stack: unknown[] }).stack;
  const out: Registered[] = [];
  for (const layer of stack) {
    const route = (
      layer as { route?: { path: unknown; methods: Record<string, boolean> } }
    ).route;
    if (!route) continue;
    const path = route.path;
    if (typeof path !== "string") {
      throw new Error(
        `${owner} registers a non-string path (${String(path)}); this test cannot compare it`,
      );
    }
    if (/[*?+()[\]]/.test(path)) {
      throw new Error(
        `${owner} registers the pattern "${path}"; segment comparison would under-approximate it`,
      );
    }
    for (const method of Object.keys(route.methods)) {
      out.push({ owner, method, path, segments: path.split("/") });
    }
  }
  return out;
}

/** Two patterns can be matched by one URL when they have the same shape and
 *  every position agrees — a `:param` agreeing with anything. */
function canCollide(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(":") || b[i].startsWith(":") || seg === b[i]);
}

/** A concrete URL both patterns would match — so a failure names the request
 *  that breaks, not just the two patterns. */
function collidingUrl(a: readonly string[], b: readonly string[]): string {
  return a
    .map((seg, i) => {
      if (!seg.startsWith(":")) return seg;
      return b[i].startsWith(":") ? `<${seg.slice(1)}>` : b[i];
    })
    .join("/");
}

const ROUTES = ROUTERS.flatMap(({ name, router }) => registeredRoutes(name, router));

/** Every cross-router, same-method pair — the only pairs mount order can
 *  arbitrate between. Same-router pairs are ordered inside their own file. */
const PAIRS = ROUTES.flatMap((a, i) =>
  ROUTES.slice(i + 1)
    .filter((b) => b.owner !== a.owner && b.method === a.method)
    .map((b) => [a, b] as const),
);

describe("routers sharing the /api/integrations prefix", () => {
  /**
   * Guards against a vacuous pass. If a factory were refactored to register
   * nothing — or this file's stack reader stopped matching Express's shape —
   * every assertion below would pass over an empty set and say nothing.
   */
  it("enumerates the routes the app actually mounts", () => {
    const byOwner = (name: string) =>
      ROUTES.filter((r) => r.owner === name).map((r) => `${r.method} ${r.path}`);

    expect(byOwner("createIntegrationsRouter")).toEqual(
      expect.arrayContaining([
        "get /integrations",
        "get /integrations/eaglesoft",
        // WARP-2500 — the provider-scoped lifecycle verbs. Pinned by NAME as
        // well as swept by the pairwise checks below: the sweep can only find
        // a collision among routes that exist, so a refactor that dropped
        // these would make the disjointness checks pass by having nothing
        // left to collide.
        "post /integrations/:provider/disconnect",
        "post /integrations/:provider/write-enable",
        "post /integrations/:provider/write-disable",
        // WARP-2520 — the LAN provisioning verbs, parameterised for the same
        // reason and pinned by name for the same reason.
        "post /integrations/:provider/connect",
        "post /integrations/:provider/test",
        // The deprecated Eaglesoft literal aliases, kept for one release.
        // Listed so their eventual REMOVAL is a deliberate edit to this
        // expectation rather than a silent deletion nothing notices.
        "post /integrations/eaglesoft/disconnect",
        "post /integrations/eaglesoft/write-enable",
        "post /integrations/eaglesoft/write-disable",
        "post /integrations/eaglesoft/connect",
        "post /integrations/eaglesoft/test",
      ]),
    );
    expect(byOwner("createErpDriftRouter")).toEqual([
      "get /integrations/:connectionId/drift",
    ]);
    expect(byOwner("createSaasCredentialsRouter")).toEqual(
      expect.arrayContaining([
        "get /integrations/credentials",
        "get /integrations/:provider/credentials",
        "patch /integrations/:provider/credentials",
      ]),
    );
    expect(byOwner("createErpRouter")).toEqual(
      expect.arrayContaining(["get /erp/schedule"]),
    );
    expect(PAIRS.length).toBeGreaterThan(0);
  });

  it("registers no method+path twice, so no mount is unreachable", () => {
    const duplicates = PAIRS.filter(([a, b]) => a.path === b.path).map(
      ([a, b]) => `${a.method.toUpperCase()} ${a.path} — ${a.owner} and ${b.owner}`,
    );
    expect(duplicates).toEqual([]);
  });

  it("registers no two patterns one URL could match, so mount order cannot shadow", () => {
    const collisions = PAIRS.filter(([a, b]) => canCollide(a.segments, b.segments)).map(
      ([a, b]) =>
        `${a.method.toUpperCase()} ${collidingUrl(a.segments, b.segments)} matches ` +
        `${a.owner}'s "${a.path}" and ${b.owner}'s "${b.path}"`,
    );
    expect(collisions).toEqual([]);
  });

  /**
   * WARP-2500 — the specific shadow this ticket had to rule out, named.
   *
   * The sweep above is method-scoped: it only pairs routes that share a verb,
   * because that is all mount order can arbitrate. That is correct for
   * "which handler serves this request", and NOT enough for this ticket's
   * acceptance criterion, which is that `:provider` must not shadow
   * `credentials` or `drift` — a property that has to survive somebody later
   * adding `POST /integrations/:provider/credentials`.
   *
   * So this checks the stronger, method-BLIND property for the three new
   * patterns: no concrete URL matches one of them and one of the neighbours'
   * routes, whatever the verb. It holds because the parameter sits in the
   * MIDDLE and the last segment is a literal, and no URL ends in two
   * different literals at once.
   *
   * The set under test is DISCOVERED — every parameterised route this router
   * registers — rather than a hardcoded list of the three. A hardcoded list
   * would make any rename fail the list check before the collision check ever
   * ran, so the collision check itself would never be shown to work.
   *
   * Mutation: change `/integrations/:provider/disconnect`'s last segment to
   * `credentials`. All three parameterised routes are still registered, so the
   * non-vacuity guard below still passes, and the method-scoped sweep above
   * stays green because the credential routes are GET/PATCH and this one is
   * POST. This test goes red, naming `/integrations/<provider>/credentials` as
   * the URL that now matches two routers — which is the real-world failure:
   * a POST to it would reach the ERP router, and a later attempt to add
   * `POST /integrations/:provider/credentials` would be dead on arrival.
   */
  it("keeps :provider from shadowing credentials or drift, in ANY method", () => {
    const mine = ROUTES.filter(
      (r) =>
        r.owner === "createIntegrationsRouter" &&
        r.segments.some((s) => s.startsWith(":")),
    );
    // Not vacuous: the parameterised routes must actually exist. Five paths
    // (WARP-2500's three lifecycle verbs plus WARP-2520's two LAN provisioning
    // verbs), whatever they are called — the point is that the sweep below has
    // real patterns to work on, not that they still have the names above.
    expect(new Set(mine.map((r) => r.path)).size).toBe(5);

    const neighbours = ROUTES.filter((r) => r.owner !== "createIntegrationsRouter");
    expect(neighbours.length).toBeGreaterThan(0);

    const shadowed = mine.flatMap((a) =>
      neighbours
        .filter((b) => canCollide(a.segments, b.segments))
        .map(
          (b) =>
            `${collidingUrl(a.segments, b.segments)} matches "${a.path}" and ` +
            `${b.owner}'s "${b.path}"`,
        ),
    );
    expect(shadowed).toEqual([]);
  });
});
