/**
 * WARP (SCIM directory sync) — SCIM 2.0 resource (de)serialization + filter.
 *
 * Pure, DB-free helpers (RFC 7643/7644):
 *   - SCIM_USER_SCHEMA / list + error message schemas (canonical URNs).
 *   - toScimUser(localUser) — render a local User row as a SCIM User resource
 *     (schemas, id, userName, name, emails[], active, meta).
 *   - toScimListResponse(resources, total, startIndex) — the ListResponse
 *     envelope Okta expects from GET /Users (and an empty filter miss).
 *   - scimError(status, detail, scimType?) — the SCIM Error envelope.
 *   - parseUserNameEqFilter('userName eq "x@y.com"') — extract the email Okta
 *     filters by; returns null for anything that isn't that exact shape.
 *   - parseScimUser(body) — read a SCIM User write payload into a normalized
 *     shape (email trim+lowercased, active default true).
 */
import { describe, it, expect } from "vitest";
import {
  SCIM_USER_SCHEMA,
  SCIM_LIST_RESPONSE_SCHEMA,
  SCIM_ERROR_SCHEMA,
  toScimUser,
  toScimListResponse,
  scimError,
  parseUserNameEqFilter,
  parseScimUser,
} from "./scim-resource.js";

const localUser = {
  id: "u-uuid-1",
  username: "jdoe",
  displayName: "Jane Doe",
  email: "jane@acme.test",
  role: "family",
  directoryStatus: "ACTIVE" as const,
  createdAt: new Date("2026-05-31T00:00:00.000Z"),
  updatedAt: new Date("2026-05-31T01:00:00.000Z"),
};

describe("toScimUser — local User → SCIM User resource", () => {
  it("emits the canonical schema, id, userName(email), displayName, active=true", () => {
    const r = toScimUser(localUser);
    expect(r.schemas).toEqual([SCIM_USER_SCHEMA]);
    expect(r.id).toBe("u-uuid-1"); // the SCIM resource id is the local User.id
    expect(r.userName).toBe("jane@acme.test");
    expect(r.displayName).toBe("Jane Doe");
    expect(r.active).toBe(true);
  });

  it("emits emails[] with the primary work email", () => {
    const r = toScimUser(localUser);
    expect(r.emails).toEqual([{ value: "jane@acme.test", primary: true, type: "work" }]);
  });

  it("renders active=false for a DEACTIVATED row (soft-deactivation surfaced to SCIM)", () => {
    const r = toScimUser({ ...localUser, directoryStatus: "DEACTIVATED" });
    expect(r.active).toBe(false);
  });

  it("includes a meta block with resourceType=User", () => {
    const r = toScimUser(localUser);
    expect(r.meta?.resourceType).toBe("User");
  });
});

describe("toScimListResponse — the ListResponse envelope", () => {
  it("wraps resources with totalResults + the list schema", () => {
    const list = toScimListResponse([toScimUser(localUser)], 1, 1);
    expect(list.schemas).toEqual([SCIM_LIST_RESPONSE_SCHEMA]);
    expect(list.totalResults).toBe(1);
    expect(list.startIndex).toBe(1);
    expect(list.itemsPerPage).toBe(1);
    expect(list.Resources).toHaveLength(1);
  });

  it("renders an empty match as totalResults=0 + empty Resources (the filter-miss shape)", () => {
    const list = toScimListResponse([], 0, 1);
    expect(list.totalResults).toBe(0);
    expect(list.Resources).toEqual([]);
  });
});

describe("scimError — the SCIM Error envelope", () => {
  it("carries the error schema, status (as a string), and detail", () => {
    const e = scimError(404, "User not found");
    expect(e.schemas).toEqual([SCIM_ERROR_SCHEMA]);
    expect(e.status).toBe("404"); // SCIM status is a STRING per RFC 7644
    expect(e.detail).toBe("User not found");
  });

  it("includes scimType when supplied (e.g. uniqueness)", () => {
    const e = scimError(409, "userName already exists", "uniqueness");
    expect(e.scimType).toBe("uniqueness");
  });
});

describe("parseUserNameEqFilter — Okta's `userName eq \"...\"` lookup", () => {
  it("extracts the email from the canonical filter", () => {
    expect(parseUserNameEqFilter('userName eq "jane@acme.test"')).toBe("jane@acme.test");
  });

  it("normalizes the extracted value (trim + lowercase) to match the stored key", () => {
    expect(parseUserNameEqFilter('userName eq "  Jane@ACME.test  "')).toBe("jane@acme.test");
  });

  it("is case-insensitive on the attribute name + operator", () => {
    expect(parseUserNameEqFilter('USERNAME EQ "x@y.com"')).toBe("x@y.com");
  });

  it("returns null for an unsupported filter (we only support userName eq)", () => {
    expect(parseUserNameEqFilter('displayName eq "Jane"')).toBeNull();
    expect(parseUserNameEqFilter('userName co "acme"')).toBeNull();
    expect(parseUserNameEqFilter("")).toBeNull();
    expect(parseUserNameEqFilter(undefined)).toBeNull();
  });
});

describe("parseScimUser — read a SCIM write payload", () => {
  it("pulls userName as the email (trim+lowercased) and defaults active=true", () => {
    const p = parseScimUser({ userName: "  New@Person.test ", name: { givenName: "New", familyName: "Person" } });
    expect(p.email).toBe("new@person.test");
    expect(p.active).toBe(true);
    expect(p.displayName).toBe("New Person");
  });

  it("honors explicit active=false", () => {
    const p = parseScimUser({ userName: "x@y.com", active: false });
    expect(p.active).toBe(false);
  });

  it("prefers an explicit displayName, falls back to name parts, then the email", () => {
    expect(parseScimUser({ userName: "a@b.com", displayName: "Ann B" }).displayName).toBe("Ann B");
    expect(parseScimUser({ userName: "a@b.com", name: { givenName: "Ann" } }).displayName).toBe("Ann");
    expect(parseScimUser({ userName: "a@b.com" }).displayName).toBe("a@b.com");
  });

  it("carries externalId through when present", () => {
    expect(parseScimUser({ userName: "a@b.com", externalId: "okta-99" }).externalId).toBe("okta-99");
  });

  it("throws a typed error when userName is missing/blank (a SCIM User needs one)", () => {
    expect(() => parseScimUser({ name: { givenName: "No" } })).toThrow();
    expect(() => parseScimUser({ userName: "   " })).toThrow();
  });
});
