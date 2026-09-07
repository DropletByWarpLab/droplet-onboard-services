/**
 * WARP-2730 (ADR-048) — "Needs a look", the surface.
 *
 * Two things are under test and neither is layout.
 *
 * 1. THE VOICE (ADR-002). The card must never say proposal, extraction,
 *    entity or confidence, and must never render a percentage. Those words
 *    describe the machine's internal state, and a person deciding whether ACME
 *    is a customer should not have to model the machine to answer. This is
 *    asserted rather than commented because copy drifts the moment a card gains
 *    a field.
 *
 * 2. THE EVIDENCE PANEL, which is the whole reason the surface is trustworthy.
 *    Without it the owner is approving an assertion; with it they are checking
 *    a citation. On a MENTIONS document the quotes are already gone by the time
 *    they arrive, and the panel has to SAY SO rather than render an empty box —
 *    an empty evidence panel reads as "there was no evidence", which is a
 *    different and worse claim than "Droplet did not keep the wording".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// setup.ts mocks next/link into a string template, which does not compose with
// children — the WARP-2412 trap where `getByRole("link")` finds nothing.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: Record<string, unknown> & { children?: unknown }) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

import { FilingCard, headlineFor } from "./FilingSurface";
import type { FilingProposal } from "./useFiling";

const base: FilingProposal = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "CREATE_CUSTOMER",
  status: "PENDING",
  policyClass: "REVIEW",
  policyReason: "Droplet is set to ask you first.",
  confidence: 93,
  phiVerdict: "CLEAN",
  matchKind: "NONE",
  sourceKind: "FILE",
  ncFileId: 8891,
  createdAt: "2026-09-05T10:00:00.000Z",
  decidedAt: null,
  readable: true,
  payload: {
    name: "ACME Dental Supply Ltd",
    domain: "acme-dental.example",
    file: { ncFileId: 8891, filePath: "/Customers/acme-invoice.pdf", fileSpace: "files" },
  },
  evidence: [{ quote: "ACME Dental Supply Ltd" }],
};

const noop = () => {};

function renderCard(p: Partial<FilingProposal> = {}) {
  return render(
    <FilingCard p={{ ...base, ...p }} busy={false} onApply={noop} onReject={noop} onNotSame={noop} />,
  );
}

describe("🔴 the card speaks the owner's language", () => {
  it("never uses the machine's words, and never shows a percentage", () => {
    const { container } = renderCard();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/proposal|extraction|entity|confidence/i);
    // 93 is on the row and must not reach the screen: a percentage invites the
    // reader to calibrate against a scale nobody has explained.
    expect(text).not.toMatch(/\b93\b|%/);
  });

  it("says what would happen, in one line", () => {
    renderCard();
    expect(screen.getByText("Add ACME Dental Supply Ltd as a customer")).toBeTruthy();
  });

  it("says WHY it is asking rather than doing", () => {
    renderCard();
    expect(screen.getByText("Droplet is set to ask you first.")).toBeTruthy();
  });

  it("offers the three answers a person actually has", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Yes, file it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeTruthy();
  });
});

describe("🔴 the evidence panel", () => {
  it("shows the quote Droplet read it from", () => {
    renderCard();
    // Matched by the quotation marks, not by the name: the name is also the
    // headline, and a query that cannot tell the two apart would still pass
    // with the evidence panel deleted.
    expect(screen.getByText("“ACME Dental Supply Ltd”")).toBeTruthy();
    expect(screen.getByText("Where Droplet read that")).toBeTruthy();
  });

  it("MUTATION: drop the MENTIONS branch — an empty panel claims there was no evidence", () => {
    renderCard({ phiVerdict: "MENTIONS", evidence: [{ quote: "", chunkIdx: 2 }] });
    expect(
      screen.getByText(/mentions patients, so Droplet did not keep any of its wording/i),
    ).toBeTruthy();
  });

  it("links to the document by name, and only here", () => {
    renderCard();
    // Filenames are PHI (WARP-1983): the name reaches a reviewer on this card
    // and nowhere else — not the CRM timeline, not the logs.
    expect(screen.getByText("acme-invoice.pdf")).toBeTruthy();
  });
});

describe("a card that cannot be read back is shown, not hidden", () => {
  it("offers a way to clear it", () => {
    renderCard({ readable: false, payload: null });
    expect(screen.getByRole("button", { name: "Clear it" })).toBeTruthy();
  });
});

describe("a NEVER card shows without offering to file", () => {
  it("has no file button", () => {
    renderCard({
      kind: "CREATE_MONEY_DOC",
      policyClass: "NEVER",
      policyReason:
        "Invoices and quotes are read and shown here, but Droplet does not file them into your books yet.",
      payload: { kind: "INVOICE", number: "1042", currency: "USD", total: "4250.00" },
    });
    expect(screen.queryByRole("button", { name: "Yes, file it" })).toBeNull();
  });

  it("renders money as the STRING it is", () => {
    // Never parsed to render. `Number()` rounds above 2^53 and the column is
    // NUMERIC(20,6) — a display that reformats it is a display that can lie.
    expect(
      headlineFor({
        ...base,
        kind: "CREATE_MONEY_DOC",
        payload: { kind: "INVOICE", number: "1042", currency: "USD", total: "12345678901234.99" },
      }),
    ).toBe("Invoice 1042 · USD 12345678901234.99");
  });
});

describe("MATCH_REVIEW cannot be filed until a customer is picked", () => {
  it("disables the file button with no choice made", () => {
    renderCard({
      kind: "MATCH_REVIEW",
      policyReason: "More than one customer could be the right one.",
      payload: {
        extractedName: "Northgate Dental",
        candidates: [
          { companyId: "22222222-2222-4222-8222-222222222222", name: "Northgate Dental" },
          { companyId: "33333333-3333-4333-8333-333333333333", name: "Northgate Dental Lab" },
        ],
      },
    });
    expect(
      (screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Northgate Dental Lab")).toBeTruthy();
  });
});
