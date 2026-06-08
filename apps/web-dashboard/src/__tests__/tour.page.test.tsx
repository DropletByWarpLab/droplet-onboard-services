/**
 * Onboarding Tour — ProductTour walkthrough UX (PR #382).
 *
 * Validates the guided-walkthrough contract independent of the persistence
 * seam (covered in tour.complete-persist.test.tsx):
 *   1. renders the first step + a Skip affordance + a step indicator;
 *   2. Next advances; Back returns; the indicator tracks position;
 *   3. the current step is persisted so a refresh resumes mid-tour;
 *   4. the final step shows a finish action (not "Next").
 *
 * AuthProvider is stubbed to a no-op context here so the component renders in
 * isolation — completeTour is asserted in the persistence test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/tour",
}));

// Stub the auth context: ProductTour only needs completeTour() to resolve.
const completeTourMock = vi.fn(async () => {});
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeTour: completeTourMock }),
}));

import { ProductTour, TOUR_STEPS } from "@/components/tour/ProductTour";

const RESUME_KEY = "droplet-tour-step";

beforeEach(() => {
  pushMock.mockReset();
  completeTourMock.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ProductTour walkthrough (PR #382)", () => {
  it("renders the first step, a Skip control, and a step indicator", () => {
    render(<ProductTour />);
    expect(
      screen.getByRole("heading", { level: 1, name: new RegExp(TOUR_STEPS[0].title, "i") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip/i })).toBeInTheDocument();
    // Step indicator announces position. The redesign shows it twice — in the
    // kicker ("… · 1 of 5") and the footer counter ("1 / 5") — so assert at
    // least one match rather than a unique one.
    expect(
      screen.getAllByText(new RegExp(`1\\s*(of|/)\\s*${TOUR_STEPS.length}`, "i"))
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("advances on Next and returns on Back", () => {
    render(<ProductTour />);
    // First step: no Back (or disabled), has Next.
    fireEvent.click(screen.getByRole("button", { name: /next|continue/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: new RegExp(TOUR_STEPS[1].title, "i") }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: new RegExp(TOUR_STEPS[0].title, "i") }),
    ).toBeInTheDocument();
  });

  it("persists the current step so a refresh resumes mid-tour", () => {
    const { unmount } = render(<ProductTour />);
    fireEvent.click(screen.getByRole("button", { name: /next|continue/i }));
    // Persisted to localStorage (index 1).
    expect(localStorage.getItem(RESUME_KEY)).toBe("1");
    unmount();
    // Re-mount = refresh. The tour resumes at step 2, not step 1.
    render(<ProductTour />);
    expect(
      screen.getByRole("heading", { level: 1, name: new RegExp(TOUR_STEPS[1].title, "i") }),
    ).toBeInTheDocument();
  });

  it("shows a finish action on the final step instead of Next", () => {
    render(<ProductTour />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      fireEvent.click(screen.getByRole("button", { name: /next|continue/i }));
    }
    expect(
      screen.getByRole("button", { name: /go to (the )?dashboard|finish/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^next$|^continue$/i }),
    ).not.toBeInTheDocument();
  });
});
