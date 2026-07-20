/**
 * MatterQrScanner — smoke tests for the QR scanner component.
 *
 * What we test in jsdom:
 *   - idle UI renders + start-camera button is visible
 *   - manual code entry calls onResult with the normalised string
 *     (hyphens stripped, leading/trailing whitespace trimmed)
 *   - Commission button disables when input empty / props.disabled
 *   - Enter key in the input submits like the button click
 *
 * What we DON'T test here (jsdom limitations):
 *   - Live camera stream (needs real getUserMedia, which jsdom lacks).
 *     The decode-loop integration is covered by an E2E test under
 *     apps/web-dashboard/src/__tests__/e2e/ if one gets added.
 *   - Actual @zxing/library decode — same reason; jsdom's HTMLVideoElement
 *     stub doesn't render frames.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MatterQrScanner } from "@/components/smart-home/MatterQrScanner";

// @zxing imports a binary decode core that jsdom can't run.
// BrowserMultiFormatReader lives in @zxing/browser; NotFoundException
// stays in @zxing/library. Mock both at module level.
vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: class {
    reset = vi.fn();
    decodeFromVideoElement = vi.fn();
  },
}));
vi.mock("@zxing/library", () => ({
  NotFoundException: class extends Error {},
}));

describe("MatterQrScanner — idle state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leads with the pairing code and offers the camera as the secondary path", () => {
    render(<MatterQrScanner onResult={vi.fn()} />);
    // WARP-1411: the pairing code is the primary path — it is the only one
    // that works on a machine with no camera, so it must render up front
    // rather than below an aspect-square viewport.
    expect(screen.getByLabelText(/enter the pairing code/i)).toBeInTheDocument();
    // The camera is opt-in behind a CTA; no viewport is reserved while idle.
    expect(
      screen.getByRole("button", { name: /scan the qr code instead/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/qr code camera viewport/i),
    ).not.toBeInTheDocument();
  });

  it("always renders the manual-entry input below the viewport", () => {
    render(<MatterQrScanner onResult={vi.fn()} />);
    expect(screen.getByLabelText(/enter the pairing code/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /commission/i }),
    ).toBeInTheDocument();
  });

  it("disables Commission until the input has content", () => {
    render(<MatterQrScanner onResult={vi.fn()} />);
    expect(screen.getByRole("button", { name: /commission/i })).toBeDisabled();
  });
});

describe("MatterQrScanner — manual entry submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onResult with the raw code when the user clicks Commission", () => {
    const onResult = vi.fn();
    render(<MatterQrScanner onResult={onResult} />);
    fireEvent.change(screen.getByLabelText(/enter the pairing code/i), {
      target: { value: "34970112332" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("34970112332");
  });

  it("strips hyphens from the pretty-printed long form", () => {
    // 21-digit Matter manual code with the typical 4-4-4-4-5 grouping.
    const onResult = vi.fn();
    render(<MatterQrScanner onResult={onResult} />);
    fireEvent.change(screen.getByLabelText(/enter the pairing code/i), {
      target: { value: "3497-0112-3320-1234-56789" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    expect(onResult).toHaveBeenCalledWith("349701123320123456789");
  });

  it("trims surrounding whitespace before submit", () => {
    const onResult = vi.fn();
    render(<MatterQrScanner onResult={onResult} />);
    fireEvent.change(screen.getByLabelText(/enter the pairing code/i), {
      target: { value: "   34970112332   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    expect(onResult).toHaveBeenCalledWith("34970112332");
  });

  it("submits on Enter just like clicking Commission", () => {
    const onResult = vi.fn();
    render(<MatterQrScanner onResult={onResult} />);
    const input = screen.getByLabelText(/enter the pairing code/i);
    fireEvent.change(input, { target: { value: "34970112332" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onResult).toHaveBeenCalledWith("34970112332");
  });

  it("does not call onResult when the input is empty", () => {
    const onResult = vi.fn();
    render(<MatterQrScanner onResult={onResult} />);
    const input = screen.getByLabelText(/enter the pairing code/i);
    // Press Enter without typing — should be a no-op.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("MatterQrScanner — disabled state (parent commissioning in flight)", () => {
  it("disables both buttons when props.disabled is true", () => {
    render(
      <MatterQrScanner onResult={vi.fn()} disabled />,
    );
    expect(
      screen.getByRole("button", { name: /scan the qr code instead/i }),
    ).toBeDisabled();
    // Commission button stays disabled regardless of input value
    const input = screen.getByLabelText(/enter the pairing code/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "34970112332" } });
    expect(screen.getByRole("button", { name: /commission/i })).toBeDisabled();
    // Input itself also disabled to prevent typing during pending submit
    expect(input).toBeDisabled();
  });
});
