import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarSources: () => ({ sources: [], refresh: mocks.refresh, isLoading: false }),
  usePublishLinkStatus: () => ({ status: null, refresh: vi.fn() }),
  createSource: mocks.create, deleteSource: vi.fn(), syncSource: vi.fn(), rotatePublishLink: vi.fn(), revokePublishLink: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
import { SubscriptionsPanel } from "./SubscriptionsPanel";

beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ source: { id: "saved-source" } }); });

describe("calendar setup result callback", () => {
  function fill() {
    fireEvent.click(screen.getByRole("button", { name: "Add calendar feed" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Private calendar name" } });
    fireEvent.change(screen.getByLabelText(/Calendar URL/), { target: { value: "https://private.invalid/secret-share-link" } });
  }
  it("reports only a successful source creation without passing typed details", async () => {
    const onConnected = vi.fn();
    render(<SubscriptionsPanel onConnected={onConnected} />);
    expect(onConnected).not.toHaveBeenCalled();
    fill();
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add subscription" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected.mock.calls).toEqual([[]]);
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it("does not report an unsuccessful source creation", async () => {
    const onConnected = vi.fn();
    mocks.create.mockRejectedValue(new Error("source rejected"));
    render(<SubscriptionsPanel onConnected={onConnected} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Add subscription" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(onConnected).not.toHaveBeenCalled();
  });
});
