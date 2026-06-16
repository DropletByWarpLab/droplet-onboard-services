import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  isValidEmail,
  baseUserIdFromEmail,
  nthUserIdCandidate,
  isReservedUserId,
  deriveUserId,
  RESERVED_USERNAMES,
} from "../userid.js";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("isValidEmail", () => {
  it("accepts a normal address and rejects junk", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });
});

describe("baseUserIdFromEmail", () => {
  it("uses the slugified local-part", () => {
    expect(baseUserIdFromEmail("Robin.Banks@warp.test")).toBe("robin.banks");
  });
  it("strips characters Nextcloud forbids and collapses separators", () => {
    expect(baseUserIdFromEmail("a+b!!c@x.com")).toBe("a-b-c");
  });
  it("falls back to 'user' when the local-part is empty after stripping", () => {
    expect(baseUserIdFromEmail("+++@x.com")).toBe("user");
  });
});

describe("deriveUserId (pure, Set-backed isTaken)", () => {
  it("returns the base when free", () => {
    expect(deriveUserId("robin@x.com", () => false)).toBe("robin");
  });
  it("suffixes on collision", () => {
    const taken = new Set(["robin", "robin-2"]);
    expect(deriveUserId("robin@x.com", (c) => taken.has(c))).toBe("robin-3");
  });
  it("never returns a reserved id", () => {
    expect(deriveUserId("admin@x.com", () => false)).toBe("admin-2");
    expect(RESERVED_USERNAMES).toContain("admin");
  });
});

describe("nthUserIdCandidate / isReservedUserId", () => {
  it("n<=1 is the base; n>1 suffixes", () => {
    expect(nthUserIdCandidate("bob", 1)).toBe("bob");
    expect(nthUserIdCandidate("bob", 4)).toBe("bob-4");
  });
  it("flags reserved ids case-insensitively", () => {
    expect(isReservedUserId("ROOT")).toBe(true);
    expect(isReservedUserId("robin")).toBe(false);
  });
});
