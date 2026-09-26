/**
 * WARP-2979 (ADR-059 P4 §6.11.1, D22) — the check a summary must pass before
 * it is stored. Every rule both ways.
 */
import { describe, expect, it } from "vitest";
import { NARRATIVE_MAX_CHARS, checkNarrative } from "./security-narrative-check.js";
import type { NarrativeInputV1 } from "./security-narrative-prompt.js";

function input(over: Partial<NarrativeInputV1> = {}): NarrativeInputV1 {
  return {
    v: 1,
    place: { name: "Maria's office", kind: "staff only" },
    scope: "area",
    day: "Tuesday 22 September",
    siteMode: "closed",
    modeSetBy: "opening hours",
    codes: [{ code: "after_hours_presence", sentence: "Someone was seen inside while the site was closed", facts: { mode: "closed (opening hours)" } }],
    events: [{ at: "2:14 AM", until: "2:16 AM", what: "person", source: "Back camera", part: "the 'till' part of the view", found: "live" }],
    counts: { events: 1, shown: 1 },
    times: ["2:14 AM", "2:16 AM"],
    ...over,
  };
}

/** The box's directory: display-name tokens and usernames. */
const NAMES = ["Maria Lopez", "Stefan", "jordan.k", "Al"];
const GOOD = "Someone was seen in Maria's office on the Back camera at 2:14 AM while the site was closed. They left the 'till' part of the view at 2:16 AM.";

