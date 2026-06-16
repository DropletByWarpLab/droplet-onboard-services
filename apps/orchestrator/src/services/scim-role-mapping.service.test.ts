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
 */
import { describe, it, expect } from "vitest";
import {
  roleForScimGroupName,
  highestRole,
  effectiveRoleForGroupNames,
  ROLE_PRIVILEGE,
} from "./scim-role-mapping.service.js";

describe("roleForScimGroupName — explicit, least-privilege-default policy", () => {
  it("maps admin-flavored group names to owner", () => {
    expect(roleForScimGroupName("Droplet Owners")).toBe("owner");
    expect(roleForScimGroupName("owners")).toBe("owner");
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
    expect(roleForScimGroupName("oWnErS")).toBe("owner");
  });

  it("NEVER maps any group to the internal `service` role", () => {
    // `service` is reserved for inbound service principals; SCIM must not be
    // able to mint one (privilege-shape confusion).
    expect(roleForScimGroupName("service")).not.toBe("service");
    expect(roleForScimGroupName("Service Accounts")).not.toBe("service");
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

  it("owner beats admin beats family beats guest", () => {
    expect(effectiveRoleForGroupNames(["Guests", "Managers", "Droplet Owners"])).toBe("owner");
  });
});
