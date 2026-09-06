/**
 * WARP-2733 (ADR-048) — the consent surface, and the control that must not exist.
 *
 * Three things under test, and none of them is layout.
 *
 * 1. THE READBACK IS THE SERVER'S. The card renders the sentences the server
 *    derived from the policy table and adds none of its own. A client that
 *    composed its own description would keep describing the old table after a
 *    deploy changed it — the box would then do something the owner was never
 *    told about while the screen still showed the old promise. That is not a
 *    stale string, it is consent obtained for a different thing, so the test
 *    swaps the server's list and asserts the screen follows it exactly.
 *
 * 2. 🔴 THERE IS NO "ACCEPT ALL". Asserted by ABSENCE, which is the only way to
 *    assert it. WARP-2179 deferred batching precisely so it could not become
 *    allow-all, and a queue of cards with one button underneath is allow-all
 *    wearing a review surface's clothes. This test is what makes adding one a
 *    deliberate act that turns a red test green-by-deletion rather than a
 *    convenience someone ships on a Friday.
 *
 * 3. THE CANARY REFUSAL REACHES THE OWNER AS WORDS. A 422 whose body says
 *    `auto_needs_canary` must arrive as "Droplet needs to check how well it
 *    reads your documents…". A toggle that silently fails to save is worse than
 *    one that refuses: the owner walks away believing auto mode is on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: Record<string, unknown> & { children?: unknown }) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const useFilingSummaryMock = vi.hoisted(() => vi.fn());
const useFilingProposalsMock = vi.hoisted(() => vi.fn());
const useFilingDecidedMock = vi.hoisted(() => vi.fn());
const useFilingRulesMock = vi.hoisted(() => vi.fn());
const useFilingSkippedMock = vi.hoisted(() => vi.fn());
const setModeMock = vi.hoisted(() => vi.fn());
const setLevelMock = vi.hoisted(() => vi.fn());

vi.mock("./useFiling", () => ({
  useFilingSummary: useFilingSummaryMock,
  useFilingProposals: useFilingProposalsMock,
  useFilingDecided: useFilingDecidedMock,
  useFilingRules: useFilingRulesMock,
  useFilingSkipped: useFilingSkippedMock,
  useFilingActions: () => ({
    apply: vi.fn(),
    reject: vi.fn(),
    notSame: vi.fn(),
    undo: vi.fn(),
    revokeRule: vi.fn(),
    setMode: setModeMock,
    setLevel: setLevelMock,
  }),
}));

import { FilingPromotion, FilingSettings } from "./FilingSettings";
import { FilingSurface } from "./FilingSurface";
import type { FilingProposal, FilingSummary } from "./useFiling";

/** What the SERVER said. Deliberately not the real sentences: if the component
 *  were writing its own, these would not appear. */
const SERVER_READBACK = [
  "Files uploads and emails to customers you already have.",
  "Never adds a new customer by itself — those always wait for you.",
  "Never reads or files anything that looks like a patient record.",
  "Everything it does can be undone with one click.",
  "Runs as: Ada Lovelace. Turned on 5 Sep.",
];

const SUMMARY: FilingSummary = {
  mode: "auto",
  level: "links_only",
  vertical: "general",
  enabled: true,
  pending: 3,
  readback: SERVER_READBACK,
  promotion: { offer: false },
};

const proposal = (id: string): FilingProposal => ({
  id,
  kind: "LINK_FILE",
  status: "PENDING",
  policyClass: "REVIEW",
  policyReason: "Droplet is set to ask you first.",
  confidence: 88,
  phiVerdict: "CLEAN",
  matchKind: "DOMAIN",
  sourceKind: "FILE",
  ncFileId: 1,
  createdAt: "2026-09-05T10:00:00.000Z",
  decidedAt: null,
  autoApplied: false,
  readable: true,
  payload: {
    companyName: "Northgate Dental",
    file: { ncFileId: 1, filePath: "/Customers/inv.pdf", fileSpace: "files" },
  },
  evidence: [{ quote: "Northgate Dental" }],
});

beforeEach(() => {
  toastMock.mockClear();
  setModeMock.mockReset().mockResolvedValue(undefined);
  setLevelMock.mockReset().mockResolvedValue(undefined);
  useFilingSummaryMock.mockReturnValue({ summary: SUMMARY, mutate: vi.fn() });
  useFilingProposalsMock.mockReturnValue({
    proposals: [proposal("a"), proposal("b"), proposal("c")],
    isLoading: false,
    mutate: vi.fn(),
  });
  useFilingDecidedMock.mockReturnValue({ proposals: [], mutate: vi.fn() });
  useFilingRulesMock.mockReturnValue({ rules: [], isLoading: false, mutate: vi.fn() });
  useFilingSkippedMock.mockReturnValue({ items: [], isLoading: false, mutate: vi.fn() });
});

