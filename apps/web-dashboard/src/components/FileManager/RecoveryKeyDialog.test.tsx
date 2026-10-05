/**
 * WARP-3515 — the one-time recovery-key dialog.
 *
 * Every data drive is LUKS2 (ADR-070) and has a recovery key that the owner can
 * reveal ONCE (`POST .../recovery-key/reveal`, tier 2). The dialog is where that
 * promise is kept or broken, so the cases below are strict about four things:
 *
 *   1. NOTHING IS CONSUMED BY OPENING IT. The key is revealed only when the
 *      owner asks for it ("Show recovery key"), never on open, never on retry
 *      of a flow that already succeeded.
 *   2. ONCE SHOWN, IT CANNOT BE DISMISSED BY ACCIDENT. Escape, a backdrop click
 *      and the browser can't close it; the only way out is the explicit
 *      "I've saved it", which also wipes the key from the DOM.
 *   3. "GONE" IS NOT "BROKEN". A 410 reads as "already shown or expired", a
 *      flaky network as "try again" — never the reverse, or a retryable failure
 *      is worded as a lost key.
 *   4. A MISSED KEY IS RECOVERABLE. Droplet shreds an unrevealed key after 7
 *      days, so the "gone" state offers a new one — a tier-3 action behind a
 *      typed phrase, because the old key stops working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, revealRecoveryKey: vi.fn() };
});

vi.mock("@/lib/print-recovery-key", () => ({ printRecoveryKey: vi.fn() }));

import { revealRecoveryKey, RecoveryKeyUnavailableError } from "@/lib/api";
import { printRecoveryKey } from "@/lib/print-recovery-key";
import { RecoveryKeyDialog } from "./RecoveryKeyDialog";

const revealMock = vi.mocked(revealRecoveryKey);
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

  it("says an unshown key is only held for 7 days", () => {
    setup();
    expect(screen.getByRole("dialog")).toHaveTextContent(/7 days/i);
  });

  it("does NOT reveal the key just because it opened", () => {
    setup();
    expect(revealMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-key-value")).not.toBeInTheDocument();
  });

  it("puts initial focus on the way forward, and 'Not now' leaves the key unconsumed", async () => {
    const { onClose } = setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show recovery key/i })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(revealMock).not.toHaveBeenCalled();
  });

  it("can be dismissed with Escape before the key is shown (nothing is lost)", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("RecoveryKeyDialog — asking for the key", () => {
  it("resolves the drive, reveals the key exactly once, and shows it", async () => {
    const { resolveDriveId } = setup();
    revealMock.mockResolvedValueOnce(KEY);

    await reveal();

    expect(resolveDriveId).toHaveBeenCalledTimes(1);
    expect(revealMock).toHaveBeenCalledTimes(1);
    expect(revealMock).toHaveBeenCalledWith("U-BAY-2");
    expect(screen.getByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });

  it("a second click while the request is in flight does not fire a second reveal", async () => {
    setup();
    let release!: (k: string) => void;
    revealMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );

    const button = screen.getByRole("button", { name: /show recovery key/i });
    fireEvent.click(button);
    fireEvent.click(button);
    // The drive id resolves asynchronously first; let the request actually start.
    await waitFor(() => expect(revealMock).toHaveBeenCalledTimes(1));
    release(KEY);
    await screen.findByTestId("recovery-key-value");

    expect(revealMock).toHaveBeenCalledTimes(1);
  });

  it("offers copy and print, and gates 'I've saved it' behind an explicit acknowledgement", async () => {
    setup();
    revealMock.mockResolvedValueOnce(KEY);
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
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();
    await waitFor(() => expect(screen.getByTestId("recovery-key-value")).toHaveFocus());
  });

  it("says the key will not be shown again", async () => {
    setup();
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();
    expect(screen.getByRole("dialog")).toHaveTextContent(/only time/i);
  });
});

describe("RecoveryKeyDialog — once shown it cannot be dismissed by accident", () => {
  it("ignores Escape", async () => {
    const { onClose } = setup();
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-key-value")).toBeInTheDocument();
  });

  it("ignores a backdrop click", async () => {
    const { onClose } = setup();
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only through 'I've saved it', and the key leaves the page", async () => {
    const { onClose, rerender } = setup();
    revealMock.mockResolvedValueOnce(KEY);
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
    revealMock.mockResolvedValueOnce(KEY);
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
    revealMock.mockResolvedValueOnce(KEY);
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
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("button", { name: /^copy/i }));

    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });

  it("prints a page that names the drive and carries the key", async () => {
    setup();
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();

    fireEvent.click(screen.getByRole("button", { name: /print/i }));

    expect(printMock).toHaveBeenCalledTimes(1);
    expect(printMock).toHaveBeenCalledWith({ driveName: "Bay 2", recoveryKey: KEY });
  });
});

describe("RecoveryKeyDialog — when the key cannot be handed over", () => {
  it("410: says it was already shown or expired — and shows no key", async () => {
    const { onClose } = setup();
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"));

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));

    const description = await screen.findByText(/already been shown/i);
    expect(description).toHaveTextContent(/expired|7 days/i);
    expect(screen.queryByTestId("recovery-key-value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("404: says there is no key for this drive", async () => {
    setup();
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("not_found"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    expect(await screen.findByText(/doesn't have a recovery key/i)).toBeInTheDocument();
  });

  it("403: says only the owner can view it", async () => {
    setup();
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("forbidden"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    expect(await screen.findByText(/only the owner/i)).toBeInTheDocument();
  });

  it("a flaky network is 'try again', NOT 'already shown'", async () => {
    setup();
    revealMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(KEY);

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't reach/i);
    expect(alert).not.toHaveTextContent(/already/i);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
    expect(revealMock).toHaveBeenCalledTimes(2);
  });

  it("a drive that is not visible yet is 'give it a few seconds', and no key is revealed", async () => {
    const resolveDriveId = vi.fn().mockResolvedValue(null);
    setup({ resolveDriveId });

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));

    expect(await screen.findByText(/can't find Bay 2 yet/i)).toBeInTheDocument();
    expect(revealMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("RecoveryKeyDialog — a missed or expired key can be replaced (tier 3)", () => {
  async function toGone(props: Partial<React.ComponentProps<typeof RecoveryKeyDialog>> = {}) {
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    const utils = setup({ onRegenerate, ...props });
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    await screen.findByText(/already been shown/i);
    return { onRegenerate, ...utils };
  }

  async function openConfirm() {
    fireEvent.click(screen.getByRole("button", { name: /generate a new recovery key/i }));
    const heading = await screen.findByRole("heading", { name: /generate a new recovery key\?/i });
    return heading.closest('[role="dialog"]') as HTMLElement;
  }

  it("offers a new key in the 'gone' state — and only there", async () => {
    await toGone();
    expect(screen.getByRole("button", { name: /generate a new recovery key/i })).toBeInTheDocument();
  });

  it("is not offered on the intro, nor when the key itself is shown", async () => {
    setup({ onRegenerate: vi.fn() });
    expect(screen.queryByRole("button", { name: /generate a new/i })).not.toBeInTheDocument();
    revealMock.mockResolvedValueOnce(KEY);
    await reveal();
    expect(screen.queryByRole("button", { name: /generate a new/i })).not.toBeInTheDocument();
  });

  it.each([
    ["a 403", () => new RecoveryKeyUnavailableError("forbidden")],
    ["a 404", () => new RecoveryKeyUnavailableError("not_found")],
    ["a network failure", () => new TypeError("Failed to fetch")],
  ])("is not offered after %s", async (_name, make) => {
    setup({ onRegenerate: vi.fn() });
    revealMock.mockRejectedValueOnce(make());
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    await waitFor(() => expect(screen.queryByText(/getting your key/i)).not.toBeInTheDocument());
    expect(revealMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /generate a new/i })).not.toBeInTheDocument();
  });

  it("is not offered when the parent does not support it", async () => {
    setup();
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    await screen.findByText(/already been shown/i);
    expect(screen.queryByRole("button", { name: /generate a new/i })).not.toBeInTheDocument();
  });

  it("asks first — naming the drive, saying the old key stops working — and runs nothing yet", async () => {
    const { onRegenerate } = await toGone();
    const confirm = await openConfirm();
    expect(confirm).toHaveTextContent(/Bay 2/);
    expect(confirm).toHaveTextContent(/old (recovery )?key will stop working/i);
    const button = within(confirm).getByRole("button", { name: /^generate new key$/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("needs the drive's name typed, then regenerates once for the resolved drive id", async () => {
    const { onRegenerate } = await toGone();
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "not it" } });
    expect(within(confirm).getByRole("button", { name: /^generate new key$/i })).toBeDisabled();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Bay 2" } });
    fireEvent.click(within(confirm).getByRole("button", { name: /^generate new key$/i }));

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
    expect(onRegenerate).toHaveBeenCalledWith("U-BAY-2");
  });

  it("afterwards the dialog is back at the start: a new key is ready to be shown", async () => {
    await toGone();
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Bay 2" } });
    fireEvent.click(within(confirm).getByRole("button", { name: /^generate new key$/i }));

    const show = await screen.findByRole("button", { name: /show recovery key/i });
    expect(screen.getByRole("dialog", { name: /save your recovery key/i })).toHaveTextContent(
      /new recovery key is ready/i,
    );
    expect(screen.getByRole("dialog", { name: /save your recovery key/i })).toHaveTextContent(
      /old one no longer works/i,
    );

    revealMock.mockResolvedValueOnce(KEY);
    fireEvent.click(show);
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });

  it("a refusal keeps the confirm open with calm copy — never the raw error", async () => {
    const onRegenerate = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("EBUSY cryptsetup /dev/sdb1"), { status: 409 }));
    await toGone({ onRegenerate });
    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Bay 2" } });
    fireEvent.click(within(confirm).getByRole("button", { name: /^generate new key$/i }));

    expect(await within(confirm).findByRole("alert")).toHaveTextContent(/right now/i);
    expect(document.body.textContent).not.toMatch(/EBUSY|cryptsetup|sdb1/);
    // Still the confirm, still the same dialog underneath.
    expect(screen.getByText(/already been shown/i)).toBeInTheDocument();
  });

  it("a drive that cannot be found is said plainly, and nothing is regenerated", async () => {
    const onRegenerate = vi.fn();
    const resolveDriveId = vi
      .fn()
      .mockResolvedValueOnce("U-BAY-2") // for the failed reveal
      .mockResolvedValueOnce(null); // for the regenerate
    setup({ onRegenerate, resolveDriveId });
    revealMock.mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"));
    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));
    await screen.findByText(/already been shown/i);

    const confirm = await openConfirm();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Bay 2" } });
    fireEvent.click(within(confirm).getByRole("button", { name: /^generate new key$/i }));

    expect(await within(confirm).findByRole("alert")).toHaveTextContent(/can't find Bay 2/i);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("Cancel leaves everything as it was", async () => {
    const { onRegenerate } = await toGone();
    const confirm = await openConfirm();
    fireEvent.click(within(confirm).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /generate a new recovery key\?/i })).not.toBeInTheDocument(),
    );
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(screen.getByText(/already been shown/i)).toBeInTheDocument();
  });

  it("Escape closes only the confirm, not the dialog beneath it", async () => {
    const { onClose } = await toGone();
    await openConfirm();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /generate a new recovery key\?/i })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/already been shown/i)).toBeInTheDocument();
  });
});
