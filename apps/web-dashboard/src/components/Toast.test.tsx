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

describe("Toast surface (WARP-3509)", () => {
  // `bg-system-red/10 border-system-red/25` are utilities Tailwind cannot
  // generate for a colour that is a CSS variable, so a toast had no tint and no
  // border — text laid straight over whatever page was behind it. The surface is
  // now an opaque mix of the status colour into the elevated surface, in tokens
  // only. (Their contrast is measured in events-surfaces.contrast.test.ts.)
  function Fire({ type, message }: { type: "error" | "success" | "info"; message: string }) {
    const { toast } = useToast();
    return (
      <button type="button" onClick={() => toast(message, type)}>
        fire
      </button>
    );
  }

  function toastFor(type: "error" | "success" | "info"): HTMLElement {
    cleanup();
    render(
      <ToastProvider>
        <Fire type={type} message="Something happened." />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    return screen.getByText("Something happened.").closest("[data-toast]") as HTMLElement;
  }

  it.each(["error", "success", "info"] as const)(
    "a %s toast is painted on an opaque tint of its status colour, with a border to match",
    (type) => {
      const el = toastFor(type);

      expect(el.className).toMatch(/bg-\[color:color-mix\(in_srgb,var\(--color-[\w-]+\)_\d+%,var\(--color-surface-elevated\)\)\]/);
      expect(el.className).toMatch(/border-\[color:color-mix\(in_srgb,var\(--color-[\w-]+\)_\d+%,/);
      // No alpha on a variable colour left on it.
      expect(el.className).not.toMatch(/(bg|border|text)-(system|accent|label|surface)[a-z-]*\/\d+/);
    },
  );

  it("an error toast's text is the error-text token, which clears 4.5:1 on the tint, not the vivid red", () => {
    const el = toastFor("error");

    expect(el.className).toContain("text-[color:var(--color-system-red-text)]");
    expect(el.className.split(/\s+/)).not.toContain("text-system-red");
  });

  it("success and info toasts read in the primary text colour, not their own status colour", () => {
    // The vivid green and indigo are ~1.9:1 and ~4:1 on their own tint.
    for (const type of ["success", "info"] as const) {
      expect(toastFor(type).className.split(/\s+/)).toContain("text-label-primary");
    }
  });

  it("keeps the status colour as the icon's", () => {
    const el = toastFor("success");

    expect(el.querySelector("svg.text-system-green")).not.toBeNull();
  });

  it("the Dismiss all button has a surface of its own", () => {
    function Three() {
      const { toast } = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            toast("One.", "success");
            toast("Two.", "success");
            toast("Three.", "success");
          }}
        >
          fire3
        </button>
      );
    }
    cleanup();
    render(
      <ToastProvider>
        <Three />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire3"));

    const dismissAll = screen.getByRole("button", { name: "Dismiss all" });
    expect(dismissAll.className).toContain("color-mix(in_srgb,var(--color-surface-secondary)");
    expect(dismissAll.className).not.toMatch(/bg-surface-secondary\/\d+/);
  });
});
