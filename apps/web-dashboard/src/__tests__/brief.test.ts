/**
 * WARP-2752 (ADR-051) — `/brief`: the money rendering and the nav pin.
 *
 * `formatImpact` is where a wrong number reaches a human. The value arrives as
 * a STRING of minor units (BigInt does not survive JSON), so every bug here is
 * an off-by-100 on somebody's receivables — the kind of error that is worse
 * than showing nothing, because it is plausible.
 *
 * The nav cases pin the two things a render test of one page cannot see: the
 * entry is owner/admin only (a finding can be derived from the whole-company
 * corpus, ADR-051 §9), and it is NOT module-gated — it composes separately
 * gated sources and each degrades on its own.
 */
import { describe, it, expect } from "vitest";
import { formatImpact } from "@/app/brief/api";
import { NAV_GROUPS, MOBILE_PRIMARY_HREFS, moduleForPath } from "@/components/nav-config";

function briefItem() {
  const business = NAV_GROUPS.find((g) => g.label === "Business");
  return business?.items.find((i) => i.href === "/brief");
}

describe("formatImpact (WARP-2752)", () => {
  it("renders minor units as major units", () => {
    // 4,000,000 minor = $40,000 — not $4,000,000.
    expect(formatImpact("4000000", "USD")).toContain("40,000");
  });

  it("returns null when the detector computed no impact", () => {
    // A finding without a number is a real finding. Rendering "0" or "—" as a
    // number would state something nothing measured.
    expect(formatImpact(null, "USD")).toBeNull();
    expect(formatImpact("4000000", null)).toBeNull();
    expect(formatImpact(null, null)).toBeNull();
  });

  it("renders an unknown-but-well-formed currency code rather than blanking", () => {
    // Intl does NOT throw on a well-formed three-letter code it has no name
    // for — it prefixes the code. Worth pinning: the obvious assumption
    // ("unknown code throws") is wrong, and a future refactor that "fixes"
    // the fallback on that belief would break this row.
    const out = formatImpact("150000", "XYZ");
    expect(out).toContain("1,500");
    expect(out).toContain("XYZ");
  });

  it("falls back rather than throwing on a MALFORMED currency code", () => {
    // This is what actually reaches the catch: a vendor field that is not a
    // 3-letter code at all. A thrown formatter must not take the finding with
    // it.
    const out = formatImpact("150000", "not-a-code");
    expect(out).toBe("1500 not-a-code");
  });

  it("returns null for a non-numeric amount rather than NaN", () => {
    expect(formatImpact("not-a-number", "USD")).toBeNull();
  });
});

describe("/brief nav entry (WARP-2752)", () => {
  it("sits in the Business group", () => {
    expect(briefItem()).toBeTruthy();
  });

  it("is owner/admin only — family and guest never see it", () => {
    // A finding can be derived from the whole-company corpus. The service
    // filters by scope too, but the nav must not advertise the door.
    expect(briefItem()?.roles).toEqual(["owner", "admin"]);
  });

  it("is NOT module-gated", () => {
    // It composes money findings (ERP connectors) and document findings (the
    // corpus pass); a module gate would hide the whole page because one source
    // is off — the /business ruling.
    expect(briefItem()?.requiresModule).toBeUndefined();
    // `moduleForPath` returns null (not undefined) for an unclaimed route.
    expect(moduleForPath("/brief") ?? null).toBeNull();
  });

  it("does not reopen the mobile tab cap", () => {
    // WARP-290 measured four tabs at 360px and that stands; Business routes
    // through the More drawer.
    expect(MOBILE_PRIMARY_HREFS).not.toContain("/brief");
  });
});
