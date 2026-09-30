/** WARP-3264 — the owner-only "Look up places online" switch. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchPlaceLookupChannel = vi.fn();
const setPlaceLookupChannel = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchPlaceLookupChannel: (...a: unknown[]) => fetchPlaceLookupChannel(...a),
  setPlaceLookupChannel: (...a: unknown[]) => setPlaceLookupChannel(...a),
}));
let mockRole = "owner";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: mockRole } }) }));

import { PlaceLookupSwitch, PLACE_LOOKUP_LABEL } from "./PlaceLookupSwitch";

beforeEach(() => {
  vi.clearAllMocks();
  fetchPlaceLookupChannel.mockResolvedValue({ enabled: false });
  setPlaceLookupChannel.mockResolvedValue(undefined);
});

describe("PlaceLookupSwitch", () => {
  it("owner sees it off by default and can turn it on", async () => {
    mockRole = "owner";
    render(<PlaceLookupSwitch />);
    const box = (await screen.findByLabelText(new RegExp(PLACE_LOOKUP_LABEL.slice(0, 20)))) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setPlaceLookupChannel).toHaveBeenCalledWith(true));
  });

  it("admin sees the state but can't change it", async () => {
    mockRole = "admin";
    render(<PlaceLookupSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Only the owner can change this.")).toBeTruthy();
  });

  it("owner sees a disabled row, not nothing, when the setting can't be read", async () => {
    mockRole = "owner";
    fetchPlaceLookupChannel.mockResolvedValue(null);
    render(<PlaceLookupSwitch />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Couldn’t read this setting/)).toBeTruthy();
  });

  it("owner caption follows the switch state", async () => {
    mockRole = "owner";
    fetchPlaceLookupChannel.mockResolvedValue({ enabled: true });
    render(<PlaceLookupSwitch />);
    expect(await screen.findByText(/^On: /)).toBeTruthy();
  });

  it("members render nothing and never read the channel", () => {
    mockRole = "family";
    const { container } = render(<PlaceLookupSwitch />);
    expect(container.innerHTML).toBe("");
    expect(fetchPlaceLookupChannel).not.toHaveBeenCalled();
  });
});
