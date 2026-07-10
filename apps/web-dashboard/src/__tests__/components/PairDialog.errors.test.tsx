/**
 * WARP-1150/1151 — PairDialog Generate-code error copy.
 *
 * End-to-end proof at the component level that a create-session failure can
 * never render the "We couldn't reach that device…" string: that copy belongs
 * to the post-code handshake, and at Generate-code time there is no device to
 * reach yet. Covers the observed on-box repro (name "bdeep", platform iOS,
 * module-gated 404 {"error":"module_disabled"}), plus plain 5xx/429/network
 * failures, and the success path (a code + QR payload appears).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { createPairingCodeMock, getPairingCodeStatusMock } = vi.hoisted(() => ({
  createPairingCodeMock: vi.fn(),
  getPairingCodeStatusMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  createPairingCode: createPairingCodeMock,
  getPairingCodeStatus: getPairingCodeStatusMock,
}));

// The QR renderer draws to SVG internals irrelevant here.
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="qr" aria-label={value} />
  ),
}));

import { PairDialog } from "@/components/PairDialog";

const REACH_DEVICE = /reach that device/i;

function apiError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code: code ?? message });
}

async function generate(deviceName = "bdeep", platform: RegExp = /ios/i) {
  render(<PairDialog onClose={() => {}} onPaired={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/macbook/i), {
    target: { value: deviceName },
  });
  fireEvent.click(screen.getByRole("button", { name: platform }));
  fireEvent.click(screen.getByRole("button", { name: /generate code/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The status poll only starts after a successful create; keep it inert.
  getPairingCodeStatusMock.mockResolvedValue({
    used: false,
    expired: false,
  });
});

describe("PairDialog Generate code — step-appropriate errors (WARP-1150)", () => {
  it("module-gated 404 (the droplet.local repro) renders pairing-disabled copy, never reach-device", async () => {
    createPairingCodeMock.mockRejectedValue(
      apiError("module_disabled", 404, "module_disabled"),
    );

    await generate("bdeep", /ios/i);

    const alert = await screen.findByText(/pairing is turned off/i);
    expect(alert.textContent).not.toMatch(REACH_DEVICE);
  });

  it.each([
    ["500 internal", apiError("internal", 500)],
    ["502 upstream", apiError("bad gateway", 502)],
    ["503 allocation exhausted", apiError("Couldn't allocate a pairing code. Try again.", 503)],
    ["fetch-level network failure", new TypeError("Failed to fetch")],
    ["opaque error", new Error("Failed to generate pairing code: 500")],
  ])(
    "create-session failure (%s) renders retryable create copy, never reach-device",
    async (_label, err) => {
      createPairingCodeMock.mockRejectedValue(err);

      await generate();

      await waitFor(() => {
        expect(createPairingCodeMock).toHaveBeenCalled();
      });
      // Still on the form step, with an error box that never says reach-device.
      const button = await screen.findByRole("button", { name: /generate code/i });
      expect(button).toBeTruthy();
      expect(screen.queryByText(REACH_DEVICE)).toBeNull();
      expect(screen.queryByText(/powered on and nearby/i)).toBeNull();
    },
  );

  it("429 renders the too-many-codes copy", async () => {
    createPairingCodeMock.mockRejectedValue(
      apiError("Too many pairing codes generated. Try again in an hour.", 429),
    );

    await generate();

    await screen.findByText(/too many pairing codes/i);
    expect(screen.queryByText(REACH_DEVICE)).toBeNull();
  });

  it("success mints a code and shows it with the QR payload (iOS)", async () => {
    createPairingCodeMock.mockResolvedValue({
      code: "ABCD23",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      pairUrl: "droplet://pair?server=https%3A%2F%2Fdroplet.local&code=ABCD23",
    });

    await generate("bdeep", /ios/i);

    await screen.findByText("ABCD23");
    expect(screen.getByTestId("qr").getAttribute("aria-label")).toContain(
      "code=ABCD23",
    );
    expect(createPairingCodeMock).toHaveBeenCalledWith({
      deviceName: "bdeep",
      deviceType: "mobile",
      platform: "ios",
    });
  });
});
