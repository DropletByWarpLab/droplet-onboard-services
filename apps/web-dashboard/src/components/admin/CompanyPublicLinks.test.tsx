/**
 * WARP-3168 — the owner/admin review list of member-made links on company files.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchCompanyPublicLinks = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchCompanyPublicLinks: (...args: unknown[]) => fetchCompanyPublicLinks(...args),
}));

import { CompanyPublicLinks, linkKindLabel, roleLabel } from "./CompanyPublicLinks";

describe("CompanyPublicLinks (WARP-3168)", () => {
  beforeEach(() => {
    fetchCompanyPublicLinks.mockReset();
  });

  it("lists each link with its place, person and kind", async () => {
    fetchCompanyPublicLinks.mockResolvedValue([
      {
        shareId: 1,
        shareType: 3,
        permissions: 1,
        library: "Household",
        path: "/Contracts/nda.pdf",
        createdBy: { userId: "u", name: "Mia Member", role: "family" },
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: null,
      },
    ]);
    render(<CompanyPublicLinks />);
    expect(await screen.findByText("Household/Contracts/nda.pdf")).toBeTruthy();
    expect(screen.getByText("Mia Member · Member")).toBeTruthy();
    expect(screen.getByText("Public link")).toBeTruthy();
    expect(screen.getByText("no expiry")).toBeTruthy();
  });

  it("a failed read says the list is unavailable, never 'none'", async () => {
    fetchCompanyPublicLinks.mockRejectedValue(new Error("Couldn't read the company's links (503)"));
    render(<CompanyPublicLinks />);
    expect((await screen.findByRole("alert")).textContent).toContain("does not mean there are none");
    expect(screen.queryByText("No member-made links to company files")).toBeNull();
  });

  it("labels", () => {
    expect(linkKindLabel({ shareType: 4, permissions: 1 })).toBe("Email link");
    expect(linkKindLabel({ shareType: 0, permissions: 17 })).toBe("Can re-share");
    expect(roleLabel("guest")).toBe("External guest");
    expect(roleLabel(null)).toBe("Not a Droplet account");
  });
});
