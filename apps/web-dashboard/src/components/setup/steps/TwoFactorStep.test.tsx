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
import { SetupNavProvider } from "@/components/setup/setup-nav";

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

  // ── WARP-991 — the step may advance ONLY on a confirmed verify ──
  // Live evidence (.87): the 2-step screen advanced while the DB kept
  // TotpCredential.confirmedAt = NULL — the owner believed 2FA was on and
  // login skipped the challenge. Every non-confirming outcome must keep the
  // owner on this step with an inline error.
  describe("advance is gated on a confirmed verify (WARP-991)", () => {
    it("a failed verify (500) shows an inline error and never advances — onComplete not called", async () => {
      verifyTotp.mockRejectedValueOnce(
        Object.assign(new Error("Internal error"), { status: 500 }),
      );
      const onComplete = vi.fn();
      render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);
      await screen.findByAltText(/qr code/i);

      fireEvent.change(screen.getByLabelText(/6-digit code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

      expect(await screen.findByText(/didn't match/i)).toBeInTheDocument();
      // Still on the enroll phase — no codes screen, no advancement.
      expect(screen.queryByText(/save your recovery codes/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("a 2xx without enabled:true stays here with an inline error", async () => {
      verifyTotp.mockResolvedValueOnce({ enabled: false });
      const onComplete = vi.fn();
      render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);
      await screen.findByAltText(/qr code/i);

      fireEvent.change(screen.getByLabelText(/6-digit code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

      expect(
        await screen.findByText(/couldn't turn on two-factor/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/save your recovery codes/i)).not.toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("a confirmed 200 WITHOUT recovery codes (re-challenge contract: factor already on) shows the honest 'already on' screen, not an empty codes card", async () => {
      verifyTotp.mockResolvedValueOnce({ enabled: true });
      const onComplete = vi.fn();
      render(<TwoFactorStep onComplete={onComplete} onSkip={vi.fn()} />);
      await screen.findByAltText(/qr code/i);

      fireEvent.change(screen.getByLabelText(/6-digit code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));

      expect(
        await screen.findByText(/two-factor is already on/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/save your recovery codes/i)).not.toBeInTheDocument();
      // Advancing stays an explicit act.
      expect(onComplete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("Enter while a verify is in flight does not fire a second, concurrent verify", async () => {
      let resolveVerify!: (v: unknown) => void;
      verifyTotp.mockImplementationOnce(
        () => new Promise((resolve) => (resolveVerify = resolve)),
      );
      render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
      await screen.findByAltText(/qr code/i);

      const input = screen.getByLabelText(/6-digit code/i);
      fireEvent.change(input, { target: { value: "123456" } });
      // The footer button disables while busy, but the input's Enter key
      // is not gated by it — the re-entrancy guard must hold there too.
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(verifyTotp).toHaveBeenCalledTimes(1);

      resolveVerify({ enabled: true, recoveryCodes: ["aaaa-1111"] });
      expect(await screen.findByText("aaaa-1111")).toBeInTheDocument();
    });
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

  // The disabled "I've saved them — continue" button must TELL the user why
  // it's gated. The explanation reaches assistive tech through the CHECKBOX's
  // description (the actionable gate) plus a polite live region — never through
  // the disabled button, whose aria-describedby some screen readers suppress.
  describe("recovery-codes continue is gated WITH feedback", () => {
    async function toCodesPhase() {
      render(<TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />);
      await screen.findByAltText(/qr code/i);
      fireEvent.change(screen.getByLabelText(/6-digit code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));
      const continueBtn = await screen.findByRole("button", {
        name: /saved them — continue/i,
      });
      const checkbox = screen.getByRole("checkbox");
      return { continueBtn, checkbox };
    }

    it("shows visible helper text telling the user to tick the checkbox to continue", async () => {
      await toCodesPhase();
      const hint = screen.getByText(/tick the box.*continue/i);
      expect(hint).toBeInTheDocument();
    });

    it("ties the explanatory hint to the CHECKBOX (the actionable gate), not the disabled button", async () => {
      const { continueBtn, checkbox } = await toCodesPhase();
      expect(continueBtn).toBeDisabled();

      // The gate explanation is reachable from the checkbox…
      const describedBy = checkbox.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const hint = document.getElementById(describedBy!);
      expect(hint).not.toBeNull();
      expect(hint).toBeInTheDocument();
      expect(hint!.textContent ?? "").toMatch(/box|saved/i);

      // …and NOT duplicated onto the disabled button (VoiceOver suppresses
      // descriptions on disabled controls, and the double-read is noise).
      expect(continueBtn).not.toHaveAttribute("aria-describedby");
    });

    it("announces via a polite live region that Continue is active once the box is ticked (WCAG 4.1.3)", async () => {
      const { checkbox } = await toCodesPhase();

      const live = screen.getByRole("status");
      expect(live).toHaveAttribute("aria-live", "polite");
      // Before ticking, the live region carries the imperative, not a false
      // "you're done".
      expect(live.textContent ?? "").not.toMatch(/now active|now continue/i);

      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(live.textContent ?? "").toMatch(/continue.*(active|now)/i),
      );
    });

    it("updates the hint text to a completed state once ticked — no stale imperative read as fact", async () => {
      const { checkbox } = await toCodesPhase();

      // The hint element is the one the checkbox describes.
      const hintId = checkbox.getAttribute("aria-describedby")!;
      const hint = document.getElementById(hintId)!;
      expect(hint.textContent ?? "").toMatch(/tick the box.*continue/i);

      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(screen.queryByText(/tick the box.*continue/i)).toBeNull(),
      );
      // The same hint element now confirms the saved state rather than telling
      // an already-done user to go do it.
      expect(hint.textContent ?? "").toMatch(/saved/i);
      expect(hint.textContent ?? "").not.toMatch(/tick the box/i);
    });

    it("keeps the checkbox description out of the way once ticked (no stale hint on the now-confirmed control)", async () => {
      const { checkbox } = await toCodesPhase();
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(checkbox).not.toHaveAttribute("aria-describedby"),
      );
    });
  });

  it("hides Back AND rail jumps on the one-time recovery-codes phase, even with the nav provider present (WARP-929 T4)", async () => {
    // With the provider, twofactor (idx 4 > the org floor at 3) would normally
    // show Back / clickable rail rows. The codes phase passes hideBack, so the
    // confirmed "I've saved them — continue" must be the ONLY way off — going
    // back from the one-time codes is what stranded the owner with no codes.
    render(
      <SetupNavProvider
        value={{
          navigate: vi.fn(),
          maxReachedIdx: 13,
          back: vi.fn(),
          firstNavigableIdx: 3,
        }}
      >
        <TwoFactorStep onComplete={vi.fn()} onSkip={vi.fn()} />
      </SetupNavProvider>,
    );
    // Reach the QR whether enrollment is on-mount (WARP-931 auto-enroll) or
    // behind an intro "Set up" button — keeps this T4 assertion valid however
    // the 2FA-UX work merges.
    const setUp = screen.queryByRole("button", { name: /set up/i });
    if (setUp) fireEvent.click(setUp);
    await screen.findByAltText(/qr code/i);
    fireEvent.change(screen.getByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verify & enable/i }));
    await screen.findByText("aaaa-1111"); // we're on the codes phase

    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Go to / })).toBeNull();
  });
});
