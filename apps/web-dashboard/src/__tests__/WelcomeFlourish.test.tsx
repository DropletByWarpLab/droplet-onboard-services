import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

// We must hoist-mock framer-motion's `useReducedMotion` hook BEFORE the
// component imports it. The hook is the cleanest seam (per the research doc
// §5.2) for forcing the reduced-motion branch deterministically — much less
// flaky than relying on `transition.duration: 0` in CI.
const useReducedMotionMock = vi.fn(() => false);
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>(
    "framer-motion"
  );
  return {
    ...actual,
    useReducedMotion: () => useReducedMotionMock(),
  };
});

import { WelcomeFlourish } from "@/components/auth/WelcomeFlourish";

describe("WelcomeFlourish", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useReducedMotionMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders without crashing", () => {
    render(<WelcomeFlourish />);
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });

  it("renders 'Welcome, {displayName}' when displayName is provided", () => {
    render(<WelcomeFlourish displayName="Robin" />);
    expect(screen.getByText(/Welcome, Robin/i)).toBeInTheDocument();
  });

  it("renders fallback headline when displayName is absent", () => {
    render(<WelcomeFlourish />);
    expect(screen.getByText(/Welcome to Droplet/i)).toBeInTheDocument();
  });

  it("renders the provided subtitle", () => {
    render(<WelcomeFlourish subtitle="3 devices connected and ready to control." />);
    expect(
      screen.getByText(/3 devices connected and ready to control\./i)
    ).toBeInTheDocument();
  });

  it("renders default subtitle when none provided", () => {
    render(<WelcomeFlourish />);
    expect(screen.getByText(/Your Droplet is ready\./i)).toBeInTheDocument();
  });

  it("calls onComplete after redirectAfterMs elapses", async () => {
    const onComplete = vi.fn();
    render(
      <WelcomeFlourish redirectAfterMs={2500} onComplete={onComplete} />
    );

    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2499);
      await Promise.resolve();
    });
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2);
      await Promise.resolve();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Skip button calls onComplete immediately", () => {
    const onComplete = vi.fn();
    render(<WelcomeFlourish onComplete={onComplete} />);

    const skipButton = screen.getByRole("button", { name: /skip/i });
    fireEvent.click(skipButton);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Skip button is rendered (always visible per AC)", () => {
    render(<WelcomeFlourish />);
    expect(screen.getByRole("button", { name: /skip/i })).toBeInTheDocument();
  });

  it("only fires onComplete once even if both timer and skip happen", async () => {
    const onComplete = vi.fn();
    render(
      <WelcomeFlourish redirectAfterMs={2500} onComplete={onComplete} />
    );

    fireEvent.click(screen.getByRole("button", { name: /skip/i }));

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  describe("with reduced-motion preference", () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it("renders the final state immediately (welcome heading visible synchronously)", () => {
      render(<WelcomeFlourish displayName="Sam" />);
      expect(screen.getByText(/Welcome, Sam/i)).toBeInTheDocument();
    });

    it("fires onComplete after 1500ms instead of redirectAfterMs", async () => {
      const onComplete = vi.fn();
      render(
        <WelcomeFlourish
          redirectAfterMs={2500}
          onComplete={onComplete}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(1499);
        await Promise.resolve();
      });
      expect(onComplete).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(2);
        await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });
});
