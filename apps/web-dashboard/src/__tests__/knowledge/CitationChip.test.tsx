import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Re-mock next/link as an actual <a> element. The setup.ts global mock
// returns a string template, which doesn't compose with React children
// — it makes the chip render as raw text. CitationChip is the first
// dashboard component to actually exercise <Link>, so we override here.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

import { CitationChip } from "@/components/CitationChip";

describe("CitationChip", () => {
  it("renders the file name and a Nextcloud-tone link to the parent dir", () => {
    const { container } = render(
      <CitationChip
        source="nextcloud"
        path="/Documents/notes/meeting.pdf"
        score={0.812}
        pageNumber={3}
        snippet="Lorem ipsum dolor sit amet"
      />
    );
    const link = container.querySelector("a")!;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe(
      "/files?path=" + encodeURIComponent("/Documents/notes")
    );
    expect(link.dataset.citationSource).toBe("nextcloud");
    expect(link.textContent).toContain("meeting.pdf");
    // Score rendered as percentage
    expect(link.textContent).toContain("81%");
    // Page number prefixed with `p.`
    expect(link.textContent).toContain("p.3");
    // Snippet exposed via the title attribute (compact chip; full snippet on hover)
    expect(link.getAttribute("title")).toBe("Lorem ipsum dolor sit amet");
  });

  it("links brain hits to the /knowledge brain tab and surfaces the brainItemId", () => {
    const { container } = render(
      <CitationChip
        source="brain"
        path="/brain/abc/notes.md"
        brainItemId="abc-123"
      />
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(
      "/knowledge?tab=brain&item=abc-123"
    );
    expect(link.dataset.citationSource).toBe("brain");
  });

  it("falls back to the brain tab without an item id when brainItemId is absent", () => {
    const { container } = render(
      <CitationChip source="brain" path="/brain/x/y.md" />
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/knowledge?tab=brain");
  });

  it("respects an explicit href override", () => {
    const { container } = render(
      <CitationChip
        source="nextcloud"
        path="/foo/bar.txt"
        href="/custom/destination"
      />
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/custom/destination");
  });

  it("omits the score / page chunks when not provided", () => {
    const { container } = render(
      <CitationChip source="nextcloud" path="/a/b.txt" />
    );
    const link = container.querySelector("a")!;
    expect(link.textContent).not.toMatch(/p\./);
    expect(link.textContent).not.toMatch(/%/);
  });
});
