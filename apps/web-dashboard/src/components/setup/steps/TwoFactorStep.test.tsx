/**
 * PR #375 — setup-wizard Two-Factor step.
 *
 * Three phases:
 *   intro  → explain + "Set up" (calls enrollTotp) / "Skip for now"
 *   enroll → QR + otpauth URI + 6-digit input → "Verify & enable"
 *            (calls verifyTotp)
 *   codes  → one-time recovery codes + "I've saved these" → onComplete
 *
 * The api boundary is mocked; these tests assert the phase machine, the
 * single-display of recovery codes, and the skip path.
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
  it("intro → Set up calls enrollTotp and shows the QR + otpauth URI", async () => {
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /set up/i }));

    await waitFor(() => expect(enrollTotp).toHaveBeenCalledTimes(1));
    const qr = await screen.findByAltText(/qr code/i);
    expect(qr).toHaveAttribute("src", "data:image/png;base64,QQ==");
    // The otpauth secret is offered for manual entry.
    expect(screen.getByText(/ABC/)).toBeInTheDocument();
  });

  it("enroll → entering a code and verifying reveals the one-time recovery codes", async () => {
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /set up/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /set up/i }));
    await screen.findByAltText(/qr code/i);

    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

    expect(await screen.findByText(/didn't match/i)).toBeInTheDocument();
    // Still on the enroll phase — recovery codes not shown.
    expect(screen.queryByText(/aaaa-1111/)).not.toBeInTheDocument();
  });

  it("confirming the saved codes calls onComplete", async () => {
    const onComplete = vi.fn();
    render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /set up/i }));
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

  it("Skip for now on the intro calls onSkip without enrolling", () => {
    const onSkip = vi.fn();
    render(<TwoFactorStep onComplete={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(enrollTotp).not.toHaveBeenCalled();
  });
});
