/**
 * WARP-1636 — no Nextcloud-side group may mint an orchestrator session
 * above the holder's stored Droplet role.
 *
 * The escalation this pins closed (verified on `main`):
 *
 *   `buildNcGroups` (routes/auth-groups.ts) puts every owner/admin-tier
 *   Droplet user into Nextcloud's BUILT-IN `admin` group, i.e. they are
 *   full Nextcloud instance administrators. `roleFromGroups` then read
 *   that same group back as `owner` — the one tier ADR-032 §3 says
 *   bypasses layer 2 entirely — and the OCS auth fallback
 *   (middleware/auth.ts) minted the session straight from it.
 *
 *   So a contractor holding a deliberately-NARROWED Admin-based custom
 *   role (`User.role = "admin"`, files grant withheld) could authenticate
 *   against Nextcloud with the same credentials and come back holding an
 *   `owner` session. The RBAC v2 narrowing was bypassed by a group any
 *   Nextcloud administrator can grant themselves.
 *
 * The rail: `resolveNcSessionRole` caps the group-derived role at the
 * role Droplet's OWN store holds for that person. Groups may confirm or
 * narrow; they can never raise. Deleting the cap (returning
 * `roleFromGroups(groups)` unguarded) turns the first three tests here
 * red — that is the mutation test for the rail.
 */
import { describe, it, expect } from "vitest";

process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only-not-production";

import {
  resolveNcSessionRole,
  roleFromGroups,
  ROLE_RANK,
  type Role,
} from "./jwt.service.js";

describe("WARP-1636 — resolveNcSessionRole (NC groups may never raise a session)", () => {
  describe("the escalation, closed", () => {
    it("a NARROWED admin in Nextcloud's built-in admin group gets `admin`, never `owner`", () => {
      // The ticket's failure scenario, verbatim: a "Facilities Admin"
      // contractor at User.role="admin", provisioned into NC's `admin`
      // group by buildNcGroups, authenticating on the OCS fallback.
      expect(roleFromGroups(["admin"])).toBe("owner"); // the unguarded hint
      expect(resolveNcSessionRole(["admin"], "admin")).toBe("admin");
    });

    it("a family user drifted into the NC admin group stays `family`", () => {
      // Any Nextcloud instance administrator can add themselves — or
      // anyone else — to any group from NC's own user-management UI.
      // The store, not the group, decides what that is worth.
      expect(resolveNcSessionRole(["admin", "household"], "family")).toBe("family");
    });

    it("a guest drifted into the NC admin group stays `guest`", () => {
      expect(resolveNcSessionRole(["admin"], "guest")).toBe("guest");
    });
  });

  describe("no regression for correctly-provisioned users", () => {
    it("an owner in the NC admin group still gets `owner`", () => {
      // The cap is one-directional: it removes authority the store does
      // not back, and adds none. The owner's stored role is `owner`, so
      // the owner keeps an owner session on the OCS fallback.
      expect(resolveNcSessionRole(["admin", "droplet-admins", "household"], "owner")).toBe(
        "owner",
      );
    });

    it("a guest in the NC guest group gets `guest`", () => {
      expect(resolveNcSessionRole(["guest", "household"], "guest")).toBe("guest");
    });

    it("a family member with only the household group gets `family`", () => {
      expect(resolveNcSessionRole(["household"], "family")).toBe("family");
    });
  });

  describe("groups may still NARROW below the stored role", () => {
    it("an admin whose NC groups were stripped falls to the group-derived floor", () => {
      // Fail-safe direction. An operator who removed someone from every
      // role group in Nextcloud has expressed less access, not more, and
      // the cap must not undo that.
      expect(resolveNcSessionRole([], "admin")).toBe("family");
      expect(resolveNcSessionRole(["guest"], "owner")).toBe("guest");
    });
  });

  describe("the cap is exactly the rank ladder", () => {
    const ROLES: Role[] = ["service", "guest", "family", "admin", "owner"];

    it("never returns a role outranking the stored role, for any pair", () => {
      // Exhaustive over the Role union × the recognised group vocabulary:
      // whatever the groups say, the result can never outrank the store.
      const groupSets = [
        [],
        ["admin"],
        ["staff"],
        ["guest"],
        ["droplet-admins"],
        ["admin", "staff", "guest"],
        ["random-group"],
      ];
      for (const stored of ROLES) {
        for (const groups of groupSets) {
          const resolved = resolveNcSessionRole(groups, stored);
          expect(ROLE_RANK[resolved]).toBeLessThanOrEqual(ROLE_RANK[stored]);
        }
      }
    });

    it("never returns a role outranking what the groups themselves derive", () => {
      // The other half of "cap": it may not INVENT authority either —
      // a stored owner does not get owner out of a `guest` group.
      const groupSets = [[], ["admin"], ["staff"], ["guest"], ["random-group"]];
      for (const stored of ROLES) {
        for (const groups of groupSets) {
          const resolved = resolveNcSessionRole(groups, stored);
          expect(ROLE_RANK[resolved]).toBeLessThanOrEqual(
            ROLE_RANK[roleFromGroups(groups)],
          );
        }
      }
    });
  });
});
