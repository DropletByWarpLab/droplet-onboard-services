/**
 * WARP-1294 — the API route-map ships controller/method names only; verbs,
 * templates and field-maps are DISCOVERED from the box /help page, never
 * hardcoded guesses. These tests pin that: every registry op has a slot, no
 * baked verb/template exists, and an undiscovered route refuses to resolve.
 */
import { describe, it, expect } from "vitest";
import {
  KNOWN_ROUTE_SKELETON,
  requiredRouteOps,
  isRouteDiscovered,
  routeMapFingerprint,
  resolveReadRoute,
  RouteNotDiscoveredError,
  type RouteSpec,
} from "../src/api-route-map.js";

describe("api-route-map skeleton", () => {
  it("has a slot for every read + write registry op and for authenticate", () => {
    const req = requiredRouteOps();
    for (const name of req.reads) expect(KNOWN_ROUTE_SKELETON.reads[name]).toBeDefined();
    for (const name of req.writes) expect(KNOWN_ROUTE_SKELETON.writes[name]).toBeDefined();
    expect(KNOWN_ROUTE_SKELETON.authenticate.controller).toBe("Authentication");
    expect(KNOWN_ROUTE_SKELETON.authenticate.method).toBe("Authenticate");
  });

  it("ships NO baked verb or template (routes are discovered, never guessed)", () => {
    const specs: RouteSpec[] = [
      KNOWN_ROUTE_SKELETON.authenticate,
      ...Object.values(KNOWN_ROUTE_SKELETON.reads),
      ...Object.values(KNOWN_ROUTE_SKELETON.writes),
    ];
    for (const s of specs) {
      expect(s.verb).toBeUndefined();
      expect(s.template).toBeUndefined();
      expect(isRouteDiscovered(s)).toBe(false);
    }
  });

  it("resolving an undiscovered route throws RouteNotDiscoveredError", () => {
    expect(() => resolveReadRoute(KNOWN_ROUTE_SKELETON, "get_schedule_today")).toThrow(
      RouteNotDiscoveredError,
    );
  });

  it("fingerprint is a stable 16-hex digest that changes when a route is discovered", () => {
    const fp1 = routeMapFingerprint(KNOWN_ROUTE_SKELETON);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    expect(routeMapFingerprint(KNOWN_ROUTE_SKELETON)).toBe(fp1); // stable
    const discovered = {
      ...KNOWN_ROUTE_SKELETON,
      reads: {
        ...KNOWN_ROUTE_SKELETON.reads,
        get_schedule_today: {
          ...KNOWN_ROUTE_SKELETON.reads.get_schedule_today,
          verb: "GET" as const,
          template: "/api/schedule/range",
        },
      },
    };
    expect(routeMapFingerprint(discovered)).not.toBe(fp1); // drift-sensitive
  });
});
