/**
 * WARP-979 — unit spec for the SHARED box-name validation util.
 *
 * This is the highest-value file in the branch: both the dashboard (live
 * client-side check) and the orchestrator (server-side re-validation before
 * persisting + before the name goes to HQ) import these rules, so a drift here
 * silently drifts BOTH sides. QA flagged it as covered only transitively (via
 * the orchestrator route test) — this spec pins the exact behavior directly.
 *
 * Assertions were checked against the real compiled output before being
 * written; in particular UPPERCASE is NORMALIZED to lowercase and PASSES (it is
 * NOT a charset rejection — only characters outside [a-z0-9-] after normalizing
 * fail charset, e.g. a space).
 */
import { describe, it, expect } from "vitest";
import {
  BOX_NAME_SUFFIX,
  BOX_NAME_MIN_LEN,
  BOX_NAME_MAX_LEN,
  BOX_NAME_RESERVED,
  validateBoxName,
  normalizeBoxName,
  isValidBoxName,
  boxNameToFqdn,
  boxNameReasonMessage,
  type BoxNameInvalidReason,
} from "./box-name";

describe("validateBoxName — accepted names", () => {
  const valid: Array<[string, string]> = [
    ["a simple lowercase slug", "studio"],
    ["digits", "box42"],
    ["a single internal hyphen", "my-box"],
    ["multiple internal hyphens", "a-b-c-d"],
    // UPPERCASE is normalized to lowercase, then passes — the AddressStep path
    // where the owner types "MyBox" resolves to the slug "mybox".
    ["uppercase (normalized to lowercase)", "MyBox"],
    ["all-caps (normalized to lowercase)", "MYBOX"],
    ["surrounding whitespace (trimmed)", "  studio  "],
    // d-<N hex> where N != 16 is NOT the device lookalike shape.
    ["a d- prefix that is not the 16-hex lookalike (15 hex)", "d-0123456789abcde"],
    ["a d- prefix that is not the 16-hex lookalike (17 hex)", "d-0123456789abcdef0"],
    ["a d- prefix with a non-hex char at pos 16", "d-0123456789abcdeg"],
  ];

  it.each(valid)("accepts %s", (_label, raw) => {
    const v = validateBoxName(raw);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeUndefined();
    // The returned slug is always the normalized (trimmed + lowercased) form.
    expect(v.slug).toBe(normalizeBoxName(raw));
  });

  it("normalizes trimmed + lowercased slug on the result", () => {
    expect(validateBoxName("  MyBox  ")).toEqual({ ok: true, slug: "mybox" });
  });
});

describe("validateBoxName — length boundaries", () => {
  it(`accepts exactly the ${BOX_NAME_MIN_LEN}-char minimum`, () => {
    const v = validateBoxName("a".repeat(BOX_NAME_MIN_LEN)); // "aaa"
    expect(v.ok).toBe(true);
  });

  it(`rejects one below the minimum (${BOX_NAME_MIN_LEN - 1} chars) as too_short`, () => {
    const v = validateBoxName("a".repeat(BOX_NAME_MIN_LEN - 1)); // "aa"
    expect(v).toEqual({
      ok: false,
      slug: "aa",
      reason: "too_short",
    });
  });

  it(`accepts exactly the ${BOX_NAME_MAX_LEN}-char maximum`, () => {
    const v = validateBoxName("a".repeat(BOX_NAME_MAX_LEN));
    expect(v.ok).toBe(true);
  });

  it(`rejects one above the maximum (${BOX_NAME_MAX_LEN + 1} chars) as too_long`, () => {
    const raw = "a".repeat(BOX_NAME_MAX_LEN + 1);
    const v = validateBoxName(raw);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("too_long");
    expect(v.slug).toBe(raw);
  });
});

describe("validateBoxName — hyphen shape", () => {
  const hyphenFails: Array<[string, string]> = [
    ["leading hyphen", "-studio"],
    ["trailing hyphen", "studio-"],
    ["double hyphen", "stu--dio"],
  ];

  it.each(hyphenFails)("rejects a %s with reason 'hyphen'", (_label, raw) => {
    const v = validateBoxName(raw);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("hyphen");
  });
});

describe("validateBoxName — charset", () => {
  const charsetFails: Array<[string, string]> = [
    ["a space", "my box"],
    ["an underscore", "my_box"],
    ["a dot", "my.box"],
    ["an exclamation mark", "mybox!"],
    // After normalize, uppercase is gone — so a charset failure requires a
    // genuinely out-of-charset char, not merely uppercase.
    ["uppercase mixed with a space", "My Box"],
  ];

  it.each(charsetFails)("rejects %s with reason 'charset'", (_label, raw) => {
    const v = validateBoxName(raw);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("charset");
  });
});

