import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { fetchMock, setMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), setMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ fetchWebPushChannel: fetchMock, setWebPushChannel: setMock }));

import { PushDeliveryChannel } from "@/components/notifications/PushDeliveryChannel";

// WARP-2904 — the box-wide `web_push` off-LAN switch.
describe("PushDeliveryChannel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setMock.mockReset();
  });

  it("says who runs the push service and that the text is encrypted", async () => {
    fetchMock.mockResolvedValue({ enabled: false });
    render(<PushDeliveryChannel />);
    expect(await screen.findByText(/Push delivery is off/)).toBeInTheDocument();
    expect(screen.getByText(/Google, Apple or\s+Mozilla/)).toBeInTheDocument();
    expect(screen.getByText(/encrypted to your\s+device/)).toBeInTheDocument();
  });

  it("turns the channel on", async () => {
    fetchMock.mockResolvedValue({ enabled: false });
    setMock.mockResolvedValue(undefined);
    render(<PushDeliveryChannel />);
    fireEvent.click(await screen.findByRole("button", { name: /turn on/i }));
    await waitFor(() => expect(screen.getByText(/Push delivery is on/)).toBeInTheDocument());
    expect(setMock).toHaveBeenCalledWith(true);
  });

  it("a member's 403 reads as who can, and the state does not flip", async () => {
    fetchMock.mockResolvedValue({ enabled: false });
    setMock.mockRejectedValue(Object.assign(new Error("x"), { status: 403 }));
    render(<PushDeliveryChannel />);
    fireEvent.click(await screen.findByRole("button", { name: /turn on/i }));
    expect(await screen.findByText(/Only an owner or admin/)).toBeInTheDocument();
    expect(screen.getByText(/Push delivery is off/)).toBeInTheDocument();
  });

  it("an unreadable channel is said, not guessed — and offers no switch", async () => {
    fetchMock.mockResolvedValue(null);
    render(<PushDeliveryChannel />);
    expect(await screen.findByText(/status unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
