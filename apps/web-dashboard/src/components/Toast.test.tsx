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

  it("rebinds the action to the newest call when an identical actioned toast fires again", () => {
    // WARP-1912 review finding — the WARP-1306 dedupe used to DROP the second
    // actioned twin, leaving the surviving Undo bound to the FIRST batch's
    // paths. Two same-count uploads inside one toast lifetime then made Undo
    // delete the wrong files. The twin must be REPLACED so Undo always
    // targets the latest batch.
    const firstBatch = vi.fn();
    const secondBatch = vi.fn();
    function TwoBatches() {
      const { toast } = useToast();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              toast("Uploaded 1 file.", "success", {
                label: "Undo",
                onClick: firstBatch,
              })
            }
          >
            fire-first
          </button>
          <button
            type="button"
            onClick={() =>
              toast("Uploaded 1 file.", "success", {
                label: "Undo",
                onClick: secondBatch,
              })
            }
          >
            fire-second
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <TwoBatches />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText("fire-first"));
    fireEvent.click(screen.getByText("fire-second"));

    // Dedupe posture holds — still exactly one toast on screen…
    expect(screen.getAllByText("Uploaded 1 file.")).toHaveLength(1);

    // …but its Undo belongs to the LATEST batch, not the first.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(secondBatch).toHaveBeenCalledTimes(1);
    expect(firstBatch).not.toHaveBeenCalled();
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
