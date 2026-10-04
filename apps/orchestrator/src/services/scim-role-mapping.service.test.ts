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
  setMap({ "id:g-owners": "owner", "id:g-admins": "admin", "name:Guests": "guest" });
});

describe("roleForScimGroupName — explicit, least-privilege-default policy (WARP-3631)", () => {
  it("CLAMPS a group the operator maps to owner to the ceiling — SCIM can never grant owner", () => {
    expect(roleForScimGroupName("Droplet Owners", "g-owners")).toBe("admin");
    expect(roleForScimGroupName("Droplet Owners", "g-owners")).toBe(SCIM_ROLE_CEILING);
  });

  it("the ceiling is `admin` (the documented WARP-1568 decision)", () => {
    expect(SCIM_ROLE_CEILING).toBe("admin");
  });

  it("elevates only by the stable group id", () => {
    expect(roleForScimGroupName("Whatever It Is Called Today", "g-admins")).toBe("admin");
  });

  it("never matches a substring: names containing admin, manager or owner map to family", () => {
    for (const name of [
      "Sales Managers", "Store Managers", "Project Managers", "Administrators", "Administrative Assistants",
      "Badminton Club", "Homeowners Association", "Droplet Admins", "Droplet Admins Extra",
    ]) {
      expect(roleForScimGroupName(name), name).toBe("family");
      expect(roleForScimGroupName(name, "unknown-id"), name).toBe("family");
    }
  });

  it("keeps the namespaces apart: a display name equal to a configured id, or an id equal to a configured name, elevates nothing", () => {
    expect(roleForScimGroupName("g-admins")).toBe("family");
    expect(roleForScimGroupName("g-admins", "other-id")).toBe("family");
    expect(roleForScimGroupName("anything", "Guests")).toBe("family");
  });

  it("a name: entry can only lower to guest; an elevating name: entry is ignored", () => {
    setMap({ "name:Droplet Admins": "admin", "name:Contractors": "guest", "name:Staff": "family" });
    expect(roleForScimGroupName("Droplet Admins")).toBe("family");
    expect(roleForScimGroupName("Contractors")).toBe("guest");
    expect(roleForScimGroupName("Staff")).toBe("family");
  });

  it("ids match exactly (case-sensitive); bare keys without id: or name: are ignored", () => {
    setMap({ "id:00gAbC": "admin", "00gXyz": "admin", "Droplet Admins": "admin" });
    expect(roleForScimGroupName("g", "00gAbC")).toBe("admin");
    expect(roleForScimGroupName("g", "00gabc")).toBe("family");
    expect(roleForScimGroupName("g", "00gXyz")).toBe("family");
    expect(roleForScimGroupName("Droplet Admins")).toBe("family");
  });

  it("folds names with NFKC then lower case, so compatibility look-alikes match the configured guest name", () => {
    setMap({ "name:Contractors": "guest" });
    expect(roleForScimGroupName("  ＣＯＮＴＲＡＣＴＯＲＳ ")).toBe("guest");
    // A Cyrillic look-alike is a different name and does not match.
    expect(roleForScimGroupName("Contrаctors")).toBe("family");
  });

  it("a group whose name contains 'guest' stays guest with NO map configured, and never gets more than guest", () => {
    setMap("");
    for (const name of ["Guests", "Droplet Guest", "External Guests", "Guest Services", "VISITING GUESTS", "Guest Admins", "ＧＵＥＳＴ"]) {
      const role = roleForScimGroupName(name);
      expect(role, name).toBe("guest");
      expect(ROLE_PRIVILEGE[role]).toBeLessThanOrEqual(ROLE_PRIVILEGE.guest);
    }
    // …and a name key or a bad map does not change that.
    setMap("not json");
    expect(roleForScimGroupName("External Guests")).toBe("guest");
  });

  it("defaults ANY unconfigured group to least-privilege family, and so does an empty or bad map", () => {
    expect(roleForScimGroupName("Everyone")).toBe("family");
    expect(roleForScimGroupName("")).toBe("family");
    setMap("");
    expect(roleForScimGroupName("Droplet Admins", "g-admins")).toBe("family");
    setMap("not json");
    expect(roleForScimGroupName("Droplet Admins", "g-admins")).toBe("family");
    setMap({ "id:g-admins": "superuser", "id:svc": "service" });
    expect(roleForScimGroupName("Droplet Admins", "g-admins")).toBe("family");
    expect(roleForScimGroupName("Svc", "svc")).toBe("family");
  });

  it("NEVER maps ANY group to `owner` or `service`, whatever the map says", () => {
    setMap({ "id:a": "owner", "id:b": "service", "id:c": "admin" });
    for (const id of ["a", "b", "c", "d"]) {
      const role = roleForScimGroupName("x", id);
      expect(role, id).not.toBe("owner");
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
  it("name-only lookup never raises a user above family", () => {
    expect(effectiveRoleForGroupNames(["Everyone", "Droplet Admins", "Contractors"])).toBe("family");
  });

  it("a user in only unrecognized groups lands on family", () => {
    expect(effectiveRoleForGroupNames(["Everyone", "Sales Team"])).toBe("family");
  });

  it("no groups → family (least privilege)", () => {
    expect(effectiveRoleForGroupNames([])).toBe("family");
  });

  it("highest-privilege-wins, but never above the ceiling", () => {
    expect(highestRole(["guest", "admin", "family"])).toBe("admin");
    expect(effectiveRoleForGroupNames(["Guests", "Everyone"])).toBe("family");
  });
});
