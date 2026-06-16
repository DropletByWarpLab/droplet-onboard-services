/**
 * WARP-460 front-end — the "Context" popover that finally surfaces the
 * per-session pins the orchestrator has injected into every turn since
 * Phase B3. List / add / remove against /api/llm/:sessionId/pins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockListContextPins = vi.fn();
const mockCreateContextPin = vi.fn();
const mockDeleteContextPin = vi.fn();
vi.mock("@/lib/api", () => ({
  listContextPins: (...a: unknown[]) => mockListContextPins(...a),
  createContextPin: (...a: unknown[]) => mockCreateContextPin(...a),
  deleteContextPin: (...a: unknown[]) => mockDeleteContextPin(...a),
}));

import { ContextPinsPopover } from "@/components/chat/ContextPinsPopover";

const PIN = {
  id: "pin-1",
  sessionId: "conv-1",
  kind: "folder" as const,
  ref: "/share/logistics",
  meta: null,
  addedAt: "2026-06-09T10:00:00.000Z",
};

beforeEach(() => {
  mockListContextPins.mockReset();
  mockCreateContextPin.mockReset();
  mockDeleteContextPin.mockReset();
  mockListContextPins.mockResolvedValue({ pins: [PIN] });
});

describe("ContextPinsPopover", () => {
  it("loads and lists the session's pins when opened", async () => {
    render(<ContextPinsPopover sessionId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /context/i }));

    await waitFor(() => {
      expect(screen.getByText("/share/logistics")).toBeInTheDocument();
    });
    expect(mockListContextPins).toHaveBeenCalledWith("conv-1");
  });

  it("adds a pin and shows it in the list", async () => {
    mockCreateContextPin.mockResolvedValueOnce({
      pin: { ...PIN, id: "pin-2", kind: "file", ref: "/docs/spec.pdf" },
    });
    render(<ContextPinsPopover sessionId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /context/i }));
    await waitFor(() => screen.getByText("/share/logistics"));

    fireEvent.change(screen.getByLabelText(/kind/i), {
      target: { value: "file" },
    });
    fireEvent.change(screen.getByLabelText(/path or reference/i), {
      target: { value: "/docs/spec.pdf" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => {
      expect(screen.getByText("/docs/spec.pdf")).toBeInTheDocument();
    });
    expect(mockCreateContextPin).toHaveBeenCalledWith("conv-1", {
      kind: "file",
      ref: "/docs/spec.pdf",
    });
  });

  it("removes a pin", async () => {
    mockDeleteContextPin.mockResolvedValueOnce(undefined);
    render(<ContextPinsPopover sessionId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /context/i }));
    await waitFor(() => screen.getByText("/share/logistics"));

    fireEvent.click(
      screen.getByRole("button", { name: /remove \/share\/logistics/i }),
    );
    await waitFor(() => {
      expect(screen.queryByText("/share/logistics")).not.toBeInTheDocument();
    });
    expect(mockDeleteContextPin).toHaveBeenCalledWith("conv-1", "pin-1");
  });

  it("shows an empty-state hint when the session has no pins", async () => {
    mockListContextPins.mockResolvedValue({ pins: [] });
    render(<ContextPinsPopover sessionId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /context/i }));

    await waitFor(() => {
      expect(screen.getByText(/no pinned context/i)).toBeInTheDocument();
    });
  });
});
