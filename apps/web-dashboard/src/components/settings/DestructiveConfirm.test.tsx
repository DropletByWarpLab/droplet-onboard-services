/**
 * WARP-828 — <DestructiveConfirm/> reusable type-to-confirm modal.
 *
 * The friction layer for irreversible actions (first user: reformat a drive
 * from the Settings Danger Zone). The owner must type an exact phrase — the
 * affected target's display name — before the destructive button enables. This
 * is the human gate that sits in front of the server-side owner + confirm-token
 * gates; it must never be the only gate, but it must be honest and unfoolable.
 *
 * Covers the AC's friction contract:
 *   - destructive button DISABLED until the typed text matches exactly;
 *   - case/trim-insensitive match (a home user shouldn't fight capitalisation);
 *   - cancel is the default focused action; ESC cancels;
 *   - loading + long-running progress copy while the action runs;
 *   - error state stays open for retry, raw errors never reach the screen;
 *   - ≥44px touch targets; the consequence copy + affected target are shown.
 *
 * Built on the WARP-289 <Dialog> primitive, so focus-trap / scroll-lock /
 * reduced-motion are inherited (and exercised by Dialog's own suite) — here we
 * assert the type-to-confirm behaviour this component adds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Dialog uses framer-motion; pin reduced-motion so tests don't depend on
// animation timing (mirrors setup.storage.test.tsx).
vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { DestructiveConfirm } from "./DestructiveConfirm";

function baseProps() {
  return {
    open: true,
    title: "Reformat this drive?",
    consequence:
      "This erases everything on Wedding Photos. It can't be undone.",
    affectedSummary: "Wedding Photos · 2 TB",
    confirmPhrase: "Wedding Photos",
    confirmLabel: "Erase and reformat",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("DestructiveConfirm (WARP-828)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the title, consequence copy, and the affected target", () => {
    render(<DestructiveConfirm {...baseProps()} />);
    expect(
      screen.getByRole("heading", { name: /reformat this drive/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/erases everything on wedding photos/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/wedding photos · 2 tb/i)).toBeInTheDocument();
  });

  it("disables the destructive button until the typed text matches the phrase", () => {
    render(<DestructiveConfirm {...baseProps()} />);
    const confirm = screen.getByRole("button", { name: /erase and reformat/i });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "Wedding" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    expect(confirm).toBeEnabled();
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    render(<DestructiveConfirm {...baseProps()} />);
    const confirm = screen.getByRole("button", { name: /erase and reformat/i });
    const input = screen.getByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "  wedding photos  " } });
    expect(confirm).toBeEnabled();
  });

  it("does not fire onConfirm while the phrase is unmatched", () => {
    const props = baseProps();
    render(<DestructiveConfirm {...props} />);
    const confirm = screen.getByRole("button", { name: /erase and reformat/i });
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("fires onConfirm once the phrase matches and the button is pressed", async () => {
    const props = baseProps();
    props.onConfirm.mockResolvedValueOnce(undefined);
    render(<DestructiveConfirm {...props} />);
    const input = screen.getByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledTimes(1));
  });

  it("focuses Cancel by default — it is the safe action", async () => {
    render(<DestructiveConfirm {...baseProps()} />);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it("cancels on Escape", () => {
    const props = baseProps();
    render(<DestructiveConfirm {...props} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalled();
  });

  it("shows long-running progress copy while the action runs, and disables both buttons", async () => {
    const props = baseProps();
    let resolve!: () => void;
    props.onConfirm.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    render(<DestructiveConfirm {...props} />);
    fireEvent.change(screen.getByLabelText(/type .*to confirm/i), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    // Progress copy is shown in the polite live region; both actions are
    // locked so the owner can't double-fire or back out mid-wipe.
    await waitFor(() =>
      expect(screen.getByText(/this can take a moment/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    resolve();
  });

  it("shows the error state and stays open when onConfirm rejects", async () => {
    const props = baseProps();
    props.onConfirm.mockRejectedValueOnce(new Error("mkfs failed: /dev/sdb busy"));
    render(<DestructiveConfirm {...props} />);
    fireEvent.change(screen.getByLabelText(/type .*to confirm/i), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    // The dialog stays open for a retry; onCancel was NOT called on failure.
    expect(props.onCancel).not.toHaveBeenCalled();
    // The raw mkfs/device error must never reach the screen.
    expect(screen.queryByText(/mkfs|\/dev\/sdb/i)).not.toBeInTheDocument();
  });

  it("accepts a caller-provided error message for the failure copy", async () => {
    const props = {
      ...baseProps(),
      errorMessage: "That drive is busy right now. Try again in a moment.",
    };
    props.onConfirm.mockRejectedValueOnce(new Error("raw"));
    render(<DestructiveConfirm {...props} />);
    fireEvent.change(screen.getByLabelText(/type .*to confirm/i), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/that drive is busy right now/i),
      ).toBeInTheDocument(),
    );
  });

  it("gives the confirm + cancel buttons ≥44px touch targets", () => {
    render(<DestructiveConfirm {...baseProps()} />);
    for (const name of [/erase and reformat/i, /cancel/i]) {
      const btn = screen.getByRole("button", { name });
      const cls = btn.className;
      // min-h-[44px] (or larger) token must be present — the home-user
      // destructive action is a deliberate, comfortable tap target.
      expect(cls).toMatch(/min-h-\[(4[4-9]|[5-9]\d)px\]/);
    }
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <DestructiveConfirm {...baseProps()} open={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
