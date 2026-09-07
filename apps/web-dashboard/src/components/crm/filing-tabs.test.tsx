/**
 * WARP-2731 (ADR-048) — the Health row, the Rules tab and the Skipped tab.
 *
 * Three things under test, and all three are about what the surface REFUSES to
 * say:
 *
 *   The Health row is quiet unless something is wrong. A panel that always has
 *   a line is one nobody reads on the day it matters.
 *
 *   The Skipped list never shows a filename or a snippet. Quoting the document
 *   on the page that explains why it was not read would undo the skip.
 *
 *   Neither speaks the machine's language (ADR-002), same as the review card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: Record<string, unknown> & { children?: unknown }) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

const useFilingSummaryMock = vi.hoisted(() => vi.fn());
const useFilingRulesMock = vi.hoisted(() => vi.fn());
const useFilingSkippedMock = vi.hoisted(() => vi.fn());
const useFilingDecidedMock = vi.hoisted(() => vi.fn());
vi.mock("./useFiling", () => ({
  useFilingSummary: useFilingSummaryMock,
  useFilingRules: useFilingRulesMock,
  useFilingSkipped: useFilingSkippedMock,
  useFilingDecided: useFilingDecidedMock,
  useFilingActions: () => ({ revokeRule: vi.fn(), undo: vi.fn() }),
}));

import { FilingTabList, HealthRow, RecentlyFiled, RulesTab, SkippedTab } from "./FilingTabs";

const HEALTHY = {
  pending: 2,
  failed: 0,
  hoursSinceLastIndex: 1,
  lastTickAt: new Date(Date.now() - 90_000).toISOString(),
  paused: false,
  pausedReason: null,
};

beforeEach(() => {
  useFilingSummaryMock.mockReturnValue({ summary: { enabled: true, pending: 2 } });
  useFilingRulesMock.mockReturnValue({ rules: [], isLoading: false, mutate: vi.fn() });
  useFilingSkippedMock.mockReturnValue({ items: [], isLoading: false, mutate: vi.fn() });
  useFilingDecidedMock.mockReturnValue({ proposals: [], mutate: vi.fn() });
});

describe("🔴 the Health row reports silences, not successes", () => {
  it("says when it last looked, and nothing else when all is well", () => {
    const { container } = render(<HealthRow health={HEALTHY} />);
    expect(screen.getByText(/Last checked for new files/)).toBeTruthy();
    // No warnings, no counts of things that went right. A row that always has
    // something to say stops being read.
    expect(container.textContent).not.toMatch(/could not|paused|not finished/i);
  });

  it("MUTATION: drop the stale-corpus note — a box that stopped indexing looks fine", () => {
    // The failure this catches: a box upgraded without `rag-re-embed.sh` lands
    // every new file failed AT THE INDEXER. Filing then has nothing to do and
    // is genuinely healthy, so every other indicator is green and the owner
    // has no way to tell "nothing arrived" from "nothing works".
    render(<HealthRow health={{ ...HEALTHY, hoursSinceLastIndex: 96 }} />);
    expect(screen.getByText(/has not finished reading a new file in 4 days/)).toBeTruthy();
  });

  it("says so while the canary has it paused", () => {
    render(
      <HealthRow health={{ ...HEALTHY, paused: true, pausedReason: "model_unreachable" }} />,
    );
    expect(screen.getByText(/paused/)).toBeTruthy();
  });

  it("points a failed count at the list that explains it", () => {
    render(<HealthRow health={{ ...HEALTHY, failed: 3 }} />);
    expect(screen.getByText(/3 files could not be read/)).toBeTruthy();
    expect(screen.getByText(/Left alone list/)).toBeTruthy();
  });

  it("renders nothing at all before the summary has loaded", () => {
    const { container } = render(<HealthRow health={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("the tab strip", () => {
  it("names the questions an owner actually asks", () => {
    render(<FilingTabList tab="review" onTab={() => {}} pending={2} />);
    expect(screen.getByRole("tab", { name: /Needs a look/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /What you've taught it/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Left alone/ })).toBeTruthy();
    // WARP-2733 — named for what it answers, not for what it is. "Settings"
    // would be a place you configure a machine; this is where an owner reads
    // what the box is allowed to do without them.
    expect(screen.getByRole("tab", { name: /What Droplet does/ })).toBeTruthy();
  });

  it("shows a count only when there is one", () => {
    const { container } = render(<FilingTabList tab="review" onTab={() => {}} pending={0} />);
    expect(container.querySelector(".filing-tab-count")).toBeNull();
  });
});

describe("the Rules tab", () => {
  it("renders the sentence the server built, and offers to forget it", () => {
    useFilingRulesMock.mockReturnValue({
      rules: [
        {
          id: "r1",
          keyKind: "EMAIL_DOMAIN",
          keyValue: "northgate.example",
          verdict: "ALWAYS_HERE",
          companyId: "c1",
          companyName: "Northgate Dental",
          sentence: "Mail from @northgate.example always files under Northgate Dental.",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      isLoading: false,
      mutate: vi.fn(),
    });
    render(<RulesTab />);
    expect(
      screen.getByText("Mail from @northgate.example always files under Northgate Dental."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
  });

  it("says what the list is FOR when it is empty", () => {
    render(<RulesTab />);
    expect(screen.getByText(/haven't taught Droplet anything yet/i)).toBeTruthy();
  });
});

describe("🔴 the Skipped tab explains without quoting", () => {
  it("MUTATION: render the filename — the skip page leaks what the skip protected", () => {
    useFilingSkippedMock.mockReturnValue({
      items: [
        {
          sourceRef: "file:8891",
          sourceKind: "FILE",
          reason: "phi_record",
          explanation: "Looked like a personal or patient document — not filed.",
          skippedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          reopenable: false,
        },
      ],
      isLoading: false,
      mutate: vi.fn(),
    });
    const { container } = render(<SkippedTab />);

    expect(
      screen.getByText("Looked like a personal or patient document — not filed."),
    ).toBeTruthy();
    expect(screen.getByText("3 hours ago")).toBeTruthy();
    // The whole point: nothing identifying the document reaches this page.
    expect(container.textContent).not.toMatch(/\.pdf|\.docx|file:8891|\//);
  });

  it("MUTATION: offer a retry on a PHI skip — the screen becomes a button", () => {
    useFilingSkippedMock.mockReturnValue({
      items: [
        {
          sourceRef: "file:1",
          sourceKind: "FILE",
          reason: "phi_record",
          explanation: "Looked like a personal or patient document — not filed.",
          skippedAt: new Date().toISOString(),
          reopenable: false,
        },
      ],
      isLoading: false,
      mutate: vi.fn(),
    });
    render(<SkippedTab />);
    // There is no re-open control on this surface at all in slice 3. Asserting
    // its ABSENCE is the point: adding one for the reopenable reasons must be a
    // deliberate change that turns this test red first.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what the list is FOR when it is empty", () => {
    render(<SkippedTab />);
    expect(screen.getByText(/has not left anything alone/i)).toBeTruthy();
  });
});

/**
 * WARP-2733 — the provenance chip.
 *
 * 🔴 An owner has to be able to tell, without clicking anything, which of these
 * they did and which the box did for them. That distinction is the consent
 * record made visible: everything else in the design says "you agreed to a
 * class of action", and this row is the only place they can check what the
 * class actually did.
 */
