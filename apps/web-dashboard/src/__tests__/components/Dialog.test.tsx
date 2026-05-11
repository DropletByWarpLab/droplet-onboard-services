/**
 * Tests for the WARP-289 <Dialog> primitive.
 *
 * This is the canonical modal-dialog primitive for the dashboard. All
 * existing hand-rolled modals (PairDialog, EventForm, ZoneEditor's
 * name-prompt, the smart-home / client / network DeviceDetailPanels,
 * OverrideModal, ScheduleEditorModal, GroupManagerDialog) migrate onto
 * this in the same ticket.
 *
 * The gold-standard reference pattern lives in `app/users/page.tsx`
 * (WARP-217): `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
 * (via `useId`) + Escape close + focus return to trigger + body
 * scroll-lock. This primitive folds all of that into one place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React, { useRef } from "react";

import { Dialog } from "@/components/Dialog";

// Stub framer-motion so `useReducedMotion` returns a deterministic value
// and `motion.div` collapses to a plain div — we don't want to test
// animation timing here, only ARIA + behavior.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => true,
    // Preserve the actual AnimatePresence + motion.div for behavior
    // (they render their children synchronously when reduced-motion
    // is on); we only stub the hook above.
  };
});

function Harness({
  initiallyOpen = false,
  closeOnBackdrop = true,
  withDescribedBy = false,
}: {
  initiallyOpen?: boolean;
  closeOnBackdrop?: boolean;
  withDescribedBy?: boolean;
}) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        labelledBy="dialog-heading"
        describedBy={withDescribedBy ? "dialog-desc" : undefined}
        closeOnBackdrop={closeOnBackdrop}
      >
        <h2 id="dialog-heading">Confirm</h2>
        {withDescribedBy && <p id="dialog-desc">Are you sure?</p>}
        <button>First focusable</button>
        <button>Second</button>
      </Dialog>
    </div>
  );
}

describe("<Dialog> primitive", () => {
  beforeEach(() => {
    // Reset body style between tests (the lock toggles `overflow`).
    document.body.style.overflow = "";
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("renders nothing when closed", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders to a portal with role=dialog + aria-modal + aria-labelledby", () => {
    render(<Harness initiallyOpen />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "dialog-heading");
    // aria-labelledby resolves to a real element with the right text.
    const heading = document.getElementById("dialog-heading");
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe("Confirm");
  });

  it("threads aria-describedby when provided", () => {
    render(<Harness initiallyOpen withDescribedBy />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-describedby", "dialog-desc");
  });

  it("focuses the first focusable child on open", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe("First focusable");
    });
  });

  it("closes on Escape keydown", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("closes on backdrop click by default", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("does NOT close on backdrop click when closeOnBackdrop=false", async () => {
    render(<Harness closeOnBackdrop={false} />);
    fireEvent.click(screen.getByText("Open"));
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    // Give the (non-existent) close path a tick to fire then assert still open.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("restores focus to triggerRef on close", async () => {
    render(<Harness />);
    const trigger = screen.getByText("Open");
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      // Focus returns to the original trigger button.
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("locks body scroll while open and restores on close", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => {
      expect(document.body.style.overflow).toBe("hidden");
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.body.style.overflow).toBe("");
    });
  });
});
