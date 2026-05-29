/**
 * WARP-289: assert PairDialog renders with full modal ARIA via the
 * shared <Dialog> primitive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  createPairingCode: vi.fn(),
  getPairingCodeStatus: vi.fn(),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="pair-qr" data-value={value} />
  ),
}));

import { PairDialog } from "@/components/PairDialog";

describe("<PairDialog> ARIA", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("has role=dialog + aria-modal=true + aria-labelledby resolving to the heading", () => {
    render(<PairDialog onClose={() => {}} onPaired={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/Pair a new device/i);
  });
});
