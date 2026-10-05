/**
 * WARP-3528 — the ticket list: what a row says, the SLA slot, a requester whose
 * contact is gone, and "Showing N of M" with Load more.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";
import { PeopleContext } from "@/components/projects/bits";
import { makePerson } from "@/components/projects/config";
import { SlaBadge, TicketList, TicketListSkeleton } from "./TicketList";
import { STATES, makeSummary } from "./support.test-fixtures";

const list = (over: Partial<React.ComponentProps<typeof TicketList>> = {}) => {
  const props = {
    tickets: [makeSummary()],
    total: 1,
    hasMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    showDesk: false,
    ...over,
  };
  render(
    <PeopleContext.Provider value={(id) => makePerson(id, "Ada Lovelace")}>
      <TicketList {...props} />
    </PeopleContext.Provider>,
  );
  return props;
};

describe("TicketList rows", () => {
  it("shows who asked, the subject, the key, the status and the priority", () => {
    list({ tickets: [makeSummary({ priority: "urgent", status: STATES[1]! })] });
    const row = screen.getByRole("button", { name: "SUP-1, Printer jams on page two, from Dana Reyes" });
    expect(within(row).getByText("Dana Reyes")).toBeInTheDocument();
    expect(within(row).getByText("Printer jams on page two")).toBeInTheDocument();
    expect(within(row).getByText("SUP-1")).toHaveClass("pm-mono");
    expect(within(row).getByText("Open")).toBeInTheDocument();
    expect(within(row).getByTitle("Urgent")).toBeInTheDocument();
  });

  it("names the desk only when more than one desk is in play", () => {
    list({ showDesk: true });
    expect(screen.getByText("Support")).toBeInTheDocument();
  });

  it("shows assignees by their server-resolved names, and an empty ghost when unassigned", () => {
    list({
      tickets: [
        makeSummary({ id: "a", key: "SUP-1", assignees: [{ id: "u-1", displayName: "Ada Lovelace" }] }),
        makeSummary({ id: "b", key: "SUP-2" }),
      ],
      total: 2,
    });
    expect(screen.getByLabelText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByLabelText("Unassigned")).toBeInTheDocument();
  });

  it("keeps the snapshot name of a customer who is no longer in contacts, and says so", () => {
    list({
      tickets: [makeSummary({ requester: { kind: "CONTACT", id: "c-9", name: "Dana Reyes", email: null, gone: true } })],
    });
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.getByText(/no longer in contacts/i)).toBeInTheDocument();
  });

  it("marks the selected ticket and reports a click with the ticket", () => {
    const t = makeSummary({ id: "t-7" });
    const { onSelect } = list({ tickets: [t], selectedId: "t-7" });
    const row = screen.getByRole("button", { name: /SUP-1/ });
    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(t);
  });
});

describe("TicketList paging", () => {
  it("says how many of how many are shown, with Load more while there are more", () => {
    const { onLoadMore } = list({ tickets: [makeSummary()], total: 120, hasMore: true });
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1 of 120");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("drops Load more at the end and disables it while a page is in flight", () => {
    const { rerender } = render(
      <TicketList tickets={[makeSummary()]} total={1} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} selectedId={null} onSelect={vi.fn()} showDesk={false} />,
    );
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    rerender(
      <TicketList tickets={[makeSummary()]} total={9} hasMore loadingMore onLoadMore={vi.fn()} selectedId={null} onSelect={vi.fn()} showDesk={false} />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });
});

describe("SlaBadge", () => {
  it("renders nothing until a policy applies", () => {
    const { container } = render(<SlaBadge status="NONE" />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["ON_TRACK", "On track", "ok"],
    ["MET", "Met", "ok"],
    ["AT_RISK", "At risk", "warn"],
    ["BREACHED", "Breached", "err"],
    ["PAUSED", "Paused", "muted"],
  ] as const)("says %s in words (%s) so colour never carries it alone", (status, label, tone) => {
    render(<SlaBadge status={status} />);
    expect(screen.getByText(label)).toHaveClass("sp-sla", tone);
  });
});

describe("TicketListSkeleton", () => {
  it("is a busy region of placeholders, not a spinner", () => {
    render(<TicketListSkeleton />);
    expect(screen.getByLabelText("Loading tickets")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelectorAll(".pm-skel").length).toBeGreaterThan(6);
  });
});
