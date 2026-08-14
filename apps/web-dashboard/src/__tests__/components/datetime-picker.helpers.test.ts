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
  quarterHourOptionsForDevice,
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

    it("stays pinned to a 24-hour clock — it is the SSR/hydration baseline", () => {
      // If this ever localizes, every non-en-GB visitor gets a hydration
      // mismatch on the calendar form. The device-locale swap belongs in
      // quarterHourOptionsForDevice(), called after mount.
      const byValue = new Map(quarterHourOptions().map((o) => [o.value, o.label]));
      expect(byValue.get("09:45")).toBe("09:45");
      expect(byValue.get("14:30")).toBe("14:30");
      expect(quarterHourOptions().some((o) => /AM|PM/i.test(o.label))).toBe(false);
    });
  });

  // WARP-1793: QA read "09:45"/"14:30" on a US iPhone with no AM/PM anywhere.
  describe("quarterHourOptionsForDevice", () => {
    const resolved = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
    }).resolvedOptions();
    const is12Hour =
      resolved.hourCycle === "h11" || resolved.hourCycle === "h12";

    it("keeps the machine values byte-identical to the pinned grid", () => {
      // Only the label is localized. If values drifted, the <select> would
      // stop matching its state and every onChange payload would change shape.
      expect(quarterHourOptionsForDevice().map((o) => o.value)).toEqual(
        quarterHourOptions().map((o) => o.value),
      );
    });

    it("gives every slot a non-empty label", () => {
      for (const o of quarterHourOptionsForDevice()) {
        expect(o.label.length).toBeGreaterThan(0);
      }
    });

    it.runIf(is12Hour)(
      "renders a 12-hour clock with a meridiem on a 12-hour runtime",
      () => {
        const byValue = new Map(
          quarterHourOptionsForDevice().map((o) => [o.value, o.label]),
        );
        // `hour: "numeric"` (not "2-digit") so this reads "9:45 AM", which is
        // what QA asked for, rather than the clumsier "09:45 AM".
        expect(byValue.get("09:45")).toMatch(/^9:45\s?AM$/i);
        expect(byValue.get("14:30")).toMatch(/^2:30\s?PM$/i);
      },
    );

    it.runIf(!is12Hour)(
      "keeps a 24-hour clock on a 24-hour runtime",
      () => {
        const byValue = new Map(
          quarterHourOptionsForDevice().map((o) => [o.value, o.label]),
        );
        expect(byValue.get("14:30")).toMatch(/14[:.]30/);
        expect(byValue.get("14:30")).not.toMatch(/PM/i);
      },
    );
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
