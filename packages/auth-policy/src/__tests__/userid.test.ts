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

// CodeQL js/polynomial-redos: isValidEmail's dot rule and
// baseUserIdFromEmail's separator trim are index-based now. The accept /
// reject set and the slug output must be exactly what the regexes produced.
describe("isValidEmail — shape (CodeQL js/polynomial-redos)", () => {
  it.each([
    "a@b.co",
    "first.last+tag@sub.example.co.uk",
    "x@y.z",
    "a@b..c", // the old class matched `.` too — a double dot was accepted
    ".a@b.c",
    "a@.b.c", // dot at index 2 satisfies the rule even with a leading dot
    "a@b.c.",
    "  A@B.CO  ", // normalizeEmail trims + lowercases first
  ])("accepts %j", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    "not-an-email",
    "",
    "a@b", // no dot in the domain
    "a@b.", // dot last
    "a@.b", // dot first
    "@b.co", // empty local-part
    "a@", // empty domain
    "a@@b.co",
    "a@b.c@d", // two @
    "a b@c.d", // whitespace
    "a@b .co",
    "a@b\u00a0.c", // \s covers unicode spaces, so an interior NBSP is refused
  ])("rejects %j", (email) => {
    expect(isValidEmail(email)).toBe(false);
  });

  it("decides a 5,000-char dotted domain in well under 100 ms", () => {
    // The shape CodeQL reported: `!@!.` then many `!.` — with a trailing
    // char that defeats `$` so the old `[^\s@]+\.[^\s@]+$` backtracks.
    const hostile = "!@!." + "!.".repeat(2500) + "@";
    const started = performance.now();
    const verdict = isValidEmail(hostile);
    expect(performance.now() - started).toBeLessThan(100);
    expect(verdict).toBe(false);
  });
});

describe("baseUserIdFromEmail — separator trim (CodeQL js/polynomial-redos)", () => {
  it.each([
    ["..robin..@x.com", "robin"],
    ["-_.robin.-_@x.com", "robin"],
    ["robin.banks@x.com", "robin.banks"], // a single interior separator survives
    ["robin__banks@x.com", "robin-banks"], // a run collapses to `-`
    ["a..b@x.com", "a-b"],
    ["-a-@x.com", "a"], // 1 char < USERID_MIN → fallback below
    ["___@x.com", "user"],
  ])("%s → %s", (email, expected) => {
    expect(baseUserIdFromEmail(email)).toBe(expected === "a" ? "user" : expected);
  });

  it("slugs a 5,000-separator local-part in well under 100 ms", () => {
    const hostile = "-".repeat(5000) + "x@x.com";
    const started = performance.now();
    const slug = baseUserIdFromEmail(hostile);
    expect(performance.now() - started).toBeLessThan(100);
    expect(slug).toBe("user"); // run → `-`, trimmed → "x" (1 char) → fallback
  });
});
