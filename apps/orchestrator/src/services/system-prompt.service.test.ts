/**
 * WARP-3281 — the chat base prompt carries today's date, at DAY granularity.
 *
 * gpt-oss refused "weather in Boston on 2026-10-03" (six days out) as beyond
 * the forecast horizon because it assumed a date near its training cutoff.
 * One line fixes that. It must change only at midnight in the business's
 * zone: WARP-3125 showed a minute timestamp busts llama.cpp's prefix cache on
 * every request, and a date busts it once a day.
 */
import { describe, expect, it } from "vitest";
import { buildBaseSystemPrompt, todayLine } from "./system-prompt.service.js";
import { DATE_LINE_MAX_CHARS } from "./prompt-budget.consts.js";

describe("todayLine", () => {
  it("renders weekday, ISO date and zone", () => {
    expect(todayLine(new Date("2026-09-28T17:00:00Z"), "America/Los_Angeles")).toBe(
      "Today is Monday 2026-09-28 (America/Los_Angeles); use that timezone for any clock or calendar tool.",
    );
  });

  it("changes at midnight in the given zone, not in UTC", () => {
    // 23:59:59 PDT on Sunday is already Monday in UTC.
    const lastSecondOfSunday = new Date("2026-09-28T06:59:59Z");
    const firstSecondOfMonday = new Date("2026-09-28T07:00:00Z");
    expect(todayLine(lastSecondOfSunday, "America/Los_Angeles")).toBe(
      "Today is Sunday 2026-09-27 (America/Los_Angeles); use that timezone for any clock or calendar tool.",
    );
    expect(todayLine(firstSecondOfMonday, "America/Los_Angeles")).toBe(
      "Today is Monday 2026-09-28 (America/Los_Angeles); use that timezone for any clock or calendar tool.",
    );
    // Same instant, different business: the zone decides the day.
    expect(todayLine(lastSecondOfSunday, "Europe/Paris")).toBe(
      "Today is Monday 2026-09-28 (Europe/Paris); use that timezone for any clock or calendar tool.",
    );
  });

  it("is identical for every instant within one local day (prefix-cache stable)", () => {
    const morning = todayLine(new Date("2026-09-28T07:00:01Z"), "America/Los_Angeles");
    const evening = todayLine(new Date("2026-09-29T06:59:00Z"), "America/Los_Angeles");
    expect(evening).toBe(morning);
    expect(morning).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("falls back past an unknown zone instead of throwing", () => {
    expect(todayLine(new Date("2026-09-28T17:00:00Z"), "Not/AZone")).toMatch(
      /^Today is [A-Z][a-z]+day 2026-09-2\d \([^)]+\); use that timezone/,
    );
  });

  it("withZone:false (an off-LAN turn) renders the day without the zone", () => {
    expect(todayLine(new Date("2026-09-28T17:00:00Z"), "Pacific/Auckland", { withZone: false })).toBe(
      "Today is Tuesday 2026-09-29.",
    );
  });

  it("the longest real render, plus its separator, fits DATE_LINE_MAX_CHARS", () => {
    const wednesday = new Date("2026-09-30T15:00:00Z");
    const longest = todayLine(wednesday, "America/Argentina/ComodRivadavia");
    expect(longest).toContain("Wednesday");
    expect(longest.length + 2).toBeLessThanOrEqual(DATE_LINE_MAX_CHARS);
    // A 64-char zone (the Workspace.tz column cap) still fits.
    expect(longest.length - "America/Argentina/ComodRivadavia".length + 64 + 2).toBeLessThanOrEqual(DATE_LINE_MAX_CHARS);
  });
});

describe("buildBaseSystemPrompt date line", () => {
  it("ends with the given date line", () => {
    const line = "Today is Monday 2026-09-28 (America/Los_Angeles).";
    expect(buildBaseSystemPrompt(undefined, "", "", line).endsWith(`\n\n${line}`)).toBe(true);
  });

  it("carries today's date by default, so every caller gets it", () => {
    expect(buildBaseSystemPrompt(undefined, "", "")).toMatch(/\n\nToday is \w+ \d{4}-\d{2}-\d{2} \(.+\); use that timezone for any clock or calendar tool\.$/);
  });

  it("an empty line omits it (the voice principal carries its own clock)", () => {
    expect(buildBaseSystemPrompt(undefined, "", "", "")).not.toContain("Today is");
  });
});
