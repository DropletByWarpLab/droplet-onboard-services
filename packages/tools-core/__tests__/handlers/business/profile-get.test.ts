/**
 * WARP-1120 (Phase 2, §13) — `business_profile_get` read-only tool.
 *
 * Returns the structured business profile respecting the §12 role subset via
 * `ToolContext.role`: owner/admin → summary + fields, family → summary only,
 * guest/service → nothing. Read-only Tier 1. Output is bounded to a documented
 * 4000-char result budget so a filled profile can never flood the context
 * window, and the input schema is `additionalProperties:false`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import businessProfileGet from "../../../src/handlers/business/profile-get.js";
import type { ToolContext } from "../../../src/types.js";

const FILLED = {
  id: "singleton",
  onboardingState: "completed",
  summary: "SUMMARY_SENTINEL — a small dental practice.",
  whatWeDo: "WHATWEDO_SENTINEL",
  customers: "CUSTOMERS_SENTINEL",
  teamShape: "TEAMSHAPE_SENTINEL",
  toolsUsed: "TOOLSUSED_SENTINEL",
  typicalDay: "TYPICALDAY_SENTINEL",
  goals: "GOALS_SENTINEL_pain_points",
  lastSource: "onboarding",
};

const RESTRICTED_FIELD_SENTINELS = [
  "WHATWEDO_SENTINEL",
  "CUSTOMERS_SENTINEL",
  "TEAMSHAPE_SENTINEL",
  "TOOLSUSED_SENTINEL",
  "TYPICALDAY_SENTINEL",
  "GOALS_SENTINEL_pain_points",
];

function ctxWith(
  findUnique: Mock,
  role?: ToolContext["role"],
): ToolContext {
  return {
    prisma: {
      businessProfile: { findUnique },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    role,
    signal: new AbortController().signal,
  };
}

describe("business_profile_get — role subset (§12/§15 no-leak)", () => {
  it("owner receives the summary AND every structured field", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "owner"));
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.ok && res.data);
    expect(json).toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).toContain(s);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "singleton" } });
  });

  it("admin receives the summary AND every structured field", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "admin"));
    const json = JSON.stringify(res.ok && res.data);
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).toContain(s);
  });

  it("family receives the summary ONLY — zero restricted-field text", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "family"));
    const json = JSON.stringify(res.ok && res.data);
    expect(json).toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).not.toContain(s);
  });

  it("guest receives NOTHING (present:false, no sentinels at all)", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "guest"));
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.ok && res.data);
    expect(json).not.toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).not.toContain(s);
  });

  it("service receives NOTHING", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "service"));
    const json = JSON.stringify(res.ok && res.data);
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).not.toContain(s);
  });

  it("an absent role is treated as most-restrictive (nothing)", async () => {
    const findUnique = vi.fn().mockResolvedValue(FILLED);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique));
    const json = JSON.stringify(res.ok && res.data);
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(json).not.toContain(s);
  });
});

describe("business_profile_get — fresh box / result budget", () => {
  it("reports no profile when the singleton row does not exist yet", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "owner"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ present: false });
  });

  it("bounds the result to the documented 4000-char budget", async () => {
    const maxed = {
      ...FILLED,
      summary: "s".repeat(1500),
      whatWeDo: "w".repeat(600),
      customers: "c".repeat(600),
      teamShape: "t".repeat(600),
      toolsUsed: "u".repeat(600),
      typicalDay: "d".repeat(600),
      goals: "g".repeat(600),
    };
    const findUnique = vi.fn().mockResolvedValue(maxed);
    const res = await businessProfileGet.handler({}, ctxWith(findUnique, "owner"));
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.ok && res.data);
    expect(json.length).toBeLessThanOrEqual(4000);
    // Summary is highest priority — it survives the clamp intact.
    if (res.ok) expect((res.data as { summary: string }).summary).toBe("s".repeat(1500));
  });
});

describe("business_profile_get — tool metadata", () => {
  it("is read-only Tier 1 (no write, no confirm)", () => {
    expect(businessProfileGet.requiresWrite).toBe(false);
    expect(businessProfileGet.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((businessProfileGet.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it("is named business_profile_get", () => {
    expect(businessProfileGet.name).toBe("business_profile_get");
  });
});
