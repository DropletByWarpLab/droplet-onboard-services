/**
 * Calendar UX clarity (Samantha QA #bugs) — pure conversion helpers behind the
 * date + 15-minute time-dropdown picker.
 *
 * The picker must preserve the existing local-input contract used by EventForm
 * (isoToLocalInput / localInputToIso) and RemindersPanel: the value it reads
 * and writes is a `YYYY-MM-DDTHH:mm` *local* string (no TZ suffix), identical
 * to what a native `datetime-local` input produces. These helpers split that
 * string into its date + time parts and recombine them so the surrounding ISO
 * round-trip stays byte-identical.
 */
import { describe, it, expect } from "vitest";
import {
  splitLocalInput,
  joinLocalInput,
  quarterHourOptions,
  snapTimeToQuarter,
} from "@/components/calendar/datetime-picker-helpers";

describe("datetime picker helpers", () => {
  describe("splitLocalInput", () => {
    it("splits a YYYY-MM-DDTHH:mm value into date + time parts", () => {
      expect(splitLocalInput("2026-05-12T09:30")).toEqual({
        date: "2026-05-12",
        time: "09:30",
      });
    });

    it("returns empty parts for an empty value", () => {
      expect(splitLocalInput("")).toEqual({ date: "", time: "" });
    });

    it("tolerates a seconds suffix by dropping it", () => {
      expect(splitLocalInput("2026-05-12T09:30:00")).toEqual({
        date: "2026-05-12",
        time: "09:30",
      });
    });
  });

  describe("joinLocalInput", () => {
    it("recombines date + time into a YYYY-MM-DDTHH:mm value", () => {
      expect(joinLocalInput("2026-05-12", "09:30")).toBe("2026-05-12T09:30");
    });

    it("round-trips through split → join unchanged", () => {
      const original = "2026-12-31T23:45";
      const { date, time } = splitLocalInput(original);
      expect(joinLocalInput(date, time)).toBe(original);
    });

    it("returns empty when either part is missing", () => {
      expect(joinLocalInput("", "09:30")).toBe("");
      expect(joinLocalInput("2026-05-12", "")).toBe("");
    });
  });

  describe("quarterHourOptions", () => {
    it("produces 96 options (24h × 4 quarters)", () => {
      expect(quarterHourOptions()).toHaveLength(96);
    });

    it("starts at 00:00 and ends at 23:45 in 15-minute steps", () => {
      const opts = quarterHourOptions();
      expect(opts[0].value).toBe("00:00");
      expect(opts[1].value).toBe("00:15");
      expect(opts[2].value).toBe("00:30");
      expect(opts[3].value).toBe("00:45");
      expect(opts[4].value).toBe("01:00");
      expect(opts[opts.length - 1].value).toBe("23:45");
    });

    it("gives every option a human label", () => {
      const opts = quarterHourOptions();
      for (const o of opts) {
        expect(o.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe("snapTimeToQuarter", () => {
    it("keeps an already-aligned time unchanged", () => {
      expect(snapTimeToQuarter("09:30")).toBe("09:30");
    });

    it("rounds an off-grid time to the nearest quarter (down)", () => {
      expect(snapTimeToQuarter("09:37")).toBe("09:30");
    });

    it("rounds an off-grid time to the nearest quarter (up)", () => {
      expect(snapTimeToQuarter("09:38")).toBe("09:45");
    });

    it("rolls 23:53 up to 23:45 (never past the last grid slot of the day)", () => {
      expect(snapTimeToQuarter("23:53")).toBe("23:45");
    });

    it("returns empty for an empty time", () => {
      expect(snapTimeToQuarter("")).toBe("");
    });
  });
});
