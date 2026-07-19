/**
 * WARP-1411 — the add-device screen's shape.
 *
 * The camera viewport used to be an `aspect-square` box rendered
 * unconditionally. In a `max-w-2xl` column that reserved ~670px of empty
 * black before the camera ever started, which pushed the pairing-code
 * field — the only path that works on a machine with no camera — below
 * the fold. These pin the shape, not the styling:
 *
 *   - at rest there is NO camera viewport reserved;
 *   - the pairing-code field is present at rest;
 *   - the camera is reachable as a secondary action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MatterQrScanner } from "../MatterQrScanner";

const onResult = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MatterQrScanner layout (WARP-1411)", () => {
  it("reserves no camera viewport at rest", () => {
    render(<MatterQrScanner onResult={onResult} />);
    expect(
      screen.queryByLabelText("QR code camera viewport"),
    ).not.toBeInTheDocument();
  });

  it("shows the pairing-code field at rest, without opening the camera", () => {
    render(<MatterQrScanner onResult={onResult} />);
    expect(screen.getByLabelText(/enter the pairing code/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /commission/i }),
    ).toBeInTheDocument();
  });

  it("offers the camera as a secondary action", () => {
    render(<MatterQrScanner onResult={onResult} />);
    expect(
      screen.getByRole("button", { name: /scan the qr code instead/i }),
    ).toBeInTheDocument();
  });

  it("rejects a malformed pairing code without calling onResult", () => {
    render(<MatterQrScanner onResult={onResult} />);
    // 5 digits — neither the 11- nor the 21-digit form.
    fireEvent.change(screen.getByLabelText(/enter the pairing code/i), {
      target: { value: "12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: /commission/i }));
    expect(onResult).not.toHaveBeenCalled();
    // The validation hint is what tells the user why nothing happened —
    // it renders in the same slot the (previously invisible) insecure-origin
    // message uses.
    expect(screen.getByRole("status")).toHaveTextContent(/11 or 21 digits/i);
  });
});
