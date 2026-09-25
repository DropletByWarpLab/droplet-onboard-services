/**
 * WARP-2980 (ADR-059 P5 PR-C, spec §6.11, §8) — "Was this expected?" on the
 * incident page, as route 18 and route 35 (POST …/verdict) are built:
 *
 *   · the box sends `verdict: null` to anyone who doesn't see every camera —
 *     then nothing renders (DS-005: nothing the box didn't send);
 *   · Expected / Not expected render only at act — the module level (fails
 *     closed) AND the box's own `viewer.level` — AND when the box says this
 *     viewer may give one (`viewer.canGiveVerdict`). Never rendered and then
 *     refused;
 *   · the current answer says who and when;
 *   · after Expected: expected activity is what stops the flags, and adding
 *     it is manage (a link to it at manage; the words alone below it); a
 *     rule code (someone inside while closed) is never quietened by it, and
 *     the page says what changes it instead;
 *   · after Not expected with expected activity still quietening part of
 *     this: the page says so, with the way to it at manage;
 *   · in flight: both buttons aria-disabled, never `disabled`, and a second
 *     press is refused.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VERDICT_COPY as C, VerdictBar, type VerdictBarProps } from "@/components/security/VerdictBar";
import type { IncidentPatternFlagView } from "@/lib/types";

const NOW = new Date("2026-09-23T01:31:00Z");
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;

function trialFlag(over: Partial<IncidentPatternFlagView> = {}): IncidentPatternFlagView {
  return {
    code: "out_of_place",
    effect: "trial",
    severity: "notice",
    key: { kind: "area", zoneId: "z1", camera: null },
    evidence: { eventId: "901", camera: "back_cam", label: "person", at: at("01:14"), summary: "" },
    detail: null,
    suppression: null,
    ...over,
  };
}

function props(over: Partial<VerdictBarProps> = {}): VerdictBarProps {
  return {
    verdict: { state: "unreviewed", byName: null, at: null, codes: [] },
    viewer: { level: "act", acknowledged: false, canGiveVerdict: true },
    flags: [trialFlag()],
    reasonCodes: [],
    openedInMode: "closed",
    moduleLevel: "act",
    busy: false,
    onVerdict: vi.fn(),
    timezone: "Europe/London",
    now: NOW,
    ...over,
  };
}

const buttons = () => ({
  expected: screen.queryByRole("button", { name: C.expected }),
  notExpected: screen.queryByRole("button", { name: C.notExpected }),
});

describe("VerdictBar — who sees it and who can answer", () => {
  it("the box sent no verdict (the viewer doesn't see every camera): nothing renders", () => {
    const { container } = render(<VerdictBar {...props({ verdict: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("unanswered, and this viewer may answer: the question, what an answer does, and both buttons unpressed", () => {
    render(<VerdictBar {...props()} />);
    expect(screen.getByRole("heading", { name: C.title })).toBeInTheDocument();
    expect(screen.getByText(C.hint)).toBeInTheDocument();
    const b = buttons();
    expect(b.expected).toHaveAttribute("aria-pressed", "false");
    expect(b.notExpected).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["the module level is view", { moduleLevel: "view" as const }],
    ["the box says this viewer is at view", { viewer: { level: "view" as const, acknowledged: false, canGiveVerdict: true } }],
    ["the box says this viewer may not answer", { viewer: { level: "act" as const, acknowledged: false, canGiveVerdict: false } }],
  ])("%s: no buttons — and with no answer yet, nothing at all", (_why, over) => {
    const { container } = render(<VerdictBar {...props(over)} />);
    expect(buttons().expected).toBeNull();
    expect(buttons().notExpected).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("an answer someone gave is shown to a viewer who can't answer, without buttons", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["out_of_place"] },
          viewer: { level: "act", acknowledged: false, canGiveVerdict: false },
        })}
      />,
    );
    expect(screen.getByText("Maria said this was expected · 2:25 AM")).toBeInTheDocument();
    expect(buttons().expected).toBeNull();
  });
});

describe("VerdictBar — the answer and what follows it", () => {
  it("Expected: who and when, the Expected button pressed", () => {
    render(<VerdictBar {...props({ verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["out_of_place"] } })} />);
    expect(screen.getByText("Maria said this was expected · 2:25 AM")).toBeInTheDocument();
    expect(buttons().expected).toHaveAttribute("aria-pressed", "true");
    expect(buttons().notExpected).toHaveAttribute("aria-pressed", "false");
  });

  it("Not expected: who and when", () => {
    render(<VerdictBar {...props({ verdict: { state: "not_expected", byName: "Stefan", at: at("01:25"), codes: ["out_of_place"] } })} />);
    expect(screen.getByText("Stefan said this was not expected · 2:25 AM")).toBeInTheDocument();
    expect(buttons().notExpected).toHaveAttribute("aria-pressed", "true");
  });

  it("after Expected, at manage: expected activity is what stops the flag, with the way to add it", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["out_of_place"] },
          viewer: { level: "manage", acknowledged: false, canGiveVerdict: true },
          moduleLevel: "manage",
        })}
      />,
    );
    expect(screen.getByText(C.addExpected)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: C.addExpectedLink })).toHaveAttribute("href", "/security/patterns#patterns-expected");
  });

  it.each([
    ["the module level is act", { moduleLevel: "act" as const, viewer: { level: "manage" as const, acknowledged: false, canGiveVerdict: true } }],
    ["the box says act", { moduleLevel: "manage" as const, viewer: { level: "act" as const, acknowledged: false, canGiveVerdict: true } }],
  ])("after Expected, below manage (%s): who can add it, and no link", (_why, over) => {
    render(<VerdictBar {...props({ verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["out_of_place"] }, ...over })} />);
    expect(screen.getByText(C.askManager)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: C.addExpectedLink })).toBeNull();
  });

  it("after Expected on someone inside while closed, with no flag expected activity could quieten: what changes that instead", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["after_hours_presence"] },
          flags: [],
          reasonCodes: ["after_hours_presence"],
          openedInMode: "closed",
        })}
      />,
    );
    expect(screen.getByText(C.ruleCodesClosed)).toBeInTheDocument();
    expect(screen.queryByText(C.addExpected)).toBeNull();
    expect(screen.queryByText(C.askManager)).toBeNull();
  });

  it("…and while the site was set to away", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: ["after_hours_presence"] },
          flags: [],
          reasonCodes: ["after_hours_presence"],
          openedInMode: "away",
        })}
      />,
    );
    expect(screen.getByText(C.ruleCodesAway)).toBeInTheDocument();
  });

  it("a flag expected activity already keeps quiet is not offered again", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "expected", byName: "Maria", at: at("01:25"), codes: [] },
          flags: [trialFlag({ effect: "suppressed", suppression: { id: "s1", reason: "Cleaner", state: "active" } })],
          moduleLevel: "manage",
          viewer: { level: "manage", acknowledged: false, canGiveVerdict: true },
        })}
      />,
    );
    expect(screen.queryByText(C.addExpected)).toBeNull();
  });

  it("after Not expected, with expected activity still quietening part of this, at manage: says so, with the way to it", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "not_expected", byName: "Stefan", at: at("01:25"), codes: ["out_of_place"] },
          flags: [trialFlag(), trialFlag({ code: "long_dwell", effect: "suppressed", suppression: { id: "s1", reason: "Stocktake", state: "active" } })],
          moduleLevel: "manage",
          viewer: { level: "manage", acknowledged: false, canGiveVerdict: true },
        })}
      />,
    );
    expect(screen.getByText(C.stillQuiet)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: C.reviewExpectedLink })).toHaveAttribute("href", "/security/patterns#patterns-expected");
  });

  it("…below manage: says who can remove it, no link", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "not_expected", byName: "Stefan", at: at("01:25"), codes: ["out_of_place"] },
          flags: [trialFlag({ effect: "suppressed", suppression: { id: "s1", reason: "Stocktake", state: "active" } })],
        })}
      />,
    );
    expect(screen.getByText(C.stillQuietAsk)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: C.reviewExpectedLink })).toBeNull();
  });

  it("…an expected activity that has ended or been removed isn't quietening anything now: no prompt", () => {
    render(
      <VerdictBar
        {...props({
          verdict: { state: "not_expected", byName: "Stefan", at: at("01:25"), codes: ["out_of_place"] },
          flags: [trialFlag({ effect: "suppressed", suppression: { id: "s1", reason: "Stocktake", state: "removed" } })],
          moduleLevel: "manage",
          viewer: { level: "manage", acknowledged: false, canGiveVerdict: true },
        })}
      />,
    );
    expect(screen.queryByText(C.stillQuiet)).toBeNull();
    expect(screen.queryByText(C.stillQuietAsk)).toBeNull();
  });
});

describe("VerdictBar — pressing", () => {
  it("each button sends its answer", () => {
    const onVerdict = vi.fn();
    render(<VerdictBar {...props({ onVerdict })} />);
    fireEvent.click(buttons().expected!);
    fireEvent.click(buttons().notExpected!);
    expect(onVerdict.mock.calls).toEqual([["expected"], ["not_expected"]]);
  });

  it("in flight: aria-disabled (never disabled, so focus stays) and a press is refused", () => {
    const onVerdict = vi.fn();
    render(<VerdictBar {...props({ busy: true, onVerdict })} />);
    const b = buttons();
    for (const el of [b.expected!, b.notExpected!]) {
      expect(el).toHaveAttribute("aria-disabled", "true");
      expect(el).not.toBeDisabled();
      fireEvent.click(el);
    }
    expect(onVerdict).not.toHaveBeenCalled();
  });
});
