/**
 * WARP (SCIM directory sync) — group/role → local Role mapping policy.
 *
 * The local Role union is CLOSED: owner | admin | family | guest | service
 * (jwt.service.ts). SCIM groups arrive with arbitrary display names from
 * Okta; this policy maps a group name to the local Role it grants, and
 * computes a user's EFFECTIVE role as the highest-privilege role across all
 * the groups they belong to.
 *
 * Design choices under test:
 *   - Least privilege by DEFAULT: an unrecognized group → `family` (never an
 *     accidental owner/admin). `service` is NEVER assignable from SCIM (it's
 *     an internal principal role).
 *   - Case-insensitive, trimmed match on the group display name.
 *   - Highest-privilege-wins when a user is in several mapped groups.
 *   - WARP-1568: the mapping is CAPPED at SCIM_ROLE_CEILING (`admin`). An
 *     Okta group cannot grant `owner` — the pins asserting it could are
 *     rewritten below, deliberately: they documented the vulnerable
 *     behaviour, not a requirement.
 */
import { describe, it, expect } from "vitest";
import {
  roleForScimGroupName,
  highestRole,
  effectiveRoleForGroupNames,
  ROLE_PRIVILEGE,
  SCIM_ROLE_CEILING,
} from "./scim-role-mapping.service.js";

describe("roleForScimGroupName — explicit, least-privilege-default policy", () => {
  it("CLAMPS owner-flavored group names to the ceiling — SCIM can never grant owner", () => {
    // WARP-1568. "Droplet Owners" is the exact shape of the escalation: a
    // customer names an Okta group after ownership and the box hands the IdP
    // its root of trust. The name still resolves to the top of the ladder —
    // just the top of the SCIM-assignable ladder.
    expect(roleForScimGroupName("Droplet Owners")).toBe("admin");
    expect(roleForScimGroupName("owners")).toBe("admin");
    expect(roleForScimGroupName("Business Owners")).toBe("admin");
    expect(roleForScimGroupName("Droplet Owners")).toBe(SCIM_ROLE_CEILING);
  });

  it("the ceiling is `admin` (the documented WARP-1568 decision)", () => {
    expect(SCIM_ROLE_CEILING).toBe("admin");
  });

  it("maps manager/admin group names to admin", () => {
    expect(roleForScimGroupName("Droplet Admins")).toBe("admin");
    expect(roleForScimGroupName("Administrators")).toBe("admin");
    expect(roleForScimGroupName("Managers")).toBe("admin");
  });

  it("maps guest group names to guest", () => {
    expect(roleForScimGroupName("Guests")).toBe("guest");
    expect(roleForScimGroupName("Droplet Guest")).toBe("guest");
  });

  it("defaults ANY unrecognized group to least-privilege family", () => {
    expect(roleForScimGroupName("Everyone")).toBe("family");
    expect(roleForScimGroupName("Sales Team")).toBe("family");
    expect(roleForScimGroupName("")).toBe("family");
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(roleForScimGroupName("  DROPLET ADMINS  ")).toBe("admin");
    expect(roleForScimGroupName("oWnErS")).toBe("admin"); // clamped, WARP-1568
  });

  it("NEVER maps any group to the internal `service` role", () => {
    // `service` is reserved for inbound service principals; SCIM must not be
    // able to mint one (privilege-shape confusion).
    expect(roleForScimGroupName("service")).not.toBe("service");
    expect(roleForScimGroupName("Service Accounts")).not.toBe("service");
  });

  it("NEVER maps ANY group name to `owner`, whatever it is called", () => {
    // The sweep, not just the known keywords: no name the mapper accepts may
    // resolve above the ceiling.
    const names = [
      "Droplet Owners", "owner", "OWNER", "co-owners", "Owners and Admins",
      "Admins", "Managers", "Guests", "Everyone", "Sales Team", "",
      "service", "Homeowners Association",
    ];
    for (const name of names) {
      const role = roleForScimGroupName(name);
      expect(role, `"${name}" mapped to ${role}`).not.toBe("owner");
      expect(ROLE_PRIVILEGE[role]).toBeLessThanOrEqual(ROLE_PRIVILEGE[SCIM_ROLE_CEILING]);
    }
  });
});

describe("highestRole — privilege ordering", () => {
  it("orders owner > admin > family > guest", () => {
    expect(ROLE_PRIVILEGE.owner).toBeGreaterThan(ROLE_PRIVILEGE.admin);
    expect(ROLE_PRIVILEGE.admin).toBeGreaterThan(ROLE_PRIVILEGE.family);
    expect(ROLE_PRIVILEGE.family).toBeGreaterThan(ROLE_PRIVILEGE.guest);
  });

  it("returns the most-privileged of a set", () => {
    expect(highestRole(["guest", "owner", "family"])).toBe("owner");
    expect(highestRole(["guest", "family"])).toBe("family");
    expect(highestRole([])).toBe("family"); // empty → least privilege default
  });
});

describe("effectiveRoleForGroupNames — highest-privilege-wins across groups", () => {
  it("a user in Admins + Everyone lands on admin, not family", () => {
    expect(effectiveRoleForGroupNames(["Everyone", "Droplet Admins"])).toBe("admin");
  });

  it("a user in only unrecognized groups lands on family", () => {
    expect(effectiveRoleForGroupNames(["Everyone", "Sales Team"])).toBe("family");
  });

  it("no groups → family (least privilege)", () => {
    expect(effectiveRoleForGroupNames([])).toBe("family");
  });

  it("highest-privilege-wins, but never above the ceiling", () => {
    // Pre-WARP-1568 this returned "owner": one owner-named group among the
    // user's memberships was enough to hand Okta the box.
    expect(effectiveRoleForGroupNames(["Guests", "Managers", "Droplet Owners"])).toBe("admin");
    expect(effectiveRoleForGroupNames(["Guests", "Everyone"])).toBe("family");
  });
});