describe("🔴 the readback is the server's, verbatim", () => {
  it("renders exactly the sentences it was given and invents none", () => {
    const { container } = render(<FilingSettings />);
    const items = Array.from(
      container.querySelectorAll(".filing-readback li"),
      (li) => li.textContent,
    );
    expect(items).toEqual(SERVER_READBACK);
  });

  it("MUTATION: hardcode the sentences — a table change stops reaching the screen", () => {
    // The failure this catches: someone widens `CREATE_PROJECT` to AUTO in
    // `policy.ts` and the settings card still promises it never creates
    // anything. The owner's consent then covers a smaller thing than the box
    // does. Swapping the server's list must swap the screen.
    useFilingSummaryMock.mockReturnValue({
      summary: {
        ...SUMMARY,
        readback: ["Starts a project when a document names one for a customer it knows."],
      },
      mutate: vi.fn(),
    });
    const { container } = render(<FilingSettings />);
    const items = Array.from(
      container.querySelectorAll(".filing-readback li"),
      (li) => li.textContent,
    );
    expect(items).toEqual([
      "Starts a project when a document names one for a customer it knows.",
    ]);
  });

  it("says nothing about limits it was told nothing about", () => {
    useFilingSummaryMock.mockReturnValue({
      summary: { ...SUMMARY, readback: undefined },
      mutate: vi.fn(),
    });
    const { container } = render(<FilingSettings />);
    // No heading with an empty list under it: an empty "What this means" reads
    // as "this means nothing", which is a different and worse claim than
    // "the box has not said yet".
    expect(container.querySelector(".filing-readback")).toBeNull();
  });
});

describe("the mode and level controls", () => {
  it("offers how-much only once it is doing things by itself", () => {
    const { container, rerender } = render(<FilingSettings />);
    expect(container.querySelector(".filing-levels")).not.toBeNull();

    useFilingSummaryMock.mockReturnValue({
      summary: { ...SUMMARY, mode: "propose" },
      mutate: vi.fn(),
    });
    rerender(<FilingSettings />);
    // In "suggest only" every card is decided by a person, so a control saying
    // how much it may do unattended describes nothing.
    expect(container.querySelector(".filing-levels")).toBeNull();
  });

  it("speaks the owner's language, never the machine's", () => {
    const { container } = render(<FilingSettings />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/proposal|extraction|entity|confidence|policy|classif/i);
  });

  it("🔴 the canary refusal arrives as words, not a code", async () => {
    setModeMock.mockRejectedValue(
      Object.assign(new Error("auto_needs_canary"), {
        code: "auto_needs_canary",
        status: 422,
      }),
    );
    // Starting from "suggest only": a radio that is already checked fires no
    // change, and this test is about the transition INTO auto.
    useFilingSummaryMock.mockReturnValue({
      summary: { ...SUMMARY, mode: "propose" },
      mutate: vi.fn(),
    });
    render(<FilingSettings />);
    fireEvent.click(screen.getByRole("radio", { name: /File it automatically/ }));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const [message, tone] = toastMock.mock.calls[toastMock.mock.calls.length - 1];
    expect(tone).toBe("error");
    expect(message).toMatch(/how well it reads your documents/i);
    expect(message).not.toMatch(/canary|422|auto_needs/i);
  });
});

describe("the promotion offer", () => {
  it("renders the server's sentence, and only when the server offers", () => {
    const { container, rerender } = render(<FilingPromotion />);
    expect(container.textContent).toBe("");

    useFilingSummaryMock.mockReturnValue({
      summary: {
        ...SUMMARY,
        mode: "propose",
        promotion: {
          offer: true,
          sentence: "You've filed 20 things and corrected 1. Want Droplet to do the easy ones by itself?",
        },
      },
      mutate: vi.fn(),
    });
    rerender(<FilingPromotion />);
    expect(screen.getByText(/You've filed 20 things and corrected 1/)).toBeTruthy();
  });

  it("takes no for an answer", () => {
    useFilingSummaryMock.mockReturnValue({
      summary: { ...SUMMARY, mode: "propose", promotion: { offer: true, sentence: "Ready?" } },
      mutate: vi.fn(),
    });
    const { container } = render(<FilingPromotion />);
    fireEvent.click(screen.getByRole("button", { name: /Not yet/ }));
    expect(container.textContent).toBe("");
    expect(setModeMock).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE ABSENCE TEST.
 *
 * Everything else on this surface is asserted by what it renders. This one is
 * asserted by what it does not, because the control being tested is the one
 * that would quietly undo the feature's whole safety argument: a single click
 * that applies a queue is an unattended write with a human's fingerprint on it,
 * and it reaches every class the policy table refuses — PHI, creates, matches
 * nobody checked.
 *
 * The asymmetry is deliberate and runs in the safe direction: there is no way
 * to accept many things at once, and there ARE ways to undo many. Making a
 * mistake should be slower than fixing one.
 */
describe("🔴 there is no way to accept everything at once", () => {
  const BULK = /accept all|apply all|file all|file them all|approve all|select all|do all|all of them/i;

  it("offers one decision per card and no control that spans them", () => {
    const { container } = render(<FilingSurface />);

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.textContent ?? "").not.toMatch(BULK);
    }
    // One "Yes, file it" per card, and exactly as many as there are cards.
    expect(screen.getAllByRole("button", { name: "Yes, file it" })).toHaveLength(3);
    expect(container.querySelectorAll(".filing-card")).toHaveLength(3);
  });

  it("has no selection checkboxes — the shape a select-all is built from", () => {
    const { container } = render(<FilingSurface />);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    // The only radios are the per-card "which customer" choice and, on the
    // settings tab, the mode. Neither spans cards.
    expect(container.textContent ?? "").not.toMatch(BULK);
  });

  it("MUTATION: an accept-all on the settings tab would be caught too", () => {
    const { container } = render(<FilingSurface />);
    fireEvent.click(screen.getByRole("tab", { name: /What Droplet does/ }));
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.textContent ?? "").not.toMatch(BULK);
    }
  });
});
