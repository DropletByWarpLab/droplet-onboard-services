/**
 * WARP-576 — App Router error + not-found boundaries.
 *
 * Validates that a render throw surfaces a branded recovery UI instead of a
 * blank screen, that the retry control re-attempts the render, and that the
 * 404 page links home.
 *
 * NOTE: We render the boundary components directly (the same way Next.js
 * invokes them) rather than relying on Next's runtime to catch a throw —
 * Vitest/JSDOM has no App Router runtime. The contract under test is that
 * each boundary file renders the expected recovery surface when handed the
 * props Next passes it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// The global setup mocks `next/link` to a broken string render; override it
// here with a real <a> so the not-found home link is queryable by role.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...props }, children),
}));

import ErrorBoundary from "@/app/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

describe("error.tsx boundary (WARP-576)", () => {
  let consoleErr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {}) as ReturnType<
      typeof vi.spyOn
    >;
  });
  afterEach(() => {
    consoleErr.mockRestore();
    vi.clearAllMocks();
  });

  it("renders a recovery surface (not a blank) when an error is passed", () => {
    render(<ErrorBoundary error={new Error("boom")} reset={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
  });

  it("never surfaces the raw error message or digest to the DOM (logs, not shows)", () => {
    const err = Object.assign(new Error("boom-secret-stacktrace"), {
      digest: "digest-abc123",
    });
    render(<ErrorBoundary error={err} reset={() => {}} />);
    // Security invariant: server error detail must not reach the browser.
    expect(screen.queryByText(/boom-secret-stacktrace/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/digest-abc123/i)).not.toBeInTheDocument();
    // …but it IS logged so it stays debuggable from the console / reporting.
    expect(consoleErr).toHaveBeenCalledWith(err);
  });

  it("logs the error via console.error", () => {
    const err = new Error("kaboom");
    render(<ErrorBoundary error={err} reset={() => {}} />);
    expect(consoleErr).toHaveBeenCalledWith(err);
  });

  it("invokes reset() when the Try again control is clicked", () => {
    const reset = vi.fn();
    render(<ErrorBoundary error={new Error("boom")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("global-error.tsx boundary (WARP-576)", () => {
  let consoleErr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {}) as ReturnType<
      typeof vi.spyOn
    >;
  });
  afterEach(() => {
    consoleErr.mockRestore();
    vi.clearAllMocks();
  });

  it("renders a recovery surface with a working retry control", () => {
    const reset = vi.fn();
    render(<GlobalError error={new Error("layout boom")} reset={reset} />);
    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never surfaces the raw error message or digest to the DOM (logs, not shows)", () => {
    const err = Object.assign(new Error("layout-boom-secret"), {
      digest: "layout-digest-xyz789",
    });
    render(<GlobalError error={err} reset={() => {}} />);
    // Security invariant: server error detail must not reach the browser.
    expect(screen.queryByText(/layout-boom-secret/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/layout-digest-xyz789/i)).not.toBeInTheDocument();
    // …but it IS logged so it stays debuggable from the console / reporting.
    expect(consoleErr).toHaveBeenCalledWith(err);
  });

  it("logs the error via console.error", () => {
    const err = new Error("layout kaboom");
    render(<GlobalError error={err} reset={() => {}} />);
    expect(consoleErr).toHaveBeenCalledWith(err);
  });
});

describe("not-found.tsx (WARP-576)", () => {
  it("renders a 404 surface with a link back to the home dashboard", () => {
    render(<NotFound />);
    const link = screen.getByRole("link", { name: /back to dashboard/i });
    expect(link).toHaveAttribute("href", "/");
  });
});
