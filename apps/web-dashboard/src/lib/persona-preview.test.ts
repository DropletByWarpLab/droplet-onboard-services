/**
 * WARP-1119 — the Settings personality card's greeting preview model.
 *
 * Two consumers:
 *   - `PRESET_TILES` — the four §9 preset tiles (name · desc · preview),
 *     copy VERBATIM from the design brief, with `[FirstName]` resolved at
 *     runtime (never hardcoded). No-name fallback drops the comma clause.
 *   - `buildGreeting` — the LIVE preview capsule: re-renders the sample
 *     greeting as preset / verbosity / first-names controls change (design
 *     brief §6.4 — local preview only, context not UI logic). Ported from
 *     the design prototype's greeting matrix.
 */
import { describe, it, expect } from "vitest";

import { buildGreeting, PRESET_TILES } from "./persona-preview";

describe("PRESET_TILES", () => {
  it("carries the four §9 presets, ids matching the API enum", () => {
    expect(PRESET_TILES.map((t) => t.id)).toEqual([
      "warm_friendly",
      "professional_precise",
      "founder",
      "direct_technical",
    ]);
    expect(PRESET_TILES.map((t) => t.name)).toEqual([
      "Warm & friendly",
      "Professional & precise",
      "Founder-y",
      "Direct & technical",
    ]);
    expect(PRESET_TILES.map((t) => t.desc)).toEqual([
      "Approachable and encouraging, plain words.",
      "Structured, formal, straight to the point.",
      "Short, friendly, first names only.",
      "Terse, numbers first, no small talk.",
    ]);
  });

  it("substitutes [FirstName] in the warm and founder tile previews", () => {
    const byId = Object.fromEntries(PRESET_TILES.map((t) => [t.id, t]));
    expect(byId.warm_friendly!.preview("Nadia")).toBe(
      "Good morning, Nadia. Three things could use a look today — want the quick version?",
    );
    expect(byId.founder!.preview("Nadia")).toBe(
      "Morning, Nadia — quiet night. One invoice worth a look.",
    );
    expect(byId.professional_precise!.preview("Nadia")).toBe(
      "Good morning. Two items require your attention: an unpaid invoice and a low-stock alert.",
    );
    expect(byId.direct_technical!.preview("Nadia")).toBe(
      "3 alerts. Backup finished 02:14. Invoice #1042 is 6 days overdue.",
    );
  });

  it("drops the comma clause when no first name is known (§9 fallback)", () => {
    const byId = Object.fromEntries(PRESET_TILES.map((t) => [t.id, t]));
    expect(byId.warm_friendly!.preview(null)).toBe(
      "Good morning. Three things could use a look today — want the quick version?",
    );
    expect(byId.founder!.preview(null)).toBe(
      "Morning — quiet night. One invoice worth a look.",
    );
  });
});

describe("buildGreeting (live preview)", () => {
  it("renders warm · balanced · first names", () => {
    expect(buildGreeting("warm_friendly", "balanced", true, "Nadia")).toBe(
      "Good morning, Nadia. Three things could use a look today — want the quick version?",
    );
  });

  it("drops the name when the first-names toggle is off", () => {
    expect(buildGreeting("warm_friendly", "balanced", false, "Nadia")).toBe(
      "Good morning. Three things could use a look today — want the quick version?",
    );
  });

  it("drops the name when none is known, even with the toggle on", () => {
    expect(buildGreeting("founder", "balanced", true, null)).toBe(
      "Morning — quiet night. One invoice worth a look.",
    );
  });

  it("varies with verbosity", () => {
    expect(buildGreeting("warm_friendly", "concise", true, "Nadia")).toBe(
      "Good morning, Nadia. Three things could use a look today.",
    );
    expect(
      buildGreeting("professional_precise", "detailed", false, null),
    ).toBe(
      "Good morning. Two items require your attention: invoice #1042 (6 days overdue) and a low-stock alert on composite refills. Full list below.",
    );
  });

  it("direct & technical never uses names and stays terse", () => {
    expect(buildGreeting("direct_technical", "concise", true, "Nadia")).toBe(
      "3 alerts. Invoice #1042 overdue.",
    );
    expect(buildGreeting("direct_technical", "detailed", true, "Nadia")).toBe(
      "3 alerts. Backup 02:14 OK. Invoice #1042 +6d. Stock: composite refills < 10. Eastgate Thu: 4 open slots.",
    );
  });
});
