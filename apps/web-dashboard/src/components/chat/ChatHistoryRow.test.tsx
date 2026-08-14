import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatHistoryRow } from "./ChatHistoryRow";

const baseProps = {
  id: "abc",
  title: "Frigate ports",
  active: false,
  pinned: false,
  onSelect: vi.fn(),
  onRenameSubmit: vi.fn().mockResolvedValue(undefined),
  onDeleteRequest: vi.fn(),
  onExport: vi.fn(),
  onMoveRequest: vi.fn(),
  onTogglePin: vi.fn(),
};

describe("ChatHistoryRow", () => {
  it("renders the title", () => {
    render(<ChatHistoryRow {...baseProps} />);
    expect(screen.getByText("Frigate ports")).toBeInTheDocument();
  });

  it("falls back to 'Untitled chat' when title is null", () => {
    render(<ChatHistoryRow {...baseProps} title={null} />);
    expect(screen.getByText("Untitled chat")).toBeInTheDocument();
  });

  it("fires onSelect when the row is clicked", () => {
    const onSelect = vi.fn();
    render(<ChatHistoryRow {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /open chat/i }));
    expect(onSelect).toHaveBeenCalled();
  });

  it("fires onMoveRequest when 'Move to project' is chosen (WARP-845)", () => {
    const onMoveRequest = vi.fn();
    render(<ChatHistoryRow {...baseProps} onMoveRequest={onMoveRequest} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /move to project/i }));
    expect(onMoveRequest).toHaveBeenCalled();
  });

  it("fires onExport (and closes the menu) when Export is chosen", () => {
    const onExport = vi.fn();
    render(<ChatHistoryRow {...baseProps} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    expect(onExport).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // ── WARP-1917: pin / unpin from the overflow menu ──

  it("offers Pin for an unpinned chat and fires onTogglePin (closing the menu)", () => {
    const onTogglePin = vi.fn();
    render(<ChatHistoryRow {...baseProps} onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.queryByRole("menuitem", { name: /unpin/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /^pin$/i }));
    expect(onTogglePin).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers Unpin for a pinned chat", () => {
    const onTogglePin = vi.fn();
    render(<ChatHistoryRow {...baseProps} pinned onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.queryByRole("menuitem", { name: /^pin$/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /unpin/i }));
    expect(onTogglePin).toHaveBeenCalled();
  });

  it("opens inline rename when the Rename menu item is chosen", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(screen.getByRole("textbox", { name: /chat title/i })).toBeInTheDocument();
  });

  it("submits rename on Enter and calls onRenameSubmit with the trimmed value", async () => {
    const onRenameSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ChatHistoryRow {...baseProps} onRenameSubmit={onRenameSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = screen.getByRole("textbox", { name: /chat title/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameSubmit).toHaveBeenCalledWith("New title");
  });

  it("cancels rename on Escape and restores the original title", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = screen.getByRole("textbox", { name: /chat title/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Frigate ports")).toBeInTheDocument();
  });

  it("calls onDeleteRequest when Delete menu item is chosen", () => {
    const onDeleteRequest = vi.fn();
    render(<ChatHistoryRow {...baseProps} onDeleteRequest={onDeleteRequest} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(onDeleteRequest).toHaveBeenCalled();
  });

  it("applies the active highlight when active=true", () => {
    render(<ChatHistoryRow {...baseProps} active />);
    expect(screen.getByRole("button", { name: /open chat/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("forwards id as data-chat-id on the row container", () => {
    const { container } = render(<ChatHistoryRow {...baseProps} />);
    expect(container.querySelector('[data-chat-id="abc"]')).not.toBeNull();
  });

  it("closes the menu on Escape", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on mousedown outside the row's actions", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the menu open on mousedown inside it (click must still land)", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: /export/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("raises the row above sibling rows while the menu is open", () => {
    // Regression: .conv-acts' transform traps the menu's z-10 in its own
    // stacking context, so without a z-index on the open row, later sibling
    // .conv-row elements paint (and hit-test) above the menu — options were
    // unclickable and the popover looked broken/disappeared.
    const { container } = render(<ChatHistoryRow {...baseProps} />);
    const row = container.querySelector('[data-chat-id="abc"]') as HTMLElement;
    expect(row.className).not.toMatch(/\bz-20\b/);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(row.className).toMatch(/\bz-20\b/);
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    expect(row.className).not.toMatch(/\bz-20\b/);
  });
});
