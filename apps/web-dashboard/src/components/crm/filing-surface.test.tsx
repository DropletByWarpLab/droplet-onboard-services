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

const summaryMock = vi.fn();
vi.mock("./useFiling", async () => {
  const actual = await vi.importActual<typeof import("./useFiling")>("./useFiling");
  return { ...actual, useFilingSummary: () => summaryMock() };
});

import { FilingBanner, FilingCard, headlineFor } from "./FilingSurface";
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
  autoApplied: false,
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

/**
 * 🔴 WARP-2737 — the money card that could never be filed.
 *
 * The first invoice from a business that is not in the customer list yet is the
 * ordinary way a money document arrives, and it produced a card with an ENABLED
 * "Yes, file it" that returned 422 on every click, forever. The picker and the
 * `disabled` gate below it were both scoped to `MATCH_REVIEW`, so a money card
 * had neither: no way to say which customer, and nothing stopping the owner
 * from asking for the impossible. The only way to clear the card was to reject
 * a perfectly good reading of a real invoice.
 *
 * A picker would not have fixed it, because there is nothing to pick — the
 * customer does not exist. So the card waits on the `CREATE_CUSTOMER` card
 * beside it, and says so.
 */
describe("🔴 a money card waits for the customer it has not got", () => {
  const MONEY = {
    kind: "CREATE_MONEY_DOC" as const,
    policyReason:
      "Droplet read an invoice here. Money is never filed automatically — check the figures and file it yourself.",
    payload: {
      kind: "INVOICE",
      number: "1042",
      currency: "USD",
      total: "4250.00",
      counterpartyName: "ACME Dental Supply Ltd",
    },
  };

  it("🔴 REGRESSION: does not offer to file an invoice with no customer", () => {
    renderCard(MONEY);
    expect(
      (screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says what the person has to do, and names who", () => {
    // Not "choose a customer" — there is none to choose. The sentence points at
    // the other card in the same queue, which is the thing that unblocks this.
    renderCard(MONEY);
    expect(screen.getByText(/Add ACME Dental Supply Ltd as a customer first/i)).toBeTruthy();
  });

  it("can still be cleared — a card nobody can act on is a queue nobody finishes", () => {
    renderCard(MONEY);
    expect(
      (screen.getByRole("button", { name: "No thanks" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says something honest when it could not tell who sent it either", () => {
    const { counterpartyName: _drop, ...anonymous } = MONEY.payload;
    renderCard({ ...MONEY, payload: anonymous });
    const text = screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement;
    expect(text.disabled).toBe(true);
    expect(screen.getByText(/could not tell which customer/i)).toBeTruthy();
  });

  it("🔴 MUTATION: files it once the customer card above has been applied", () => {
    // The other half, and the reason this is a gate rather than a blanket
    // refusal for money. A gate that never opens is the same dead end with a
    // politer sentence on it.
    renderCard({
      ...MONEY,
      resolvedCustomer: {
        companyId: "22222222-2222-4222-8222-222222222222",
        companyName: "ACME Dental Supply Ltd",
      },
    });
    expect(
      (screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // And it names the customer it is about to file under. A money payload
    // carries no company NAME, so without this the owner would be approving a
    // filing whose subject appears nowhere on the card.
    expect(screen.getByText("Files under")).toBeTruthy();
    expect(screen.getAllByText("ACME Dental Supply Ltd").length).toBeGreaterThan(0);
  });

  it("MUTATION: a money card that already names its customer is untouched", () => {
    // The repeat-customer path, which always worked and must keep working — a
    // fix that gated every money card would have broken it.
    renderCard({
      ...MONEY,
      payload: { ...MONEY.payload, companyId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(
      (screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("MUTATION: the gate is money's alone — a customer card is not held back", () => {
    // `CREATE_CUSTOMER` has no companyId either, by definition. Reading "no
    // companyId" as "not ready" would freeze the one card that unblocks the
    // money one, and the queue would deadlock.
    renderCard();
    expect(
      (screen.getByRole("button", { name: "Yes, file it" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

/**
 * 🔴 The entry point, which did not exist.
 *
 * `/customers/filing` has no nav entry — `CrmTabs` argues that case and is
 * right: a link to a different section is a nav entry, not a tab. But this
 * banner was the ONLY link to that route anywhere in the dashboard, and it
 * rendered `null` unless filing was already on. The switch that turns filing
 * on lives inside the route, and a fresh box defaults to off. The circle was
 * closed: the whole of ADR-048 was dark on a shipped box unless the owner
 * guessed the URL.
 */
describe("FilingBanner — the way in", () => {
  const SUMMARY = {
    mode: "off" as const,
    level: "links_only" as const,
    vertical: "general" as const,
    enabled: false,
    pending: 0,
  };

  function show(over: Record<string, unknown> = {}) {
    summaryMock.mockReturnValue({ summary: { ...SUMMARY, ...over }, error: null, mutate: vi.fn() });
    render(<FilingBanner />);
  }

  it("🔴 MUTATION: render nothing while filing is off — the feature becomes unreachable", () => {
    show();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/customers/filing");
  });

  it("the off state is an OFFER, and never a count", () => {
    // The pending banner is an alarm; this one says what Droplet could do. A
    // number here would be a demand for attention on a box where nothing has
    // happened yet, and there is nothing waiting to attend to.
    show();
    const text = screen.getByRole("link").textContent ?? "";
    expect(text).toMatch(/Droplet can read new files/i);
    expect(text).not.toMatch(/\d/);
    // ADR-002 voice: the machine's vocabulary never reaches the page.
    expect(text).not.toMatch(/proposal|extraction|entity|confidence/i);
  });

  it("goes away the moment filing is on with nothing waiting", () => {
    // The answer to "a banner that is always there stops being read": the
    // offer disappears as soon as it has been used.
    show({ enabled: true, mode: "propose", pending: 0 });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("switches to the pending alarm once there is something to look at", () => {
    show({ enabled: true, mode: "propose", pending: 3 });
    const text = screen.getByRole("link").textContent ?? "";
    expect(text).toMatch(/read 3 things/i);
    expect(text).not.toMatch(/Droplet can read new files/i);
  });

  it("renders nothing at all when the summary never arrived", () => {
    // A `family` member's 403 is the ordinary answer here, not a fault, and an
    // undefined summary must not be read as "filing is off".
    summaryMock.mockReturnValue({ summary: undefined, error: null, mutate: vi.fn() });
    render(<FilingBanner />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
