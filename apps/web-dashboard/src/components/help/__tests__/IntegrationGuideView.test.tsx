/**
 * WARP-2490 — what the guide page actually renders.
 *
 * The drift gate in `lib/integration-guides.test.ts` proves the right pages
 * exist. This proves the page is READABLE once you land on it: the two things
 * a raw `react-markdown` render gets wrong for this corpus are cross-guide
 * links (which a browser resolves against the route, not the docs folder) and
 * headings with no ids (so every `#anchor` link lands at the top of the page).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// ShellPage does its own SWR health read and device-address lookup, both
// covered by their own tests. Passthrough keeps this file about the guide.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <div className="droplet-shell">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import { IntegrationGuideView } from "../IntegrationGuideView";
import { integrationGuide, integrationGuideTitle } from "@/lib/integration-guides";

function renderGuide(markdown: string) {
  return render(
    <IntegrationGuideView slug="fixture" title="Fixture guide" markdown={markdown} />,
  );
}

describe("cross-guide links", () => {
  /**
   * Mutation: render `<a href={href}>` unchanged → red. The browser would
   * resolve `credential-handling.md` to
   * `/help/integrations/credential-handling.md` — a 404 on the one link the
   * corpus uses 14 times.
   */
  it("rewrites a sibling link to its route", () => {
    renderGuide("See [handling](credential-handling.md) for the rules.");
    const link = screen.getByRole("link", { name: "handling" });
    expect(link.getAttribute("href")).toBe("/help/integrations/credential-handling");
  });

  /**
   * Mutation: render an anchor for every href → red. On a box with no internet
   * path, a link that 404s is worse than prose: the reader cannot tell whether
   * the document is missing or the appliance is broken.
   */
  it("renders a target it cannot serve as plain text, not a dead link", () => {
    renderGuide("Background: [ADR-041](../ADR-041-cloud-connector-class.md).");
    expect(screen.queryByRole("link", { name: "ADR-041" })).toBeNull();
    // The prose still reads — the words are kept, only the anchor is dropped.
    expect(screen.getByText("ADR-041")).toBeTruthy();
  });

  it("keeps an in-page anchor as an anchor", () => {
    renderGuide("Jump to [the plan](#plan-prerequisite).");
    expect(screen.getByRole("link", { name: "the plan" }).getAttribute("href")).toBe(
      "#plan-prerequisite",
    );
  });
});

describe("headings carry the ids the links target", () => {
  /**
   * Mutation: drop the `id` from the heading components → red, and every
   * `SETUP.md#…` link in the five vendor guides lands at the top of a
   * 20,000-word page instead of at its section.
   */
  it("gives every heading a GitHub-compatible id", () => {
    const { container } = renderGuide(
      "## 3. Track B — a cloud service\n\ntext\n\n### Plan prerequisite\n",
    );
    expect(container.querySelector("#\\33 -track-b--a-cloud-service")).toBeTruthy();
    expect(container.querySelector("#plan-prerequisite")).toBeTruthy();
  });
});

describe("a real shipped guide", () => {
  /**
   * Not a synthetic fixture: the actual Stripe guide, rendered. GFM tables and
   * fenced code are what these documents are made of, and a renderer that
   * drops them is one nobody would notice until a customer read it.
   *
   * Mutation: remove `remarkGfm` → red on the table.
   */
  it("renders the Stripe guide with its GFM tables intact", () => {
    const markdown = integrationGuide("stripe") ?? "";
    expect(markdown).toContain("|");
    render(
      <IntegrationGuideView
        slug="stripe"
        title={integrationGuideTitle("stripe")}
        markdown={markdown}
      />,
    );

    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect(screen.getByTestId("integration-guide").dataset.slug).toBe("stripe");
    // Every link the guide draws points somewhere this dashboard serves.
    for (const a of screen.getAllByRole("link")) {
      expect(a.getAttribute("href"), a.textContent ?? "").toMatch(
        /^(\/help\/integrations\/|#)/,
      );
    }
  });
});
