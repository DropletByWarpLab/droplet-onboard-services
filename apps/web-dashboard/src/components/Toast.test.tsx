/**
 * WARP-1912 — toasts can carry one optional action (Undo on the post-upload
 * confirmation). The action is a real button inside the toast, it runs the
 * callback exactly once, and it dismisses the toast so it cannot be re-fired.
 * Existing two-argument callers are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ToastProvider, useToast } from "./Toast";

function Trigger({
  onAction,
}: {
  onAction: () => void;
}) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast("Uploaded 2 files.", "success", {
          label: "Undo",
          onClick: onAction,
        })
      }
    >
      fire
    </button>
  );
}

describe("Toast action (WARP-1912)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the action and fires it once, dismissing the toast", () => {
    const onAction = vi.fn();
    render(
      <ToastProvider>
        <Trigger onAction={onAction} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByText("Uploaded 2 files.")).toBeTruthy();

    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(undo);

    expect(onAction).toHaveBeenCalledTimes(1);
    // Dismissed with the toast — no second Undo to double-delete with.
    expect(screen.queryByText("Uploaded 2 files.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("renders no action button for plain two-argument toasts", () => {
    function Plain() {
      const { toast } = useToast();
      return (
        <button type="button" onClick={() => toast("Saved.", "info")}>
          fire-plain
        </button>
      );
    }
    render(
      <ToastProvider>
        <Plain />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText("fire-plain"));
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
