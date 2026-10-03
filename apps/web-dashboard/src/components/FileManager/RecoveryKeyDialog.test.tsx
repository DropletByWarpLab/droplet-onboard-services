/**
 * WARP-3515 — the one-time recovery-key dialog.
 *
 * Every data drive is LUKS2 (ADR-070) and has a recovery key that the owner can
 * retrieve ONCE. The dialog is where that promise is kept or broken, so the
 * cases below are strict about three things:
 *
 *   1. NOTHING IS CONSUMED BY OPENING IT. The key is requested only when the
 *      owner asks for it ("Show recovery key"), never on open, never on retry
 *      of a flow that already succeeded.
 *   2. ONCE SHOWN, IT CANNOT BE DISMISSED BY ACCIDENT. Escape, a backdrop click
 *      and the browser can't close it; the only way out is the explicit
 *      "I've saved it", which also wipes the key from the DOM.
 *   3. "GONE" IS NOT "BROKEN". A 410 reads as "already shown", a flaky network
 *      as "try again" — never the reverse, or a retryable failure is worded as
 *      a lost key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchRecoveryKey: vi.fn() };
});

vi.mock("@/lib/print-recovery-key", () => ({ printRecoveryKey: vi.fn() }));

import { fetchRecoveryKey, RecoveryKeyUnavailableError } from "@/lib/api";
import { printRecoveryKey } from "@/lib/print-recovery-key";
import { RecoveryKeyDialog } from "./RecoveryKeyDialog";

const fetchKeyMock = vi.mocked(fetchRecoveryKey);
const printMock = vi.mocked(printRecoveryKey);

const KEY = "cccccccc-dddddddd-eeeeeeee-ffffffff-gggggggg-hhhhhhhh";

function setup(
  overrides: Partial<React.ComponentProps<typeof RecoveryKeyDialog>> = {},
) {
  const onClose = vi.fn();
  const resolveDriveId = vi.fn().mockResolvedValue("U-BAY-2");
  const utils = render(
    <RecoveryKeyDialog
      open
      driveName="Bay 2"
      resolveDriveId={resolveDriveId}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose, resolveDriveId, ...utils };
}

async function reveal() {
  fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
  await screen.findByTestId("recovery-key-value");
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("RecoveryKeyDialog — before the key is asked for", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a labelled, described modal that names the drive and the one-time promise", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)).toHaveTextContent(/save your recovery key/i);
    const describedBy = dialog.getAttribute("aria-describedby")!;
    const description = document.getElementById(describedBy)!;
    expect(description).toHaveTextContent(/Bay 2/);
    expect(description).toHaveTextContent(/once/i);
    expect(description).toHaveTextContent(/can't show it again/i);
  });

  it("does NOT request the key just because it opened", () => {
    setup();
    expect(fetchKeyMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-key-value")).not.toBeInTheDocument();
  });

  it("puts initial focus on the way forward, and 'Not now' leaves the key unconsumed", async () => {
    const { onClose } = setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show recovery key/i })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchKeyMock).not.toHaveBeenCalled();
  });

  it("can be dismissed with Escape before the key is shown (nothing is lost)", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("RecoveryKeyDialog — asking for the key", () => {
  it("resolves the drive, requests the key exactly once, and shows it", async () => {
    const { resolveDriveId } = setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);

    await reveal();

    expect(resolveDriveId).toHaveBeenCalledTimes(1);
    expect(fetchKeyMock).toHaveBeenCalledTimes(1);
    expect(fetchKeyMock).toHaveBeenCalledWith("U-BAY-2");
    expect(screen.getByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });

  it("a second click while the request is in flight does not fire a second request", async () => {
    setup();
    let release!: (k: string) => void;
    fetchKeyMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );

    const button = screen.getByRole("button", { name: /show recovery key/i });
    fireEvent.click(button);
    fireEvent.click(button);
    // The drive id resolves asynchronously first; let the request actually start.
    await waitFor(() => expect(fetchKeyMock).toHaveBeenCalledTimes(1));
    release(KEY);
    await screen.findByTestId("recovery-key-value");

    expect(fetchKeyMock).toHaveBeenCalledTimes(1);
  });

  it("offers copy and print, and gates 'I've saved it' behind an explicit acknowledgement", async () => {
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();

    expect(screen.getByRole("button", { name: /^copy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /print/i })).toBeInTheDocument();

    const saved = screen.getByRole("button", { name: /i've saved it/i });
    expect(saved).toBeDisabled();
    // There is no "Not now" once the key is on screen — it can't be re-shown.
    expect(screen.queryByRole("button", { name: /not now/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /saved this recovery key/i }));
    expect(saved).toBeEnabled();
  });

  it("moves focus to the key when it appears, so a screen reader reads it", async () => {
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();
    await waitFor(() => expect(screen.getByTestId("recovery-key-value")).toHaveFocus());
  });

  it("says the key will not be shown again", async () => {
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();
    expect(screen.getByRole("dialog")).toHaveTextContent(/only time/i);
  });
});

describe("RecoveryKeyDialog — once shown it cannot be dismissed by accident", () => {
  it("ignores Escape", async () => {
    const { onClose } = setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-key-value")).toBeInTheDocument();
  });

  it("ignores a backdrop click", async () => {
    const { onClose } = setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only through 'I've saved it', and the key leaves the page", async () => {
    const { onClose, rerender } = setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("checkbox", { name: /saved this recovery key/i }));
    fireEvent.click(screen.getByRole("button", { name: /i've saved it/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The key is wiped the moment the owner confirms, not after the exit fade.
    expect(document.body.textContent).not.toContain(KEY);

    // …and the parent closing it leaves nothing behind either.
    rerender(
      <RecoveryKeyDialog
        open={false}
        driveName="Bay 2"
        resolveDriveId={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("opening it again starts from the intro and never re-shows the old key", async () => {
    const { rerender, onClose } = setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();
    fireEvent.click(screen.getByRole("checkbox", { name: /saved this recovery key/i }));
    fireEvent.click(screen.getByRole("button", { name: /i've saved it/i }));
    rerender(
      <RecoveryKeyDialog open={false} driveName="Bay 2" resolveDriveId={vi.fn()} onClose={onClose} />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    rerender(
      <RecoveryKeyDialog open driveName="Bay 2" resolveDriveId={vi.fn()} onClose={onClose} />,
    );
    expect(await screen.findByRole("button", { name: /show recovery key/i })).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-key-value")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
  });
});

describe("RecoveryKeyDialog — copy and print", () => {
  it("copies the key to the clipboard and says so", async () => {
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("button", { name: /^copy/i }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(KEY));
    expect(await screen.findByRole("status")).toHaveTextContent(/copied/i);
  });

  it("says so, calmly, when the clipboard is unavailable — the key stays selectable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("button", { name: /^copy/i }));

    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });

  it("prints a page that names the drive and carries the key", async () => {
    setup();
    fetchKeyMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("button", { name: /print/i }));

    expect(printMock).toHaveBeenCalledTimes(1);
    expect(printMock).toHaveBeenCalledWith({ driveName: "Bay 2", recoveryKey: KEY });
  });
});

describe("RecoveryKeyDialog — when the key cannot be handed over", () => {
  it("410: says it was already shown — and shows no key", async () => {
    const { onClose } = setup();
    fetchKeyMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"));

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));

    expect(await screen.findByText(/already been shown/i)).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-key-value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("404: says there is no key for this drive", async () => {
    setup();
    fetchKeyMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("not_found"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    expect(await screen.findByText(/doesn't have a recovery key/i)).toBeInTheDocument();
  });

  it("403: says only the owner can view it", async () => {
    setup();
    fetchKeyMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("forbidden"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    expect(await screen.findByText(/only the owner/i)).toBeInTheDocument();
  });

  it("a flaky network is 'try again', NOT 'already shown'", async () => {
    setup();
    fetchKeyMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(KEY);

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't reach/i);
    expect(alert).not.toHaveTextContent(/already/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
    expect(fetchKeyMock).toHaveBeenCalledTimes(2);
  });

  it("a drive that is not visible yet is 'give it a few seconds', and no key is requested", async () => {
    const resolveDriveId = vi.fn().mockResolvedValue(null);
    setup({ resolveDriveId });

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));

    expect(await screen.findByText(/can't find Bay 2 yet/i)).toBeInTheDocument();
    expect(fetchKeyMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
