/**
 * WARP-246 — /trust Trust Center placeholder page.
 *
 * Contract under test:
 *   1. renders the Trust Center heading + the placeholder structure:
 *      attestations (SOC 2, HIPAA), policies, SBOMs, penetration tests,
 *      incident response;
 *   2. roadmap honesty: not-yet items carry "Planned" / "In progress"
 *      badges and the page carries an explicit roadmap disclaimer —
 *      placeholders must read as roadmap, not attestation;
 *   3. artifact links (reports, SBOM downloads) are DISABLED
 *      placeholders until the artifacts exist;
 *   4. no admin gate — any authenticated household member can view
 *      (rendering never consults the user's role).
 *
 * ShellPage is mocked to a passthrough, same rationale as the audit
 * page test.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

import TrustPage from "@/app/trust/page";

describe("/trust Trust Center placeholder (WARP-246)", () => {
  it("renders the heading and every placeholder section", () => {
    render(<TrustPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /trust center/i }),
    ).toBeInTheDocument();
    for (const section of [
      /attestations/i,
      /policies/i,
      /software bill of materials/i,
      /penetration testing/i,
      /incident response/i,
    ]) {
      expect(screen.getByRole("heading", { name: section })).toBeInTheDocument();
    }
  });

  it("lists SOC 2 and HIPAA as roadmap items, not achievements", () => {
    render(<TrustPage />);
    expect(screen.getByText(/soc 2 type i\b/i)).toBeInTheDocument();
    expect(screen.getByText(/soc 2 type ii/i)).toBeInTheDocument();
    expect(screen.getByText(/hipaa/i)).toBeInTheDocument();
    // Roadmap statuses are present…
    expect(screen.getAllByText(/planned/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/in progress/i).length).toBeGreaterThanOrEqual(1);
    // …and the page says out loud that this is a roadmap.
    expect(screen.getByText(/roadmap/i)).toBeInTheDocument();
  });

  it("renders artifact links as disabled placeholders", () => {
    render(<TrustPage />);
    const disabled = screen
      .getAllByRole("button")
      .filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThanOrEqual(3);
  });

  it("does not consult the user's role (any authenticated member can view)", () => {
    // The page must render without an AuthProvider at all — if it
    // reached for useAuth() this render would throw.
    expect(() => render(<TrustPage />)).not.toThrow();
    expect(screen.queryByText(/admin access required/i)).toBeNull();
  });
});
