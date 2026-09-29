/**
 * WARP-2980 (ADR-059 P5 PR-C, spec §6.10, §6.13, §8) — the pattern flags on
 * the incident page: route 18's `patternFlags`, which the box sends apart
 * from the counted reasons.
 *
 *   · a TRIAL flag carries the Trial chip and says Droplet would have flagged
 *     it; it is never tinted by its would-be severity (it raised nothing);
 *   · a flag expected activity kept quiet is struck through, says which
 *     expected activity and links to it — and is never shown as counted: no
 *     severity tint, no Trial chip, whatever its would-be severity;
 *   · the numbers behind a flag are worded only when the box sent them;
 *     otherwise the evidence line alone (DS-005: nothing is filled in).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FLAG_COPY, PatternFlagList, flagNumbers } from "@/components/security/PatternFlagList";
import type { IncidentPatternFlagView } from "@/lib/types";

const NOW = new Date("2026-09-23T01:31:00Z");
const TZ = "Europe/London";
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;
const cameraLabel = (name: string) => (name === "back_cam" ? "Back camera" : name);

const BASE_DETAIL = {
  dayType: "weekday",
  hour: 2,
  windowFrom: "2026-08-26",
  windowTo: "2026-09-22",
  mode: "closed",
  zoneKind: "restricted",
  rulesetVersion: 3,
};

function flag(over: Partial<IncidentPatternFlagView> = {}): IncidentPatternFlagView {
  return {
    code: "out_of_place",
    effect: "trial",
    severity: "notice",
    key: { kind: "area", zoneId: "z1", camera: null },
    evidence: { eventId: "901", camera: "back_cam", label: "person", at: at("01:14"), summary: "Person in aisle" },
    detail: {
      ...BASE_DETAIL,
      daysObserved: 20,
      daysWithEvent: 0,
      smoothedDaysObserved: "20",
      smoothedDaysWithEvent: "0.25",
      p: "0.0161",
      flagsBelow: "0.05",
    },
    suppression: null,
    ...over,
  };
}

function renderList(flags: IncidentPatternFlagView[]) {
  return render(<PatternFlagList flags={flags} cameraLabel={cameraLabel} timezone={TZ} now={NOW} />);
}

describe("flagNumbers — the numbers behind a flag, only when the box sent them", () => {
  it("out of place: how many of the watched days of that kind something was seen at this hour", () => {
    expect(flagNumbers(flag())).toBe("seen on 0 of 20 weekdays at this hour");
    expect(flagNumbers(flag({ detail: { ...BASE_DETAIL, dayType: "weekend", daysObserved: 8, daysWithEvent: 1 } }))).toBe(
      "seen on 1 of 8 weekend days at this hour",
    );
  });

  it("busier than usual: the count in the event's hour and the usual rate", () => {
    const f = flag({ code: "unusual_volume", detail: { ...BASE_DETAIL, k: 14, flagsFrom: 4, lambda: "0.400", typicalPerHour: "0.400", tailP: "1.2e-14", slotMinutes: 60 } });
    expect(flagNumbers(f)).toBe("seen 14 times between 2 and 3 AM · usually about 0.4");
  });

  it("stayed longer than usual: the visit and the longest usual one", () => {
    const f = flag({ code: "long_dwell", detail: { ...BASE_DETAIL, durationSec: 360, p99Sec: 95, thresholdSec: 120, samples: 41 } });
    expect(flagNumbers(f)).toBe("stayed 6 min · the longest usual visit is 95 s");
  });

  it("withheld, missing or malformed numbers → nothing (never a guess, never a 0 the box didn't send)", () => {
    expect(flagNumbers(flag({ detail: null }))).toBeNull();
    expect(flagNumbers(flag({ detail: { withheld: true } as unknown as IncidentPatternFlagView["detail"] }))).toBeNull();
    expect(flagNumbers(flag({ detail: { ...BASE_DETAIL, daysObserved: "20", daysWithEvent: 0 } }))).toBeNull();
    expect(flagNumbers(flag({ detail: { ...BASE_DETAIL, daysObserved: 20 } }))).toBeNull();
    expect(flagNumbers(flag({ code: "unusual_volume", detail: { ...BASE_DETAIL, k: 14 } }))).toBeNull();
    expect(flagNumbers(flag({ code: "unusual_volume", detail: { ...BASE_DETAIL, k: 14, lambda: "not a number", hour: 2 } }))).toBeNull();
    expect(flagNumbers(flag({ code: "long_dwell", detail: { ...BASE_DETAIL, durationSec: 360 } }))).toBeNull();
  });
});

describe("PatternFlagList", () => {
  it("a trial flag: its name, the Trial chip, what trial means, and the evidence with its numbers", () => {
    renderList([flag({ severity: "alert" })]);
    const row = screen.getByTestId("pattern-flag-out_of_place-trial");
    expect(row).toHaveAttribute("data-effect", "trial");
    expect(within(row).getByText("Not usual at this time")).toBeInTheDocument();
    expect(within(row).getByText(FLAG_COPY.trial)).toHaveClass("badge");
    expect(row).toHaveTextContent(FLAG_COPY.trialNote);
    expect(row).toHaveTextContent("Person · Back camera · 2:14 AM · seen on 0 of 20 weekdays at this hour");
    // It raised nothing: never tinted by the severity it would have carried.
    expect(row.querySelector(".sev-ic")).toBeNull();
  });

  it("a flag expected activity kept quiet is struck through, names the expected activity and links to it — never shown as counted", () => {
    renderList([
      flag({
        effect: "suppressed",
        severity: "alert",
        suppression: { id: "s1", reason: "The cleaner comes on weekday nights", state: "active" },
      }),
    ]);
    const row = screen.getByTestId("pattern-flag-out_of_place-suppressed");
    expect(row).toHaveAttribute("data-effect", "suppressed");
    const name = within(row).getByText("Not usual at this time");
    expect(name.closest("s")).not.toBeNull();
    expect(row).toHaveTextContent(`${FLAG_COPY.expected} “The cleaner comes on weekday nights”`);
    expect(within(row).getByRole("link", { name: FLAG_COPY.seeExpected })).toHaveAttribute("href", "/security/patterns#patterns-expected");
    // Held back is not counted: no severity tint, no Trial chip, no "would have flagged".
    expect(row.querySelector(".sev-ic")).toBeNull();
    expect(within(row).queryByText(FLAG_COPY.trial)).toBeNull();
    expect(row).not.toHaveTextContent(FLAG_COPY.trialNote);
  });

  it("expected activity that has since ended or been removed says so", () => {
    renderList([
      flag({ effect: "suppressed", suppression: { id: "s1", reason: "Cleaner", state: "removed" } }),
      flag({
        code: "long_dwell",
        effect: "suppressed",
        detail: { ...BASE_DETAIL, durationSec: 360, p99Sec: 95, thresholdSec: 120, samples: 41 },
        suppression: { id: "s2", reason: "Stocktake", state: "expired" },
      }),
    ]);
    expect(screen.getByTestId("pattern-flag-out_of_place-suppressed")).toHaveTextContent(`${FLAG_COPY.expected} “Cleaner” ${FLAG_COPY.sinceRemoved}`);
    expect(screen.getByTestId("pattern-flag-long_dwell-suppressed")).toHaveTextContent(`${FLAG_COPY.expected} “Stocktake” ${FLAG_COPY.sinceEnded}`);
  });

  it("a quietened flag whose expected activity the box didn't name still says it was kept quiet", () => {
    renderList([flag({ effect: "suppressed", suppression: null })]);
    const row = screen.getByTestId("pattern-flag-out_of_place-suppressed");
    expect(row).toHaveTextContent(FLAG_COPY.keptQuiet);
    expect(within(row).getByRole("link", { name: FLAG_COPY.seeExpected })).toBeInTheDocument();
  });

  it("numbers the box didn't send: the evidence line alone", () => {
    renderList([flag({ detail: null })]);
    const row = screen.getByTestId("pattern-flag-out_of_place-trial");
    const lines = [...row.querySelectorAll("[data-evidence]")].map((n) => n.textContent);
    expect(lines).toEqual(["Person · Back camera · 2:14 AM"]);
  });

  it("flags of one kind and effect are one block, one evidence line each, in the order the box sent them", () => {
    renderList([
      flag({ evidence: { eventId: "901", camera: "back_cam", label: "person", at: at("01:14"), summary: "" } }),
      flag({ code: "long_dwell", detail: { ...BASE_DETAIL, durationSec: 360, p99Sec: 95, thresholdSec: 120, samples: 41 } }),
      flag({ evidence: { eventId: "902", camera: "back_cam", label: "person", at: at("01:20"), summary: "" } }),
    ]);
    const blocks = screen.getAllByRole("listitem");
    expect(blocks.map((b) => b.getAttribute("data-testid"))).toEqual(["pattern-flag-out_of_place-trial", "pattern-flag-long_dwell-trial"]);
    const lines = [...blocks[0]!.querySelectorAll("[data-evidence]")].map((n) => n.textContent);
    expect(lines).toEqual([
      "Person · Back camera · 2:14 AM · seen on 0 of 20 weekdays at this hour",
      "Person · Back camera · 2:20 AM · seen on 0 of 20 weekdays at this hour",
    ]);
  });

  it("nothing sent, nothing rendered", () => {
    const { container } = renderList([]);
    expect(container).toBeEmptyDOMElement();
  });
});
