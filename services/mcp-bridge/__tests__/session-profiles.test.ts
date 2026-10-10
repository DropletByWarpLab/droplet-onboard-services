/**
 * WARP-3703 (ADR-043 TC-1.1) — the closed profile registry, and the open
 * contract each profile declares for itself.
 *
 * Before this, `POST /sessions/:serverId/open` demanded `email`, `apiToken` and
 * `cloudId` for EVERY server id, because Atlassian was the only one. A vendor
 * that presents one static Bearer token has no email and no site, so the
 * contract moved onto the registry entry: a {@link SessionProfile} is its
 * factory PLUS the fields the wire must carry before the factory runs.
 *
 * NOTHING HERE DIALS. Constructing the shipped Atlassian factory builds a
 * session and connects nothing, and the one fixture below is a plain object.
 *
 * What this file is for is the PRODUCTION registry: the properties every future
 * vendor entry has to keep (a legal id, a contract that cannot collide with a
 * wire field the route owns, a factory that reads what its profile declares).
 * The route's behaviour over fixture vendors is `http-api.profiles.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { ATLASSIAN_REQUIRED_FIELDS, ATLASSIAN_SERVER_ID } from "../src/atlassian.js";
import {
  BARE_FACTORY_REQUIRED_FIELDS,
  SESSION_FACTORIES,
  SESSION_PROFILES,
  knownServerIds,
  toSessionProfile,
  type OpenSessionInput,
  type SessionFactory,
} from "../src/session-profiles.js";

const FAKE_API_TOKEN = "ATATT-FAKE-000000000000";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";

/** The wire fields the route itself owns. A profile that declared one of them
 *  as a credential field would have the route read it twice, as two things. */
const ROUTE_OWNED_FIELDS = ["url", "knownTools"];

describe("the production registry stays closed (TC-1.1)", () => {
  it("serves exactly one server today — a second is a second ENTRY, never a config value", () => {
    expect(knownServerIds()).toEqual(["atlassian"]);
    expect(Object.keys(SESSION_PROFILES)).toEqual([ATLASSIAN_SERVER_ID]);
  });

  it("is frozen, entry by entry, so a profile's contract cannot be edited at runtime", () => {
    expect(Object.isFrozen(SESSION_PROFILES)).toBe(true);
    for (const profile of Object.values(SESSION_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.requiredFields)).toBe(true);
    }
  });

  it("keeps SESSION_FACTORIES as a VIEW of it, not a second registry that could drift", () => {
    expect(Object.keys(SESSION_FACTORIES)).toEqual(Object.keys(SESSION_PROFILES));
    for (const [id, profile] of Object.entries(SESSION_PROFILES)) {
      expect(SESSION_FACTORIES[id]).toBe(profile.factory);
    }
    expect(Object.isFrozen(SESSION_FACTORIES)).toBe(true);
  });
});

describe("every registered profile declares a usable contract (TC-1.1)", () => {
  it("is keyed by an id the multiplexer can namespace", () => {
    for (const id of Object.keys(SESSION_PROFILES)) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    }
  });

  it("requires at least one field, with no repeats", () => {
    for (const [id, profile] of Object.entries(SESSION_PROFILES)) {
      expect(profile.requiredFields.length, `${id} requires nothing`).toBeGreaterThan(0);
      expect(new Set(profile.requiredFields).size, `${id} repeats a field`).toBe(
        profile.requiredFields.length,
      );
    }
  });

  it("names each field as a plain identifier the 400 and the JSON body can carry verbatim", () => {
    for (const [id, profile] of Object.entries(SESSION_PROFILES)) {
      for (const field of profile.requiredFields) {
        expect(field, `${id}.${field}`).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      }
    }
  });

  it("never takes a field the route owns as a credential field", () => {
    for (const [id, profile] of Object.entries(SESSION_PROFILES)) {
      for (const owned of ROUTE_OWNED_FIELDS) {
        expect(profile.requiredFields, `${id} declares ${owned}`).not.toContain(owned);
      }
    }
  });
});

describe("Atlassian's contract is a sign-in: a bearer and the pinned site (WARP-3961)", () => {
  it("is accessToken, cloudId — and no email / apiToken field exists any more", () => {
    expect(ATLASSIAN_REQUIRED_FIELDS).toEqual(["accessToken", "cloudId"]);
    expect(SESSION_PROFILES[ATLASSIAN_SERVER_ID]?.requiredFields).toBe(ATLASSIAN_REQUIRED_FIELDS);
  });

  it("is what its factory actually reads: every declared field is load-bearing, and nothing else is", () => {
    // The declaration and the reader are written in two places. If the profile
    // listed a field the factory never reads, the route would demand it for no
    // reason; if the factory read one the profile did not list, a body could
    // pass validation and then break the session at construction.
    const factory = SESSION_PROFILES[ATLASSIAN_SERVER_ID]!.factory;
    const full: OpenSessionInput = {
      accessToken: FAKE_API_TOKEN,
      cloudId: FAKE_CLOUD_ID,
    };
    expect(() => factory(full)).not.toThrow();
    for (const field of ATLASSIAN_REQUIRED_FIELDS) {
      const { [field]: _dropped, ...without } = full;
      expect(() => factory(without), `${field} is not load-bearing`).toThrow();
    }
  });
});

describe("a bare factory keeps the contract every factory had before profiles (TC-1.1)", () => {
  const factory = (() => {
    throw new Error("never built in this file");
  }) as unknown as SessionFactory;

  it("is wrapped as a profile that requires the three Atlassian fields", () => {
    expect(toSessionProfile(factory)).toEqual({
      requiredFields: BARE_FACTORY_REQUIRED_FIELDS,
      factory,
    });
    expect(BARE_FACTORY_REQUIRED_FIELDS).toEqual(["email", "apiToken", "cloudId"]);
  });

  it("is a frozen constant of its OWN, not an alias of Atlassian's — editing one must not move the other", () => {
    expect(Object.isFrozen(BARE_FACTORY_REQUIRED_FIELDS)).toBe(true);
    expect(BARE_FACTORY_REQUIRED_FIELDS).not.toBe(ATLASSIAN_REQUIRED_FIELDS);
  });

  it("passes a real profile through untouched", () => {
    const profile = { requiredFields: ["apiToken"], factory };
    expect(toSessionProfile(profile)).toBe(profile);
  });
});