describe("checkNarrative", () => {
  it("a plain, factual summary passes — trimmed, with runs of whitespace collapsed", () => {
    expect(checkNarrative(`  ${GOOD.replace(". They", ".\n\n  They")}  `, input(), NAMES)).toEqual({ ok: true, text: GOOD });
  });

  describe("SHAPE", () => {
    it.each([
      ["empty", "   "],
      ["over 700 chars", `${"Someone was there. ".repeat(40)}`],
      ["over five sentences", "One. Two. Three. Four. Five. Six."],
      ["a link", "Someone was seen. See http://box.local for more."],
      ["a backtick", "Someone was seen at `2:14 AM`."],
      ["a heading", "# Summary\nSomeone was seen."],
      ["a list", "Someone was seen:\n* at 2:14 AM"],
      ["a table", "Someone | 2:14 AM"],
      ["a control character", "Someone was seen\u0007 inside."],
      ["a bidi override", "Someone was seen ‮inside."],
    ])("refuses %s", (_l, text) => {
      expect(checkNarrative(text, input(), NAMES)).toEqual({ ok: false, rule: "SHAPE" });
    });

    it("five sentences and exactly 700 chars pass", () => {
      expect(checkNarrative("One thing. Two. Three. Four. Five.", input(), NAMES).ok).toBe(true);
      const long = `Someone was seen inside${" and then inside".repeat(50)}`.slice(0, NARRATIVE_MAX_CHARS - 1) + ".";
      expect(long).toHaveLength(NARRATIVE_MAX_CHARS);
      expect(checkNarrative(long, input(), NAMES).ok).toBe(true);
      expect(NARRATIVE_MAX_CHARS).toBe(700);
    });
  });

  describe("NAMES", () => {
    it.each([
      ["a first name from the directory", "Stefan was seen in the stock room at 2:14 AM."],
      ["a surname, any case", "Someone like LOPEZ was seen at 2:14 AM."],
      ["a username token", "Jordan was seen at 2:14 AM."],
    ])("refuses %s", (_l, text) => {
      expect(checkNarrative(text, input(), NAMES)).toEqual({ ok: false, rule: "NAMES" });
    });

    it("an input name's own phrase may be written (the area 'Maria's office'); short tokens and substrings never count", () => {
      expect(checkNarrative("Someone was seen in Maria's office at 2:14 AM.", input(), NAMES).ok).toBe(true);
      // 'Al' is under 3 letters; 'Stefanie' is not the whole word 'Stefan'.
      expect(checkNarrative("Someone was seen by the alley at 2:14 AM. A mannequin named Stefanie was not.", input(), NAMES).ok).toBe(true);
      // Without the area, Maria is a person's name again.
      expect(checkNarrative("Someone was seen in Maria's office at 2:14 AM.", input({ place: { name: "Stock room", kind: "inside" } }), NAMES)).toEqual({
        ok: false,
        rule: "NAMES",
      });
    });

    // #2423 review 1: an input name exempted its words EVERYWHERE, so any person whose name appeared in a place or
    // camera name could be named anywhere in the text; and accents, fullwidth letters and invisible characters
    // slipped a name past the word match. Now only the exact input phrase is set aside; the rest is checked against
    // the whole directory, both sides compared without marks, format characters or width.
    describe("an input name sets aside only its own exact phrase (#2423 review 1)", () => {
      const DIR = ["Maria Lopez", "José Álvarez", "Renée Martin", "Stefan"];
      it.each([
        ["Maria outside the area's name", "Maria was seen near the office at 2:14 AM.", input()],
        ["Maria next to the area's name", "Maria was in Maria's office at 2:14 AM.", input()],
        ["Maria's office named, then Maria alone", "Someone was seen in Maria's office at 2:14 AM. Maria left at 2:16 AM.", input()],
        [
          "a camera called Maria's desk, then Maria",
          "Maria was seen at 2:14 AM.",
          input({ events: [{ at: "2:14 AM", until: null, what: "person", source: "Maria's desk", part: null, found: "live" }] }),
        ],
        ["Jose without the accent", "Jose was seen at 2:14 AM.", input()],
        ["José with it", "José was seen at 2:14 AM.", input()],
        // The mark mid-name: "Renée" read with its accent kept is "rene" + "e", and "Renee" would pass.
        ["Renee for Renée", "Renee was seen at 2:14 AM.", input()],
        ["José with a combining accent", "Jose\u0301 was seen at 2:14 AM.", input()],
        ["a surname, upper case and accented", "Someone like ÁLVAREZ was seen at 2:14 AM.", input()],
        ["Lopez split by a zero-width space", "Lo\u200bpez was seen at 2:14 AM.", input()],
        ["Lopez split by a zero-width joiner", "Lo\u200dpez was seen at 2:14 AM.", input()],
        ["Lopez split by a word joiner", "Lo\u2060pez was seen at 2:14 AM.", input()],
        ["Lopez split by a soft hyphen", "Lo\u00adpez was seen at 2:14 AM.", input()],
        ["Maria in fullwidth letters", "\uff2d\uff41\uff52\uff49\uff41 was seen at 2:14 AM.", input()],
      ])("refuses %s", (_l, text, inp) => {
        expect(checkNarrative(text, inp, DIR)).toEqual({ ok: false, rule: "NAMES" });
      });

      it.each([
        ["the area's name", "Someone was seen in Maria's office at 2:14 AM."],
        ["the area's name, any case", "Someone was seen in MARIA'S OFFICE at 2:14 AM."],
        ["the area's name with a curly apostrophe", "Someone was seen in Maria\u2019s office at 2:14 AM."],
        ["the camera and the part of its view", "Someone was seen on the Back camera in the 'till' part of the view at 2:14 AM."],
      ])("passes %s", (_l, text) => {
        expect(checkNarrative(text, input(), DIR)).toEqual({ ok: true, text });
      });

      it("the phrase is a whole phrase: a longer word that starts with it is not set aside", () => {
        const inp = input({ place: { name: "Maria", kind: "inside" } });
        expect(checkNarrative("Someone was seen in Maria at 2:14 AM.", inp, DIR).ok).toBe(true);
        expect(checkNarrative("Someone was seen in Marias at 2:14 AM.", inp, [...DIR, "Marias"])).toEqual({ ok: false, rule: "NAMES" });
      });
    });

    it("the words the prompt tells the model to use are never a name, even if someone is called that", () => {
      expect(checkNarrative("Someone was seen by a person at 2:14 AM, and Droplet flagged it.", input(), ["Someone Person", "droplet"]).ok).toBe(true);
    });
  });

  describe("TIMES", () => {
    it("a time in the input passes; one minute off does not", () => {
      expect(checkNarrative("Someone was seen at 2:14 AM.", input(), NAMES).ok).toBe(true);
      expect(checkNarrative("Someone was seen at 2:15 AM.", input(), NAMES)).toEqual({ ok: false, rule: "TIMES" });
    });

    it("case and spacing are the same time; the bare clock of an input time is that time; 24-hour and PM-for-AM are not", () => {
      expect(checkNarrative("Someone was seen at 2:14am and left by 2:16.", input(), NAMES).ok).toBe(true);
      expect(checkNarrative("Someone was seen at 02:14.", input(), NAMES)).toEqual({ ok: false, rule: "TIMES" });
      expect(checkNarrative("Someone was seen at 14:14.", input(), NAMES)).toEqual({ ok: false, rule: "TIMES" });
      expect(checkNarrative("Someone was seen at 2:14 PM.", input(), NAMES)).toEqual({ ok: false, rule: "TIMES" });
    });

    it("no times in the input → any clock in the text fails", () => {
      expect(checkNarrative("Someone was seen at 2:14 AM.", input({ times: [] }), NAMES)).toEqual({ ok: false, rule: "TIMES" });
      expect(checkNarrative("Someone was seen inside while the site was closed.", input({ times: [] }), NAMES).ok).toBe(true);
    });
  });

  describe("WORDS", () => {
    it.each([
      "monitor",
      "monitored",
      "alarm",
      "armed",
      "secure",
      "secured",
      "protected",
      "guard",
      "guarded",
      "zone",
      "zones",
      "intruder",
      "intruders",
      "burglar",
      "burglars",
      "thief",
      "thieves",
      "break-in",
      "stole",
      "stolen",
    ])("refuses %s", (word) => {
      expect(checkNarrative(`Someone was seen at 2:14 AM, ${word.toUpperCase()} it seems.`, input(), NAMES)).toEqual({ ok: false, rule: "WORDS" });
    });

    it("whole words only: 'timezone', 'armchair', 'secureness'-like substrings pass", () => {
      expect(checkNarrative("Someone sat in the armchair near the safeguarding sign at 2:14 AM, in the site timezone.", input(), NAMES).ok).toBe(true);
    });
  });

  it("rules are checked SHAPE, NAMES, TIMES, WORDS — the first that fails is the one named", () => {
    expect(checkNarrative("Stefan broke in at 3:00 AM. `x`", input(), NAMES)).toEqual({ ok: false, rule: "SHAPE" });
    expect(checkNarrative("Stefan was an intruder at 3:00 AM.", input(), NAMES)).toEqual({ ok: false, rule: "NAMES" });
    expect(checkNarrative("An intruder at 3:00 AM.", input(), NAMES)).toEqual({ ok: false, rule: "TIMES" });
  });
});
