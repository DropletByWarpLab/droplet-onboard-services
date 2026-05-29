/**
 * Tests for the WARP-291 <ConfirmDialog> primitive.
 *
 * Built on top of the WARP-289 <Dialog> primitive. Covers the API
 * described in the WARP-291 spec:
 *   - title + description + verb-first confirmLabel + cancelLabel
 *   - destructive vs neutral variants (button styling differs)
 *   - async onConfirm: resolve → onCancel fires (closes); reject → stays
 *   - loading state on confirm button while pending
 *   - cancel calls onCancel
 *   - Escape close (inherited from <Dialog>)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";

// Stub framer-motion so animations don't gate the assertions.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => true,
  };
});

function Harness({
  variant = "destructive",
  confirmFn,
  onCancelSpy,
}: {
  variant?: "destructive" | "neutral";
  confirmFn: () => Promise<void>;
  onCancelSpy: () => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <ConfirmDialog
      open={open}
      onConfirm={confirmFn}
      onCancel={() => {
        setOpen(false);
        onCancelSpy();
      }}
      title="Revoke invite?"
      description="Bob won't be able to use this link anymore."
      confirmLabel="Revoke"
      variant={variant}
    />
  );
}

describe("<ConfirmDialog> primitive", () => {
  it("renders title, description, and verb-first confirmLabel + default Cancel", () => {
    render(
      <Harness confirmFn={vi.fn().mockResolvedValue(undefined)} onCancelSpy={vi.fn()} />,
    );
    expect(screen.getByText("Revoke invite?")).toBeInTheDocument();
    expect(
      screen.getByText("Bob won't be able to use this link anymore."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("destructive variant uses bg-system-red on the confirm button", () => {
    render(
      <Harness confirmFn={vi.fn().mockResolvedValue(undefined)} onCancelSpy={vi.fn()} />,
    );
    const confirm = screen.getByRole("button", { name: "Revoke" });
    expect(confirm.className).toMatch(/bg-system-red/);
  });

  it("neutral variant uses dp-btn-primary on the confirm button", () => {
    render(
      <Harness
        variant="neutral"
        confirmFn={vi.fn().mockResolvedValue(undefined)}
        onCancelSpy={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Revoke" });
    expect(confirm.className).toMatch(/dp-btn-primary/);
    expect(confirm.className).not.toMatch(/bg-system-red/);
  });

  it("click confirm resolves: calls onConfirm then onCancel (closes)", async () => {
    const confirmFn = vi.fn().mockResolvedValue(undefined);
    const cancelSpy = vi.fn();
    render(<Harness confirmFn={confirmFn} onCancelSpy={cancelSpy} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(confirmFn).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("click confirm rejects: onConfirm called, dialog stays open (no onCancel)", async () => {
    const confirmFn = vi.fn().mockRejectedValue(new Error("network"));
    const cancelSpy = vi.fn();
    render(<Harness confirmFn={confirmFn} onCancelSpy={cancelSpy} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(confirmFn).toHaveBeenCalledTimes(1);
    });
    // Give the rejection a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelSpy).not.toHaveBeenCalled();
    // Dialog still in DOM.
    expect(screen.getByText("Revoke invite?")).toBeInTheDocument();
  });

  it("click cancel calls onCancel", () => {
    const cancelSpy = vi.fn();
    render(
      <Harness
        confirmFn={vi.fn().mockResolvedValue(undefined)}
        onCancelSpy={cancelSpy}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("loading state: confirm button disabled and shows 'Working…' while in flight", async () => {
    // A controllable promise so we can observe the in-flight state.
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((res) => {
      resolveFn = res;
    });
    const confirmFn = vi.fn().mockReturnValue(promise);
    render(<Harness confirmFn={confirmFn} onCancelSpy={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(btn);
    await waitFor(() => {
      // While the promise is pending the button is disabled and the
      // visible label changes to "Working…" so the user knows the
      // action is in flight (and can't double-click).
      const inflight = screen.getByRole("button", { name: /working/i });
      expect(inflight).toBeDisabled();
    });
    resolveFn();
  });

  it("Escape closes via inherited <Dialog> behavior", async () => {
    const cancelSpy = vi.fn();
    render(
      <Harness
        confirmFn={vi.fn().mockResolvedValue(undefined)}
        onCancelSpy={cancelSpy}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("renders nothing when open=false", () => {
    function OffHarness() {
      return (
        <ConfirmDialog
          open={false}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          title="Hidden"
          description="should not render"
          confirmLabel="Go"
        />
      );
    }
    render(<OffHarness />);
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.queryByText("should not render")).toBeNull();
  });
});