describe("🔴 Recently filed says which ones the box did by itself", () => {
  const filed = (id: string, autoApplied: boolean) => ({
    id,
    kind: "LINK_FILE" as const,
    status: "APPLIED",
    policyClass: "AUTO" as const,
    policyReason: null,
    confidence: 96,
    phiVerdict: "CLEAN" as const,
    matchKind: "DOMAIN" as const,
    sourceKind: "FILE" as const,
    ncFileId: 1,
    createdAt: "2026-09-05T09:00:00.000Z",
    decidedAt: "2026-09-05T09:01:00.000Z",
    autoApplied,
    readable: true,
    payload: { companyName: "Northgate Dental" },
    evidence: [],
  });

  it("MUTATION: drop the chip — a hand-filed row and an unattended one look identical", () => {
    useFilingDecidedMock.mockReturnValue({
      proposals: [filed("auto-1", true), filed("hand-1", false)],
      mutate: vi.fn(),
    });
    const { container } = render(<RecentlyFiled onUndo={() => {}} busyId={null} />);

    const chips = container.querySelectorAll(".filing-auto-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("Droplet did this one");

    // Both rows are still undoable. The chip explains provenance; it does not
    // gate the reversal — the one an owner most wants to take back is exactly
    // the one nobody chose.
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(2);
  });
});
