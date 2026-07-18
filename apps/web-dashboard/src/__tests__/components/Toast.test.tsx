import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/Toast";

// Test harness — a button per variant so tests can trigger toasts on demand.
function Harness() {
  const { toast } = useToast();
  return (
    <div>
      <button onClick={() => toast("Boom", "error")}>fire-error</button>
      <button onClick={() => toast("Yay", "success")}>fire-success</button>
      <button onClick={() => toast("FYI", "info")}>fire-info</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

describe("Toast a11y (WARP-297)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders a polite live region with an accessible name", () => {
    renderWithProvider();
    const region = screen.getByRole("region", { name: /notifications/i });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "false");
  });

  it("error toast carries role='alert' for assertive announcement", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Boom");
  });

  it("success toast does NOT carry role='alert' (inherits polite region)", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-success"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Yay")).toBeInTheDocument();
  });

  it("error toasts persist past 5s (no auto-dismiss — WCAG 2.2.1)", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("success toasts auto-dismiss after 5s", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-success"));
    });
    expect(screen.getByText("Yay")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5_100);
    });
    expect(screen.queryByText("Yay")).toBeNull();
  });

  it("pause-on-hover keeps a success toast visible past its 5s timer", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-success"));
    });
    const toastEl = screen.getByText("Yay").closest("[data-toast]") as HTMLElement;
    expect(toastEl).not.toBeNull();
    act(() => {
      fireEvent.mouseEnter(toastEl);
      vi.advanceTimersByTime(5_500);
    });
    expect(screen.getByText("Yay")).toBeInTheDocument();
    act(() => {
      fireEvent.mouseLeave(toastEl);
      vi.advanceTimersByTime(5_100);
    });
    expect(screen.queryByText("Yay")).toBeNull();
  });

  it("pause-on-focus keeps a success toast visible past its 5s timer", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-success"));
    });
    const toastEl = screen.getByText("Yay").closest("[data-toast]") as HTMLElement;
    expect(toastEl).not.toBeNull();
    act(() => {
      fireEvent.focus(toastEl);
      vi.advanceTimersByTime(5_500);
    });
    expect(screen.getByText("Yay")).toBeInTheDocument();
    act(() => {
      fireEvent.blur(toastEl);
      vi.advanceTimersByTime(5_100);
    });
    expect(screen.queryByText("Yay")).toBeNull();
  });

  it("dismiss button has an aria-label", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-info"));
    });
    const btn = screen.getByRole("button", { name: /dismiss/i });
    expect(btn).toBeInTheDocument();
  });

  it("dismiss button removes the toast on click", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /dismiss/i });
    act(() => {
      fireEvent.click(btn);
    });
    expect(screen.queryByText("Boom")).toBeNull();
  });

  it("does NOT render 'Dismiss all' with fewer than 3 toasts", () => {
    // Distinct messages — identical repeats are deduped (WARP-1306).
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
      fireEvent.click(screen.getByText("fire-success"));
    });
    expect(
      screen.queryByRole("button", { name: /dismiss all/i }),
    ).toBeNull();
  });

  it("renders 'Dismiss all' when 3+ toasts are visible and clears them on click", () => {
    // Distinct messages — identical repeats are deduped (WARP-1306).
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
      fireEvent.click(screen.getByText("fire-success"));
      fireEvent.click(screen.getByText("fire-info"));
    });
    const dismissAll = screen.getByRole("button", { name: /dismiss all/i });
    expect(dismissAll).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("Yay")).toBeInTheDocument();
    expect(screen.getByText("FYI")).toBeInTheDocument();
    act(() => {
      fireEvent.click(dismissAll);
    });
    expect(screen.queryAllByText("Boom")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /dismiss all/i }),
    ).toBeNull();
  });
});

describe("Toast dedup (WARP-1306)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not stack an identical (message, type) toast twice", () => {
    // The Projects New-project dialog surfaced the same 'module disabled'
    // error toast twice (error toasts persist until dismissed, so a second
    // identical failure stacked a twin). Identical repeats now no-op.
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
      fireEvent.click(screen.getByText("fire-error"));
    });
    expect(screen.getAllByText("Boom")).toHaveLength(1);
  });

  it("still stacks different messages", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
      fireEvent.click(screen.getByText("fire-success"));
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("Yay")).toBeInTheDocument();
  });

  it("allows the same message again after the first was dismissed", () => {
    renderWithProvider();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });
    expect(screen.queryByText("Boom")).toBeNull();
    act(() => {
      fireEvent.click(screen.getByText("fire-error"));
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });
});
