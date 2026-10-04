/**
 * WARP-3414 — the key fingerprint block: the full 16 groups, four to a line,
 * exactly the box's string (no truncation, no re-casing), and a Copy action
 * that puts the one-line grouped form on the clipboard.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { KeyFingerprint, fingerprintLines } from "./KeyFingerprint";

const FP = "F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B 8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C";

describe("fingerprintLines", () => {
  it("breaks 16 groups into four lines of four, losing nothing", () => {
    const lines = fingerprintLines(FP);
    expect(lines).toHaveLength(4);
    expect(lines.join(" ")).toBe(FP);
  });
});

describe("<KeyFingerprint />", () => {
  it("copies the full grouped fingerprint", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<KeyFingerprint fingerprint={FP} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy key fingerprint" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FP));
  });
});
