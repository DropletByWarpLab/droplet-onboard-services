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

import { mayListArchivedZones, mayReadThreats, securityLevelFor, securityViewerScope } from "./security-access.js";
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
  it("passes the request's principal to the camera grant and composes the threat gate", async () => {
    const granted = new Set(["front"]);
    h.visible.mockResolvedValue(granted);
    const scope = await securityViewerScope({} as never, req("family"));
    expect(scope).toEqual({ visibleCameras: granted, mayReadThreats: false });
    expect(h.visible.mock.calls[0]![1]).toMatchObject({ id: "u-family", role: "family" });
  });

  it("an owner sees every camera and the threats", async () => {
    h.visible.mockResolvedValue("all");
    expect(await securityViewerScope({} as never, req("owner"))).toEqual({ visibleCameras: "all", mayReadThreats: true });
  });

  it("a grant lookup failure propagates (the route answers 503, never an unfiltered page)", async () => {
    h.visible.mockRejectedValue(new Error("db down"));
    await expect(securityViewerScope({} as never, req("family"))).rejects.toThrow("db down");
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
