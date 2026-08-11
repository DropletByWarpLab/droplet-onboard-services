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
  placement,
  sideWidth,
  flush,
}: {
  initiallyOpen?: boolean;
  closeOnBackdrop?: boolean;
  withDescribedBy?: boolean;
  placement?: "center" | "right";
  sideWidth?: "default" | "sheet";
  flush?: boolean;
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
        placement={placement}
        sideWidth={sideWidth}
        flush={flush}
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

  it("uses the indigo var(--scrim) + backdrop-blur-sm for centered placement (WARP-1079 parity)", () => {
    // WARP-1079: every modal backdrop is the shell scrim token, and the
    // backdrop carries the `droplet-shell` scope class so the token (and
    // everything inside the portal) resolves on shell AND non-shell pages.
    render(<Harness initiallyOpen />);
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    expect(backdrop.style.background).toBe("var(--scrim)");
    expect(backdrop.className).toContain("droplet-shell");
    expect(backdrop.className).toContain("backdrop-blur-sm");
  });

  it("uses var(--scrim) with NO blur for side placement (pre-existing side-panel convention)", () => {
    // Side panels stay blur-free so the user can still scan the
    // underlying list while the panel is open. Keep this separate from
    // the centered case.
    render(<Harness initiallyOpen placement="right" />);
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    expect(backdrop.style.background).toBe("var(--scrim)");
    expect(backdrop.className).toContain("droplet-shell");
    expect(backdrop.className).not.toContain("backdrop-blur-sm");
  });

  /* ══ WARP-1787 — a side panel is a SHEET on a phone, not a drawer ═══════
     Sam reported the switch port-detail panel opening as "a right-hand drawer
     taking ~60% of the screen width", with the Network page left visible but
     unusable behind it. Measured in Chrome against the production CSS bundle:
     the panel is `w-full max-w-md`, so at a 700px viewport it renders 448px —
     **64% of the screen**, which is the number in the report. At 375px
     `max-w-md` never binds, which is why the defect hid from a 375-only pass.

     `max-w-md` is 448px and a 448px overlay is a desktop drawer, not a mobile
     sheet (`04-coding-standards/mobile-web-layout.md` §4 + checklist 7). The
     override lives in the shell's phone layer at the shell's own 720px
     breakpoint — Tailwind's md is 768 and sm is 640, and mixing the two
     leaves a dead zone (§4). This asserts the hook the stylesheet needs;
     `src/__tests__/shell/mobile-layout-contract.test.ts` asserts the rule. */
  it("marks a right-placement panel so the phone layer can make it full-width", () => {
    render(<Harness initiallyOpen placement="right" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("dlg-side");
    // The desktop cap stays a utility — the phone layer overrides it.
    expect(dialog.className).toContain("max-w-md");
  });

  it("leaves the 520px `sheet` width alone — its packet already locks min(520px, 100vw)", () => {
    render(<Harness initiallyOpen placement="right" sideWidth="sheet" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("dlg-side");
    // Only the default (max-w-md) panel opts into the full-width phone sheet.
    expect(dialog.className).not.toContain("dlg-side-panel");
    expect(dialog.className).toContain("max-w-[520px]");
  });

  it("does not mark a CENTERED dialog — it keeps its 24px backdrop inset", () => {
    render(<Harness initiallyOpen />);
    expect(screen.getByRole("dialog").className).not.toContain("dlg-side");
  });

  it("traps Tab forward: from last focusable wraps to first", async () => {
    // WARP-289 UX fold-in. Without this the dialog's aria-modal="true"
    // is a lie — keyboard users tab past the close button straight into
    // background chrome. The trap wraps Tab from the last child back
    // to the first.
    function FocusTrapHarness() {
      const [open, setOpen] = React.useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          labelledBy="ft-heading"
        >
          <h2 id="ft-heading">Trap</h2>
          <button>btn-1</button>
          <button>btn-2</button>
          <button>btn-3</button>
        </Dialog>
      );
    }
    render(<FocusTrapHarness />);
    const dialog = await screen.findByRole("dialog");
    const buttons = dialog.querySelectorAll("button");
    const last = buttons[buttons.length - 1] as HTMLButtonElement;
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: "Tab" });
    await waitFor(() => {
      expect(document.activeElement).toBe(buttons[0]);
    });
  });

  it("traps Shift+Tab backward: from first focusable wraps to last", async () => {
    function FocusTrapHarness() {
      const [open, setOpen] = React.useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          labelledBy="ft-heading-2"
        >
          <h2 id="ft-heading-2">Trap</h2>
          <button>btn-1</button>
          <button>btn-2</button>
          <button>btn-3</button>
        </Dialog>
      );
    }
    render(<FocusTrapHarness />);
    const dialog = await screen.findByRole("dialog");
    const buttons = dialog.querySelectorAll("button");
    const first = buttons[0] as HTMLButtonElement;
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    });
  });

  // ── Padding + overflow contract (WARP-1152 / WARP-1153) ──────────────
  // The primitive owns the body inset and horizontal-overflow policy so a
  // consumer can't render content flush against the card edge or grow an
  // internal horizontal scrollbar (the WARP-1152 New-event regression).

  it("centered: wraps children in a p-5 body that scrolls vertically and clips horizontally", () => {
    render(<Harness initiallyOpen />);
    const dialog = screen.getByRole("dialog");
    const body = dialog.firstElementChild as HTMLElement;
    expect(body.className).toContain("p-5");
    expect(body.className).toContain("max-h-[90vh]");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("overflow-x-hidden");
    // The consumer's children live inside the body region.
    expect(body.contains(document.getElementById("dialog-heading"))).toBe(true);
  });

  it("centered + flush: drops the p-5 inset but keeps the scroll/clip region (flush is never an overflow opt-out)", () => {
    render(<Harness initiallyOpen flush />);
    const dialog = screen.getByRole("dialog");
    const body = dialog.firstElementChild as HTMLElement;
    expect(body.className).not.toContain("p-5");
    expect(body.className).toContain("max-h-[90vh]");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("overflow-x-hidden");
  });

  it("side placement: container clips horizontal overflow; default adds the p-5 inset", () => {
    render(<Harness initiallyOpen placement="right" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(dialog.className).toContain("overflow-x-hidden");
    const body = dialog.firstElementChild as HTMLElement;
    expect(body.className).toContain("p-5");
  });

  it("side placement + flush: children render directly so h-full section layouts keep working", () => {
    render(<Harness initiallyOpen placement="right" flush />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("overflow-x-hidden");
    // No injected body wrapper — the heading is a direct child.
    expect(
      (document.getElementById("dialog-heading") as HTMLElement).parentElement,
    ).toBe(dialog);
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
