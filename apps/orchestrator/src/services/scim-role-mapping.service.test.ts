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
import { describe, it, expect, beforeEach } from "vitest";
import { config } from "../config.js";
import {
  roleForScimGroupName,
  highestRole,
  effectiveRoleForGroupNames,
  ROLE_PRIVILEGE,
  SCIM_ROLE_CEILING,
} from "./scim-role-mapping.service.js";

const setMap = (m: Record<string, string> | string) =>
  ((config as { SCIM_GROUP_ROLE_MAP: string }).SCIM_GROUP_ROLE_MAP = typeof m === "string" ? m : JSON.stringify(m));

beforeEach(() => {
  setMap({ "Droplet Owners": "owner", "Droplet Admins": "admin", Guests: "guest" });
});

describe("roleForScimGroupName — explicit, least-privilege-default policy (WARP-3631)", () => {
  it("CLAMPS a group the operator maps to owner to the ceiling — SCIM can never grant owner", () => {
    expect(roleForScimGroupName("Droplet Owners")).toBe("admin");
    expect(roleForScimGroupName("Droplet Owners")).toBe(SCIM_ROLE_CEILING);
  });

  it("the ceiling is `admin` (the documented WARP-1568 decision)", () => {
    expect(SCIM_ROLE_CEILING).toBe("admin");
  });

  it("maps a configured group by its whole name", () => {
    expect(roleForScimGroupName("Droplet Admins")).toBe("admin");
    expect(roleForScimGroupName("Guests")).toBe("guest");
  });

  it("never matches a substring: names containing admin, manager, owner or guest map to family", () => {
    for (const name of [
      "Sales Managers", "Store Managers", "Project Managers", "Administrators", "Administrative Assistants",
      "Badminton Club", "Homeowners Association", "Guest Services", "Droplet Admins Extra",
    ]) {
      expect(roleForScimGroupName(name), name).toBe("family");
    }
  });

  it("matches a configured SCIM group id ahead of the name", () => {
    setMap({ "00g1abc": "admin", Contractors: "guest" });
    expect(roleForScimGroupName("Contractors", "00g1abc")).toBe("admin");
    expect(roleForScimGroupName("Contractors", "other")).toBe("guest");
  });

  it("defaults ANY unconfigured group to least-privilege family, and so does an empty or bad map", () => {
    expect(roleForScimGroupName("Everyone")).toBe("family");
    expect(roleForScimGroupName("")).toBe("family");
    setMap("");
    expect(roleForScimGroupName("Droplet Admins")).toBe("family");
    setMap("not json");
    expect(roleForScimGroupName("Droplet Admins")).toBe("family");
    setMap({ "Droplet Admins": "superuser", Svc: "service" });
    expect(roleForScimGroupName("Droplet Admins")).toBe("family");
    expect(roleForScimGroupName("Svc")).toBe("family");
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(roleForScimGroupName("  DROPLET ADMINS  ")).toBe("admin");
  });

  it("NEVER maps ANY group name to `owner` or `service`, whatever the map says", () => {
    setMap({ A: "owner", B: "service", C: "admin" });
    for (const name of ["A", "B", "C", "D", ""]) {
      const role = roleForScimGroupName(name);
      expect(role, `"${name}" mapped to ${role}`).not.toBe("owner");
      expect(role).not.toBe("service");
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