describe("validateBoxName — reserved blocklist", () => {
  it("rejects EVERY name in the reserved blocklist (never ok)", () => {
    for (const name of BOX_NAME_RESERVED) {
      const v = validateBoxName(name);
      expect(v.ok, `expected reserved name "${name}" to be rejected`).toBe(
        false,
      );
    }
  });

  it("reports reason 'reserved' for reserved names that clear the length floor", () => {
    // The length check runs BEFORE the reserved check, so only reserved entries
    // of at least BOX_NAME_MIN_LEN chars actually surface as 'reserved'.
    for (const name of BOX_NAME_RESERVED.filter(
      (n) => n.length >= BOX_NAME_MIN_LEN,
    )) {
      expect(validateBoxName(name).reason, `reason for "${name}"`).toBe(
        "reserved",
      );
    }
  });

  it("reports 'too_short' (NOT 'reserved') for sub-minimum reserved entries", () => {
    // hq / ns / mx are 2 chars: the length rule fires first, so they can never
    // be reached as 'reserved' via validateBoxName. Pinned so a future length
    // change is a conscious decision, not a silent behavior flip.
    const subMin = BOX_NAME_RESERVED.filter((n) => n.length < BOX_NAME_MIN_LEN);
    expect(subMin).toEqual(["hq", "ns", "mx"]);
    for (const name of subMin) {
      expect(validateBoxName(name).reason, `reason for "${name}"`).toBe(
        "too_short",
      );
    }
  });

  it("rejects a reserved name regardless of input casing (normalized first)", () => {
    expect(validateBoxName("ADMIN").reason).toBe("reserved");
  });
});

describe("validateBoxName — device lookalike (d-<16 hex>)", () => {
  it("rejects the exact d-<16 hex> device-identifier shape as 'lookalike'", () => {
    const v = validateBoxName("d-0123456789abcdef");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("lookalike");
  });

  it("does NOT treat d-<15 hex> as a lookalike (accepted)", () => {
    expect(validateBoxName("d-0123456789abcde").ok).toBe(true);
  });

  it("does NOT treat d-<17 hex> as a lookalike (accepted)", () => {
    expect(validateBoxName("d-0123456789abcdef0").ok).toBe(true);
  });

  it("does NOT treat d-<16 chars with a non-hex char> as a lookalike (accepted)", () => {
    // trailing 'g' is not hex, so the 16-char group is not all-hex.
    expect(validateBoxName("d-0123456789abcdeg").ok).toBe(true);
  });
});

describe("validateBoxName — empty / whitespace", () => {
  it("rejects an empty string as 'empty'", () => {
    expect(validateBoxName("")).toEqual({ ok: false, slug: "", reason: "empty" });
  });

  it("rejects a whitespace-only string as 'empty' (trims to nothing)", () => {
    expect(validateBoxName("   ")).toEqual({
      ok: false,
      slug: "",
      reason: "empty",
    });
  });
});

describe("normalizeBoxName", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeBoxName("  Foo-BAR  ")).toBe("foo-bar");
  });

  it("does NOT strip or substitute internal characters (bad input stays visible)", () => {
    // Internal spaces are preserved so validateBoxName can reject on charset
    // instead of silently coercing "my box" into "mybox".
    expect(normalizeBoxName("My Box")).toBe("my box");
  });
});

describe("isValidBoxName", () => {
  it("returns true for a valid name and false for an invalid one", () => {
    expect(isValidBoxName("studio")).toBe(true);
    expect(isValidBoxName("ab")).toBe(false);
    expect(isValidBoxName("admin")).toBe(false);
  });
});

describe("boxNameToFqdn", () => {
  it(`appends ${BOX_NAME_SUFFIX} to the slug`, () => {
    expect(boxNameToFqdn("studio")).toBe("studio.droplet-us.com");
  });

  it("uses the droplet-us.com suffix (not warp-lab.ai)", () => {
    expect(BOX_NAME_SUFFIX).toBe(".droplet-us.com");
    expect(boxNameToFqdn("my-box").endsWith(".droplet-us.com")).toBe(true);
  });
});

describe("boxNameReasonMessage", () => {
  const reasons: BoxNameInvalidReason[] = [
    "empty",
    "too_short",
    "too_long",
    "charset",
    "hyphen",
    "reserved",
    "lookalike",
  ];

  it.each(reasons)("returns a non-empty string for reason '%s'", (reason) => {
    const msg = boxNameReasonMessage(reason);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
});
