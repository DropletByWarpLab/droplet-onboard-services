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

    // WARP-3043: a themed menu, not a native select.
    fireEvent.click(screen.getByRole("button", { name: "Kind: folder" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "file" }));
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

  describe("phone layout (WARP-3202)", () => {
    it("anchors to the header below lg: `lg:relative`, never a bare `relative`", async () => {
      render(<ContextPinsPopover sessionId="conv-1" />);
      const trigger = screen.getByRole("button", { name: /context/i });
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: /pinned context/i });

      expect(trigger.parentElement).toHaveClass("lg:relative");
      expect(trigger.parentElement).not.toHaveClass("relative");
      expect(dialog).toHaveClass("right-0", "max-lg:right-3");
    });

    it("keeps the kind picker, the path box and Add in one `.chat-field-row`", async () => {
      render(<ContextPinsPopover sessionId="conv-1" />);
      fireEvent.click(screen.getByRole("button", { name: /context/i }));
      const dialog = await screen.findByRole("dialog", { name: /pinned context/i });

      const ref = screen.getByLabelText(/path or reference/i);
      const kind = screen.getByRole("button", { name: /^Kind:/ });
      const add = screen.getByRole("button", { name: "Add pin" });

      expect(ref).toHaveClass("chat-field");
      expect(dialog.querySelector("select")).toBeNull();
      // `.chat-field-row > button` and `.chat-field-row .pick-select` are what
      // the phone rule raises to 44px.
      const row = ref.closest(".chat-field-row");
      expect(row).not.toBeNull();
      expect(add.parentElement).toBe(row);
      expect(kind).toHaveClass("pick-select");
      expect(row!.contains(kind)).toBe(true);
    });
  });
});
