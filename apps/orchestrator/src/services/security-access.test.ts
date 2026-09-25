/**
 * WARP-2977 P2b — the one place Security visibility is decided.
 *
 * `mayReadThreats` moved here from routes/security.ts unchanged (role-based:
 * owner/admin only), and `securityViewerScope` composes it with the camera
 * grant so every Security surface asks one function.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

const h = vi.hoisted(() => ({ visible: vi.fn() }));
vi.mock("./camera-access.service.js", () => ({
  principalFromRequest: (req: { user?: { id?: string; role?: string } }) => ({
    id: req.user?.id,
    role: req.user?.role,
    assertedUser: null,
  }),
  visibleCameraNames: h.visible,
}));

import {
  mayListArchivedZones,
  mayReadLocksFor,
  mayReadThreats,
  securityLevelFor,
  securityViewerScope,
} from "./security-access.js";
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import type { EffectiveAccessResult } from "./effective-access.service.js";

/** Only `features` is read on this path. */
const resolved = (features: Array<{ moduleId: string; level: "view" | "act" | "manage" }>) =>
  ({ features }) as unknown as EffectiveAccessResult;

const req = (role?: string) => ({ user: role ? { id: `u-${role}`, username: role, role } : undefined }) as unknown as Request;

// Braces matter: a function RETURNED from beforeEach is run as its teardown.
beforeEach(() => {
  h.visible.mockReset();
});

describe("mayReadThreats", () => {
  it("owner and admin only", () => {
    expect(mayReadThreats(req("owner"))).toBe(true);
    expect(mayReadThreats(req("admin"))).toBe(true);
    expect(mayReadThreats(req("family"))).toBe(false);
    expect(mayReadThreats(req("guest"))).toBe(false);
    expect(mayReadThreats(req("service"))).toBe(false);
    expect(mayReadThreats(req())).toBe(false);
  });
});

describe("securityViewerScope", () => {
  /** No local User row: nothing narrows, so the role decides (the AUTH_ENABLED=false session). */
  const unresolved = vi.fn(async () => null);

  it("passes the request's principal to the camera grant and composes the threat and lock gates", async () => {
    const granted = new Set(["front"]);
    h.visible.mockResolvedValue(granted);
    const scope = await securityViewerScope({} as never, req("family"), unresolved);
    expect(scope).toEqual({ visibleCameras: granted, mayReadThreats: false, mayReadLocks: false });
    expect(h.visible.mock.calls[0]![1]).toMatchObject({ id: "u-family", role: "family" });
  });

  it("an owner sees every camera, the threats and the locks", async () => {
    h.visible.mockResolvedValue("all");
    expect(await securityViewerScope({} as never, req("owner"), unresolved)).toEqual({
      visibleCameras: "all",
      mayReadThreats: true,
      mayReadLocks: true,
    });
  });

  it("a family member granted Devices (smart_home) at view reads locks through the scope", async () => {
    h.visible.mockResolvedValue(new Set());
    const resolve = vi.fn(async () => resolved([{ moduleId: "smart_home", level: "view" }]));
    expect((await securityViewerScope({} as never, req("family"), resolve)).mayReadLocks).toBe(true);
    expect(resolve).toHaveBeenCalledWith("u-family");
  });

  it("a grant lookup failure propagates (the route answers 503, never an unfiltered page)", async () => {
    h.visible.mockRejectedValue(new Error("db down"));
    await expect(securityViewerScope({} as never, req("family"), unresolved)).rejects.toThrow("db down");
  });
});

