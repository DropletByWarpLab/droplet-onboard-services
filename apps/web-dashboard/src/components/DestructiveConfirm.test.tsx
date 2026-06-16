/**
 * WARP-825 — <DestructiveConfirm>: a reusable type-to-confirm modal for
 * high-blast-radius destructive actions (DZ4 design).
 *
 * Contract under test:
 *   - Renders the title + blunt consequence copy + an affected-target summary.
 *   - The destructive button is DISABLED until the owner types the exact confirm
 *     phrase (the friction step) — case-sensitive, trim-tolerant.
 *   - Cancel is the default action and always available.
 *   - onConfirm fires only after the friction step is cleared.
 *   - A long-running confirm shows a loading/progress state and disables the
 *     destructive button so it can't double-fire.
 *   - An error from onConfirm is surfaced (friendly), the modal stays open, and
 *     the user can retry.
 *   - Not rendered when `open` is false.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { DestructiveConfirm } from "./DestructiveConfirm";

function setup(overrides: Partial<React.ComponentProps<typeof DestructiveConfirm>> = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn().mockResolvedValue(undefined);
  const onCancel = overrides.onCancel ?? vi.fn();
  const props: React.ComponentProps<typeof DestructiveConfirm> = {
    open: true,
    title: "Factory reset this Droplet?",
    consequence:
      "This erases every account, file, message, and setting on the box and returns it to first-run setup. It cannot be undone.",
    confirmPhrase: "droplet-home",
    confirmLabel: "Factory reset",
    targetSummary: "droplet-home",
    onConfirm,
    onCancel,
    ...overrides,
  };
  render(<DestructiveConfirm {...props} />);
  return { onConfirm, onCancel };
}

describe("DestructiveConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when closed", () => {
    setup({ open: false });
    expect(screen.queryByText(/factory reset this droplet/i)).not.toBeInTheDocument();
  });

  it("renders title, consequence copy, and the affected-target summary", () => {
    setup();
    expect(screen.getByText(/factory reset this droplet/i)).toBeInTheDocument();
    expect(screen.getByText(/returns it to first-run setup/i)).toBeInTheDocument();
    // The target the owner is acting on is shown so they can't act on the wrong box.
    expect(screen.getAllByText(/droplet-home/i).length).toBeGreaterThan(0);
  });

  it("disables the destructive button until the confirm phrase is typed", () => {
    setup();
    const btn = screen.getByRole("button", { name: /factory reset/i });
    expect(btn).toBeDisabled();

    const input = screen.getByLabelText(/type .* to confirm/i);
    fireEvent.change(input, { target: { value: "droplet-home" } });
    expect(btn).toBeEnabled();
  });

  it("keeps the destructive button disabled for a wrong phrase", () => {
    setup();
    const input = screen.getByLabelText(/type .* to confirm/i);
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(screen.getByRole("button", { name: /factory reset/i })).toBeDisabled();
  });

  it("calls onConfirm once the phrase matches and the button is pressed", async () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: "droplet-home" },
    });
    fireEvent.click(screen.getByRole("button", { name: /factory reset/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("Cancel is available and calls onCancel", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a progress state and prevents double-fire while confirming", async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    setup({ onConfirm });
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: "droplet-home" },
    });
    const btn = screen.getByRole("button", { name: /factory reset/i });
    fireEvent.click(btn);

    // Progress copy appears and the button is disabled (no second fire).
    await waitFor(() => expect(screen.getByText(/resetting|working|in progress/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /resetting|working|factory reset/i })).toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("surfaces a friendly error and stays open for retry", async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error("A factory reset is already in progress."));
    setup({ onConfirm });
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: "droplet-home" },
    });
    fireEvent.click(screen.getByRole("button", { name: /factory reset/i }));
    await waitFor(() =>
      expect(screen.getByText(/already in progress/i)).toBeInTheDocument(),
    );
    // Still open — the title is still present.
    expect(screen.getByText(/factory reset this droplet/i)).toBeInTheDocument();
  });

  describe("server-validated mode (no confirmPhrase — 2026-06-09 sweep)", () => {
    const serverProps = {
      confirmPhrase: undefined,
      confirmPrompt: "your device's name",
      confirmHint: "d••••••e",
      targetSummary: "d••••••e",
    };

    it("shows the prompt + masked hint, never an exact phrase to copy", () => {
      setup(serverProps);
      expect(screen.getByText(/your device's name/i)).toBeInTheDocument();
      expect(screen.getAllByText(/d••••••e/).length).toBeGreaterThan(0);
    });

    it("gates the destructive button on non-empty input (server is the authority)", () => {
      setup(serverProps);
      const btn = screen.getByRole("button", { name: /factory reset/i });
      expect(btn).toBeDisabled();
      fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
        target: { value: "droplet-home" },
      });
      expect(btn).toBeEnabled();
    });

    it("passes the typed (trimmed) value to onConfirm", async () => {
      const { onConfirm } = setup(serverProps);
      fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
        target: { value: "  droplet-home  " },
      });
      fireEvent.click(screen.getByRole("button", { name: /factory reset/i }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("droplet-home"));
    });

    it("surfaces a server mismatch verdict and stays open for retry", async () => {
      const onConfirm = vi
        .fn()
        .mockRejectedValueOnce(new Error("Type your device's name to confirm."));
      setup({ ...serverProps, onConfirm });
      fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
        target: { value: "wrong-name" },
      });
      fireEvent.click(screen.getByRole("button", { name: /factory reset/i }));
      expect(
        await screen.findByText(/type your device's name to confirm/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/factory reset this droplet/i)).toBeInTheDocument();
    });
  });
});
