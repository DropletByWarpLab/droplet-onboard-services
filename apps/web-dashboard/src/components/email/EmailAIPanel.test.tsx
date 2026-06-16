/**
 * WARP-837 — EmailAIPanel (column 3).
 *
 * "Droplet · about this thread": a 2-sentence summary, bullet callouts, an
 * ordered list of suggested actions EACH carrying its Read / Write · confirm
 * safety chip, and a Related list (files / threads / cameras / tools).
 *
 * The safety chip on every action is the non-negotiable §6 contract — the test
 * asserts a visible chip per action, not just somewhere on the panel.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { EmailAIPanel } from "./EmailAIPanel";
import type { ThreadAnalysis } from "@/lib/types-email";

const analysis: ThreadAnalysis = {
  summary:
    "Naomi is apologising for a delay on PO 4912. She offers a revised ETA and acknowledges the recurring Monday pattern.",
  callouts: [
    { label: "3rd Monday delay in a row" },
    { label: "Dock-3 clear until 15:00" },
  ],
  suggestedActions: [
    { label: "Send the draft I wrote", safety: "Write · confirm" },
    { label: "File under Northwind / 2025-Q2", safety: "Read" },
  ],
  related: {
    files: ["Northwind PO 4912.pdf"],
    threads: ["Coastal Carriers thread"],
    cameras: ["Dock-3 06:00-09:00"],
    tools: ["Carrier recap"],
  },
};

function baseProps() {
  return {
    analysis,
    isLoading: false,
    error: undefined as Error | undefined,
  };
}

describe("EmailAIPanel", () => {
  it("renders the panel title", () => {
    render(<EmailAIPanel {...baseProps()} />);
    expect(screen.getByText(/about this thread/i)).toBeInTheDocument();
  });

  it("renders the summary text", () => {
    render(<EmailAIPanel {...baseProps()} />);
    expect(screen.getByText(/apologising for a delay on PO 4912/i)).toBeInTheDocument();
  });

  it("renders each callout as a bullet", () => {
    render(<EmailAIPanel {...baseProps()} />);
    expect(screen.getByText(/3rd Monday delay in a row/i)).toBeInTheDocument();
    expect(screen.getByText(/Dock-3 clear until 15:00/i)).toBeInTheDocument();
  });

  it("renders each suggested action WITH a visible safety chip", () => {
    render(<EmailAIPanel {...baseProps()} />);
    const list = screen.getByRole("list", { name: /suggested actions/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // First action: a Write · confirm chip co-located in its item.
    expect(within(items[0]).getByText(/Send the draft I wrote/i)).toBeInTheDocument();
    expect(within(items[0]).getByText(/Write · confirm/i)).toBeInTheDocument();
    // Second action: a Read chip co-located in its item.
    expect(within(items[1]).getByText(/File under Northwind/i)).toBeInTheDocument();
    expect(within(items[1]).getByText(/^Read/i)).toBeInTheDocument();
  });

  it("renders the Related references", () => {
    render(<EmailAIPanel {...baseProps()} />);
    expect(screen.getByText(/Northwind PO 4912.pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/Coastal Carriers thread/i)).toBeInTheDocument();
    expect(screen.getByText(/Dock-3 06:00-09:00/i)).toBeInTheDocument();
    expect(screen.getByText(/Carrier recap/i)).toBeInTheDocument();
  });

  it("renders a loading state while analysis is pending", () => {
    render(<EmailAIPanel analysis={undefined} isLoading error={undefined} />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });

  it("renders a calm error state with retry when analysis fails", () => {
    let retried = false;
    render(
      <EmailAIPanel
        analysis={undefined}
        isLoading={false}
        error={new Error("503")}
        onRetry={() => {
          retried = true;
        }}
      />,
    );
    expect(screen.getByText(/couldn.t|could not|not available/i)).toBeInTheDocument();
    screen.getByRole("button", { name: /try again/i }).click();
    expect(retried).toBe(true);
  });

  it("renders a neutral empty state when no thread is selected", () => {
    render(<EmailAIPanel analysis={undefined} isLoading={false} error={undefined} />);
    // No thread + not loading + no error → a quiet placeholder, no crash.
    expect(screen.getByText(/select a (message|conversation|thread)|nothing to summarise|no thread/i)).toBeInTheDocument();
  });
});