describe("mayReadLocksFor (WARP-2977 P2b-2, DS-019) — Security view AND Devices (smart_home) view", () => {
  it("smart_home at any level → true; the owner's resolved catalog holds it (the §3 bypass)", async () => {
    for (const level of ["view", "act", "manage"] as const) {
      const resolve = vi.fn(async () => resolved([{ moduleId: "security", level: "view" }, { moduleId: "smart_home", level }]));
      expect(await mayReadLocksFor(req("family"), resolve), level).toBe(true);
    }
  });

  it("resolved without smart_home → false for EVERY role — an admin narrowed off Devices included", async () => {
    for (const role of ["owner", "admin", "family"]) {
      const resolve = vi.fn(async () => resolved([{ moduleId: "security", level: "manage" }, { moduleId: "cameras", level: "manage" }]));
      expect(await mayReadLocksFor(req(role), resolve), role).toBe(false);
    }
  });

  it("unresolved (no local row) fails closed to owner/admin", async () => {
    const resolve = vi.fn(async () => null);
    expect(await mayReadLocksFor(req("owner"), resolve)).toBe(true);
    expect(await mayReadLocksFor(req("admin"), resolve)).toBe(true);
    expect(await mayReadLocksFor(req("family"), resolve)).toBe(false);
    expect(await mayReadLocksFor(req("guest"), resolve)).toBe(false);
  });

  it("no principal, or a service principal: nothing to resolve, and neither is owner/admin → false", async () => {
    const untouched = vi.fn(async () => resolved([{ moduleId: "smart_home", level: "manage" }]));
    expect(await mayReadLocksFor(req(), untouched)).toBe(false);
    expect(await mayReadLocksFor(req("service"), untouched)).toBe(false);
    expect(untouched).not.toHaveBeenCalled();
  });

  it("shares the per-request memo with the feature gate — one resolver read per request", async () => {
    const resolve = vi.fn(async () => resolved([{ moduleId: "security", level: "view" }, { moduleId: "smart_home", level: "view" }]));
    const r = req("family");
    const gate = requireFeatureAccess("security", "view", resolve);
    await new Promise<void>((done) => void gate(r, {} as never, () => done()));
    expect(await mayReadLocksFor(r, resolve)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("a resolver failure rejects (the route answers 503; it never guesses)", async () => {
    await expect(mayReadLocksFor(req("admin"), vi.fn(async () => Promise.reject(new Error("db down"))))).rejects.toThrow(
      "db down",
    );
  });
});

describe("securityLevelFor (route 3's include=archived)", () => {
  it("returns the security entry's resolved level, resolving the request's user", async () => {
    for (const level of ["view", "act", "manage"] as const) {
      const resolve = vi.fn(async () => resolved([{ moduleId: "cameras", level: "manage" }, { moduleId: "security", level }]));
      expect(await securityLevelFor(req("admin"), resolve)).toBe(level);
      expect(resolve).toHaveBeenCalledWith("u-admin");
    }
  });

  it("'none' when resolved without a security entry — never mistaken for unresolved", async () => {
    const resolve = vi.fn(async () => resolved([{ moduleId: "cameras", level: "manage" }]));
    expect(await securityLevelFor(req("admin"), resolve)).toBe("none");
  });

  it("null when there is nothing to resolve: no local row, no principal, a service principal", async () => {
    expect(await securityLevelFor(req("admin"), vi.fn(async () => null))).toBeNull();
    const untouched = vi.fn(async () => resolved([{ moduleId: "security", level: "manage" }]));
    expect(await securityLevelFor(req(), untouched)).toBeNull();
    expect(await securityLevelFor(req("service"), untouched)).toBeNull();
    expect(untouched).not.toHaveBeenCalled();
  });

  it("shares the per-request memo with the feature gate — one resolver read per request", async () => {
    const resolve = vi.fn(async () => resolved([{ moduleId: "security", level: "manage" }]));
    const r = req("admin");
    const gate = requireFeatureAccess("security", "view", resolve);
    await new Promise<void>((done) => void gate(r, {} as never, () => done()));
    expect(await securityLevelFor(r, resolve)).toBe("manage");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("a resolver failure rejects (the route answers 503; it never guesses a level)", async () => {
    await expect(securityLevelFor(req("admin"), vi.fn(async () => Promise.reject(new Error("db down"))))).rejects.toThrow(
      "db down",
    );
  });
});

describe("mayListArchivedZones", () => {
  it("owner/admin at manage, or with no per-person level at all (null)", () => {
    for (const role of ["owner", "admin"]) {
      expect(mayListArchivedZones(req(role), "manage"), role).toBe(true);
      expect(mayListArchivedZones(req(role), null), role).toBe(true);
    }
  });

  it("never below manage, never 'none', never for other roles — whatever the level says", () => {
    for (const role of ["owner", "admin"]) {
      for (const level of ["view", "act", "none"] as const) {
        expect(mayListArchivedZones(req(role), level), `${role}/${level}`).toBe(false);
      }
    }
    for (const role of ["family", "guest", "service", undefined]) {
      for (const level of ["view", "act", "manage", "none", null] as const) {
        expect(mayListArchivedZones(req(role), level), `${String(role)}/${String(level)}`).toBe(false);
      }
    }
  });
});
