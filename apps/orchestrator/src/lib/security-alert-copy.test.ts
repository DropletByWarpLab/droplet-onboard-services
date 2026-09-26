/**
 * WARP-2978 (ADR-059 P3 spec §6.7, D27) — the words of a Security alert.
 *
 * Built from the RECIPIENT'S visible evidence only (DS-005: an alert about a
 * camera they cannot see must not reveal presence there), in the site's clock
 * (never UTC — P2b's rule), never naming a person, and never promising what
 * Droplet does not do: P2b's BANNED list runs over every template.
 */
import { describe, expect, it } from "vitest";
import { alertCopy, type AlertEvidence } from "./security-alert-copy.js";

const T = new Date("2026-09-23T01:14:00Z"); // 2:14 AM in London (BST)
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/**
 * The dashboard copy lint's list (apps/web-dashboard/src/components/security/
 * security-copy.test.ts BANNED), restated: server copy the phone shows
 * verbatim must pass it too.
 */
const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["monitor", /monitor/i],
  ["armed", /armed/i],
  ["arm", /\barm\b/i],
  ["alarm", /alarm/i],
  ["secure", /\bsecure\b/i],
  ["protected", /protected/i],
  ["guard", /guard/i],
  ["space", /\bspaces?\b/i],
  ["zone (as a UI noun)", /\bzones?\b/i],
];

const back = (at: Date, mode: AlertEvidence["mode"] = "closed"): AlertEvidence => ({ cameraLabel: "Back camera", at, mode });

describe("alertCopy", () => {
  it("one sighting: the area, the camera, the site clock, and why it matters", () => {
    expect(alertCopy({ zoneName: "Stock room", evidence: [back(T)], tz: "Europe/London" })).toEqual({
      title: "Person in Stock room after hours",
      body: "Back camera saw someone at 2:14 AM. The site was closed.",
    });
  });

  it("set to away reads as such; more visible sightings are counted, the earliest leads", () => {
    const copy = alertCopy({
      zoneName: "Stock room",
      evidence: [{ cameraLabel: "Side door", at: plus(T, 120_000), mode: "away" }, back(T, "away"), back(plus(T, 60_000), "away")],
      tz: "Europe/London",
    });
    expect(copy.body).toBe("Back camera saw someone at 2:14 AM. The site was set to away. It happened 2 more times.");
    expect(
      alertCopy({ zoneName: "Stock room", evidence: [back(T), back(plus(T, 60_000))], tz: "Europe/London" }).body,
    ).toBe("Back camera saw someone at 2:14 AM. The site was closed. It happened 1 more time.");
  });

  it("no site zone: the clock time is left out — never UTC", () => {
    const copy = alertCopy({ zoneName: "Stock room", evidence: [back(T)], tz: null });
    expect(copy.body).toBe("Back camera saw someone. The site was closed.");
    expect(copy.body).not.toMatch(/UTC|GMT|\d:\d\d/);
  });

  it("only what it is given: the text is built from the evidence passed in (the caller's visible set) and nothing else", () => {
    const copy = alertCopy({ zoneName: "Stock room", evidence: [back(T)], tz: "Europe/London" });
    expect(copy.body).not.toMatch(/Side door|more time/);
  });

  it("person-controlled names are made display-safe", () => {
    const copy = alertCopy({
      zoneName: "Stock\u202e room",
      evidence: [{ cameraLabel: "Back\u0007 camera", at: T, mode: "closed" }],
      tz: "Europe/London",
    });
    expect(copy.title).toBe("Person in Stock room after hours");
    expect(copy.body.startsWith("Back camera saw")).toBe(true);
  });

  it("never names a person and never uses a BANNED word, in any template", () => {
    const variants = [
      alertCopy({ zoneName: "Office", evidence: [back(T)], tz: "Europe/London" }),
      alertCopy({ zoneName: "Office", evidence: [back(T, "away"), back(T)], tz: null }),
      alertCopy({ zoneName: "Office", evidence: [back(T), back(T), back(T)], tz: "Europe/London" }),
    ];
    for (const v of variants) {
      for (const text of [v.title, v.body]) {
        for (const [name, re] of BANNED) expect(text, `${name} in "${text}"`).not.toMatch(re);
        expect(text).not.toMatch(/\b(Stefan|Maria|he|she|they)\b/);
      }
    }
  });

  it("an empty evidence list is a programming error, not an empty alert", () => {
    expect(() => alertCopy({ zoneName: "Office", evidence: [], tz: null })).toThrow();
  });

  // ── WARP-2979 (p4-spec §6.7.2) — camera_offline_during_activity ──
  const dropped = (at: Date, mode: AlertEvidence["mode"] = "closed"): AlertEvidence => ({
    code: "camera_offline_during_activity",
    cameraLabel: "Back camera",
    at,
    mode,
    seenAt: plus(at, -60_000),
    seenCameraLabel: "Stock cam",
  });

  it("a camera that stopped reporting soon after someone was seen: its own title and sentence, in the site clock", () => {
    expect(alertCopy({ zoneName: "Stock room", evidence: [dropped(plus(T, 120_000))], tz: "Europe/London" })).toEqual({
      title: "A camera in Stock room stopped reporting after hours",
      body: "Back camera stopped reporting at 2:16 AM, soon after someone was seen in Stock room. The site was closed.",
    });
    expect(alertCopy({ zoneName: "Stock room", evidence: [dropped(T, "away")], tz: null }).body).toBe(
      "Back camera stopped reporting, soon after someone was seen in Stock room. The site was set to away.",
    );
  });

  it("a sighting the recipient can see leads, counted alone; the camera wording is only for a recipient who sees no sighting", () => {
    const both = alertCopy({ zoneName: "Stock room", evidence: [dropped(T), back(plus(T, 60_000))], tz: "Europe/London" });
    expect(both.title).toBe("Person in Stock room after hours");
    expect(both.body).toBe("Back camera saw someone at 2:15 AM. The site was closed.");
  });

  it("the new wording passes the BANNED list and names no person", () => {
    for (const v of [
      alertCopy({ zoneName: "Office", evidence: [dropped(T)], tz: "Europe/London" }),
      alertCopy({ zoneName: "Office", evidence: [dropped(T), dropped(plus(T, 5_000), "away")], tz: null }),
    ]) {
      for (const text of [v.title, v.body]) {
        for (const [name, re] of BANNED) expect(text, `${name} in "${text}"`).not.toMatch(re);
        expect(text).not.toMatch(/(Stefan|Maria|he|she|they)/);
      }
    }
  });
});
