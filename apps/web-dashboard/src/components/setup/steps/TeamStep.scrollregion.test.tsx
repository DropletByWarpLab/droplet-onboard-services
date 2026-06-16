/**
 * WARP-820 — TeamStep's pending-invite list is the wizard's only unbounded
 * list on this step, so it must live inside a <ScrollRegion> (the single
 * permitted scroll surface). Title + CTA stay pinned in the StepShell; only the
 * invite list scrolls once it grows.
 *
 * Structure assertion (jsdom can't measure scroll): after an invite is added,
 * the invite row renders INSIDE the labelled "Pending invitations" region, and
 * that region carries the bounded-scroll classes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // Echo the input back as the "stored" invite so the row appends.
    postTeamInvite: vi.fn(async (input: { email: string; role: string }) => ({
      email: input.email.toLowerCase(),
      role: input.role,
    })),
  };
});

import { TeamStep } from "./TeamStep";

describe("TeamStep pending-invite list in ScrollRegion (WARP-820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps the pending invites in a bounded, labelled scroll region", async () => {
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    // Add an invite.
    const email = screen.getByPlaceholderText(/name@/i);
    fireEvent.change(email, { target: { value: "pat@acme.co" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // The invite lands inside the ScrollRegion (role=region, labelled).
    const region = await screen.findByRole("region", {
      name: /pending invit/i,
    });
    expect(within(region).getByText("pat@acme.co")).toBeInTheDocument();

    // …and the region is the bounded-scroll surface.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });

  it("renders no scroll region until there is at least one invite", () => {
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);
    expect(
      screen.queryByRole("region", { name: /pending invit/i }),
    ).not.toBeInTheDocument();
  });
});
