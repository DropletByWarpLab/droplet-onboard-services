/**
 * PR #375 + WARP-931 — setup-wizard Two-Factor step.
 *
 * Two phases (the old "intro" screen was removed in WARP-931 so the QR shows
 * on the first screen):
 *   enroll → enrollTotp runs on MOUNT → QR + otpauth URI + 6-digit input →
 *            "Verify & enable" (calls verifyTotp). "Skip for now" abandons it.
 *   codes  → one-time recovery codes + "I've saved these" → onComplete
 *
 * The api boundary is mocked; these tests assert the auto-enroll, the phase
 * machine, the single-display of recovery codes, and the skip path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TwoFactorStep } from "./TwoFactorStep";

const enrollTotp = vi.fn();
const verifyTotp = vi.fn();
vi.mock("@/lib/api", () => ({
  enrollTotp: (...a: unknown[]) => enrollTotp(...a),
  verifyTotp: (...a: unknown[]) => verifyTotp(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  enrollTotp.mockResolvedValue({
    otpauthUri: "otpauth://totp/Droplet:stefan?secret=ABC&issuer=Droplet",
    qrDataUrl: "data:image/png;base64,QQ==",
    issuer: "Droplet",
  });
  verifyTotp.mockResolvedValue({
    enabled: true,
    recoveryCodes: ["aaaa-1111", "bbbb-2222", "cccc-3333"],
  });
});

describe("TwoFactorStep", () => {
  it("auto-enrolls on mount and shows the QR + otpauth key on the first screen (WARP-931)", async () => {
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    // No "Set up" click — enrollment fires on mount.
    await waitFor(() => expect(enrollTotp).toHaveBeenCalledTimes(1));
    const qr = await screen.findByAltText(/qr code/i);
    expect(qr).toHaveAttribute("src", "data:image/png;base64,QQ==");
    // The otpauth secret is offered for manual entry…
    expect(screen.getByText(/ABC/)).toBeInTheDocument();
    // …with the clarified copy (T3).
    expect(
      screen.getByText(/enter this key into your authenticator app/i),
    ).toBeInTheDocument();
  });

  it("links the authenticator how-to (/help#two-factor) on the first screen (WARP-931)", async () => {
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await screen.findByAltText(/qr code/i);
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "/help#two-factor");
  });

  it("entering a code and verifying reveals the one-time recovery codes", async () => {
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await screen.findByAltText(/qr code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

    await waitFor(() => expect(verifyTotp).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText("aaaa-1111")).toBeInTheDocument();
    expect(screen.getByText("bbbb-2222")).toBeInTheDocument();
    expect(screen.getByText("cccc-3333")).toBeInTheDocument();
  });

  it("an invalid code surfaces the error and stays on the enroll phase", async () => {
    verifyTotp.mockRejectedValueOnce(new Error("That code didn't match. Try again."));
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await screen.findByAltText(/qr code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

    expect(await screen.findByText(/didn't match/i)).toBeInTheDocument();
    // Still on the enroll phase — recovery codes not shown.
    expect(screen.queryByText(/aaaa-1111/)).not.toBeInTheDocument();
  });

  it("offers a retry when enrollment fails", async () => {
    enrollTotp.mockReset();
    enrollTotp
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        otpauthUri: "otpauth://totp/Droplet:stefan?secret=ABC&issuer=Droplet",
        qrDataUrl: "data:image/png;base64,QQ==",
        issuer: "Droplet",
      });
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);
    // The retry re-enrolls and the QR appears.
    expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument();
    expect(enrollTotp).toHaveBeenCalledTimes(2);
  });

  it("confirming the saved codes calls onComplete", async () => {
    const onComplete = vi.fn();
    render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);
    await screen.findByAltText(/qr code/i);
    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));
    await screen.findByText("aaaa-1111");

    const continueBtn = screen.getByRole("button", { name: /saved them|continue|done/i });
    // Gated until the user confirms they've stored the codes.
    expect(continueBtn).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(continueBtn).toBeEnabled();
    fireEvent.click(continueBtn);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("returning to an already-enabled 2FA step shows a calm 'already on' confirmation, not a Try-again loop", async () => {
    enrollTotp.mockReset();
    // The orchestrator answers 409 TOTP_ALREADY_ENABLED on re-enroll; api.ts
    // preserves the code on the thrown error.
    enrollTotp.mockRejectedValue(
      Object.assign(new Error("Two-factor authentication is already enabled."), {
        code: "TOTP_ALREADY_ENABLED",
        status: 409,
      }),
    );
    const onComplete = vi.fn();
    render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);

    expect(await screen.findByText(/two-factor is already on/i)).toBeInTheDocument();
    // No QR, no "Try again" loop, no misleading credential copy.
    expect(screen.queryByAltText(/qr code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/check your username and password/i),
    ).not.toBeInTheDocument();
    // Continue advances the wizard.
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Skip for now calls onSkip (enrollment on mount is harmless — no factor enabled)", async () => {
    const onSkip = vi.fn();
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={onSkip} />);
    await screen.findByAltText(/qr code/i);

    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    // Skipping never verifies — no factor is turned on.
    expect(verifyTotp).not.toHaveBeenCalled();
  });
});
