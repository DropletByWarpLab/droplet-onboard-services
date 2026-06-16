/**
 * WARP-837 — EmailList (column 1).
 *
 * Renders the account header ("N accounts · last sync …"), the three filter
 * chips (Inbox / Triaged / From Droplet — NOT the backend's 4th `archived`),
 * and one row per thread (sender, time, subject, preview, unread dot, drafted-
 * by-Droplet badge). Empty / loading states render their own calm copy.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { EmailList } from "./EmailList";
import type { EmailAccount, ThreadSummary } from "@/lib/types-email";

const account: EmailAccount = {
  id: "acc-1",
  userId: "u1",
  displayName: "Home inbox",
  address: "me@home.net",
  imapStatus: "idle",
  lastIdleAt: new Date().toISOString(),
  lastErrorAt: null,
  lastError: null,
};

const threads: ThreadSummary[] = [
  {
    id: "t1",
    accountId: "acc-1",
    threadKey: "k1",
    subject: "PO 4912 revised ETA",
    lastSender: "Naomi Rivera",
    snippet: "We are running behind on three pickups this week",
    messageCount: 4,
    triageStatus: "inbox",
    draftedByDroplet: true,
    lastMessageAt: new Date().toISOString(),
  },
  {
    id: "t2",
    accountId: "acc-1",
    threadKey: "k2",
    subject: "Invoice attached",
    lastSender: "accounting@hartwell.co",
    snippet: "Find attached your invoice for delivery",
    messageCount: 1,
    triageStatus: "inbox",
    draftedByDroplet: false,
    lastMessageAt: new Date().toISOString(),
  },
];

function baseProps() {
  return {
    accounts: [account],
    threads,
    filter: "inbox" as const,
    onFilterChange: vi.fn(),
    activeThreadId: null as string | null,
    onSelectThread: vi.fn(),
    isLoading: false,
    error: undefined as Error | undefined,
    lastSyncLabel: "32s ago",
  };
}

describe("EmailList", () => {
  it("renders the account summary header", () => {
    render(<EmailList {...baseProps()} />);
    // "1 account · last sync 32s ago" — singular, sentence case.
    expect(screen.getByText(/1 account/i)).toBeInTheDocument();
    expect(screen.getByText(/last sync 32s ago/i)).toBeInTheDocument();
  });

  it("renders exactly the three v1 filter chips and not 'archived'", () => {
    render(<EmailList {...baseProps()} />);
    const group = screen.getByRole("group", { name: /filter/i });
    expect(within(group).getByRole("button", { name: /inbox/i })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: /triaged/i })).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: /from droplet/i }),
    ).toBeInTheDocument();
    expect(
      within(group).queryByRole("button", { name: /archiv/i }),
    ).not.toBeInTheDocument();
  });

  it("marks the active filter chip with aria-pressed", () => {
    render(<EmailList {...baseProps()} filter="triaged" />);
    expect(
      screen.getByRole("button", { name: /triaged/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /inbox/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onFilterChange with the slug when a chip is clicked", () => {
    const props = baseProps();
    render(<EmailList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /from droplet/i }));
    expect(props.onFilterChange).toHaveBeenCalledWith("droplet");
  });

  it("renders a row per thread with sender, subject and preview", () => {
    render(<EmailList {...baseProps()} />);
    expect(screen.getByText("Naomi Rivera")).toBeInTheDocument();
    expect(screen.getByText("PO 4912 revised ETA")).toBeInTheDocument();
    expect(
      screen.getByText(/running behind on three pickups/i),
    ).toBeInTheDocument();
  });

  it("shows a 'drafted by Droplet' badge only on the AI-drafted thread", () => {
    render(<EmailList {...baseProps()} />);
    const badges = screen.getAllByText(/drafted by droplet/i);
    expect(badges).toHaveLength(1);
  });

  it("fires onSelectThread with the thread id when a row is clicked", () => {
    const props = baseProps();
    render(<EmailList {...props} />);
    fireEvent.click(screen.getByText("PO 4912 revised ETA"));
    expect(props.onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("renders a calm empty state when there are no threads in the filter", () => {
    render(<EmailList {...baseProps()} threads={[]} />);
    expect(screen.getByText(/no .*(messages|threads|email)/i)).toBeInTheDocument();
    // No exclamation marks in empty states.
    expect(document.body.textContent).not.toMatch(/!/);
  });

  it("renders a loading skeleton when isLoading", () => {
    render(<EmailList {...baseProps()} threads={[]} isLoading />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });

  it("filters the loaded rows by subject or sender as you type (case-insensitive)", () => {
    render(<EmailList {...baseProps()} />);
    const search = screen.getByRole("searchbox");

    // Match on subject — only the PO thread survives.
    fireEvent.change(search, { target: { value: "po 4912" } });
    expect(screen.getByText("PO 4912 revised ETA")).toBeInTheDocument();
    expect(screen.queryByText("Invoice attached")).not.toBeInTheDocument();

    // Match on sender — only the Hartwell thread survives.
    fireEvent.change(search, { target: { value: "HARTWELL" } });
    expect(screen.getByText("Invoice attached")).toBeInTheDocument();
    expect(screen.queryByText("PO 4912 revised ETA")).not.toBeInTheDocument();

    // Clearing the box restores every loaded row.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("PO 4912 revised ETA")).toBeInTheDocument();
    expect(screen.getByText("Invoice attached")).toBeInTheDocument();
  });

  it("shows a calm no-matches state when a search matches nothing, without an exclamation mark", () => {
    render(<EmailList {...baseProps()} />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz no such thread" },
    });
    expect(screen.queryByText("PO 4912 revised ETA")).not.toBeInTheDocument();
    expect(screen.getByText("No matches")).toBeInTheDocument();
    // No exclamation marks in the no-matches copy.
    expect(document.body.textContent).not.toMatch(/!/);
  });

  it("renders an error state with a retry affordance", () => {
    const props = baseProps();
    const onRetry = vi.fn();
    render(
      <EmailList
        {...props}
        threads={[]}
        error={new Error("nope")}
        onRetry={onRetry}
      />,
    );
    const retry = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalled();
  });
});
