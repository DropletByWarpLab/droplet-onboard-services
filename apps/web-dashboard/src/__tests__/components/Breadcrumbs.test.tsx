import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import type { ChainStep } from "@/lib/api";

describe("Breadcrumbs", () => {
  it("returns null at depth 0 (no chain)", () => {
    const { container } = render(<Breadcrumbs chain={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when chain is undefined", () => {
    const { container } = render(<Breadcrumbs chain={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 2 segments + 1 chevron at depth 1 (email → pdf)", () => {
    const chain: ChainStep[] = [
      { filename: "march.eml", mime: "message/rfc822" },
      { filename: "proposal.pdf", mime: "application/pdf" },
    ];
    render(<Breadcrumbs chain={chain} />);
    expect(screen.getByText("march.eml")).toBeInTheDocument();
    expect(screen.getByText("proposal.pdf")).toBeInTheDocument();
    expect(screen.getAllByTestId("breadcrumb-chevron")).toHaveLength(1);
  });

  it("renders 3 segments + 2 chevrons at depth 2 (zip → email → pdf)", () => {
    const chain: ChainStep[] = [
      { filename: "q1-stuff.zip", mime: "application/zip" },
      { filename: "march.eml", mime: "message/rfc822" },
      { filename: "proposal.pdf", mime: "application/pdf" },
    ];
    render(<Breadcrumbs chain={chain} />);
    expect(screen.getByText("q1-stuff.zip")).toBeInTheDocument();
    expect(screen.getByText("march.eml")).toBeInTheDocument();
    expect(screen.getByText("proposal.pdf")).toBeInTheDocument();
    expect(screen.getAllByTestId("breadcrumb-chevron")).toHaveLength(2);
  });

  it("returns null and warns once when chain is malformed (non-array)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<Breadcrumbs chain={"oops" as unknown as ChainStep[]} />);
    expect(container.firstChild).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
