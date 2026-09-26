/**
 * Onboarding-Flow redesign §4 — the persistent help launcher (FAB → popover
 * menu → slide-in panel). Verifies the launcher opens, routes its menu items to
 * real surfaces (/help, /chat), opens the panel, searches the real in-repo help
 * index, deep-links a result to /help#<id>, and that "?" / Esc drive it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { HelpLauncher } from "./HelpLauncher";
import { helpSlot } from "@/components/shell/dom-slots";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

beforeEach(() => {
  pushMock.mockReset();
});

describe("HelpLauncher", () => {
  it("opens the launcher menu from the FAB and routes Browse / Ask AI to real surfaces", () => {
    render(<HelpLauncher />);
    fireEvent.click(screen.getByRole("button", { name: /open help/i }));

    expect(screen.getByText(/how can we help/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /browse all help/i }));
    expect(pushMock).toHaveBeenCalledWith("/help");
  });

  it("routes Ask Droplet AI to chat", () => {
    render(<HelpLauncher />);
    fireEvent.click(screen.getByRole("button", { name: /open help/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /ask droplet ai/i }));
    expect(pushMock).toHaveBeenCalledWith("/chat");
  });

  it("opens the slide-in panel and deep-links a searched topic to /help#<id>", () => {
    render(<HelpLauncher />);
    fireEvent.click(screen.getByRole("button", { name: /open help/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /search help/i }));

    const panel = screen.getByRole("dialog", { name: /help and support/i });
    expect(panel).toBeInTheDocument();
    // Empty query → popular topics from the real HELP_INDEX.
    expect(screen.getByText(/popular topics/i)).toBeInTheDocument();

    // Search the real index — "vpn" ranks the Remote Access article.
    fireEvent.change(screen.getByRole("textbox", { name: /search help articles/i }), {
      target: { value: "vpn" },
    });
    const result = screen.getByRole("button", {
      name: /remote access \(wireguard vpn\)/i,
    });
    fireEvent.click(result);
    expect(pushMock).toHaveBeenCalledWith("/help#vpn");
  });

  it("toggles via the ? shortcut and closes on Escape", () => {
    render(<HelpLauncher />);
    // Not open yet.
    expect(screen.queryByText(/how can we help/i)).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "?" });
    expect(screen.getByText(/how can we help/i)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(/how can we help/i)).not.toBeInTheDocument();
  });
});

// ── WARP-3043: a page header can host the trigger ──
//
// On /chat and the Workshop the floating button covered the docked
// composer's send button. Those pages offer `helpSlot` in their header; the
// launcher portals its trigger there and opens its menu under it. Every
// other page keeps the floating button.
function HeaderSlot() {
  const register = helpSlot.useRegister();
  return (
    <header data-testid="page-head">
      <span ref={register} className="help-slot" data-testid="slot" />
    </header>
  );
}

function Page({ withSlot }: { withSlot: boolean }) {
  return (
    <>
      {withSlot && <HeaderSlot />}
      <HelpLauncher />
    </>
  );
}

describe("HelpLauncher — the header slot (WARP-3043)", () => {
  afterEach(() => cleanup());

  it("renders its trigger inside a registered slot, not as the floating button", () => {
    render(<Page withSlot />);
    const buttons = screen.getAllByRole("button", { name: "Open help" });
    expect(buttons).toHaveLength(1);
    const trigger = buttons[0];
    expect(screen.getByTestId("slot").contains(trigger)).toBe(true);
    expect(trigger.className).not.toMatch(/(^|\s)fixed(\s|$)/);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the menu under the header trigger, placed from the trigger's box", () => {
    render(<Page withSlot />);
    const trigger = within(screen.getByTestId("slot")).getByRole("button", { name: "Open help" });
    trigger.getBoundingClientRect = () =>
      ({ top: 12, bottom: 48, left: 964, right: 1000, width: 36, height: 36, x: 964, y: 12, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Help" });
    expect(menu.style.top).toBe("56px");
    expect(menu.style.right).toBe(`${window.innerWidth - 1000}px`);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAccessibleName("Close help");
    // The menu stays in the launcher's own tree, not in the header.
    expect(screen.getByTestId("page-head").contains(menu)).toBe(false);
  });

  it("a press on the header trigger while the menu is open closes it", () => {
    render(<Page withSlot />);
    const trigger = within(screen.getByTestId("slot")).getByRole("button", { name: "Open help" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Help" })).toBeInTheDocument();
    // The outside-click listener must count the portaled trigger as inside.
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu", { name: "Help" })).toBeNull();
  });

  it("? still toggles the menu with the trigger in the slot", () => {
    render(<Page withSlot />);
    fireEvent.keyDown(document, { key: "?" });
    expect(screen.getByRole("menu", { name: "Help" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "?" });
    expect(screen.queryByRole("menu", { name: "Help" })).toBeNull();
  });

  it("the floating button comes back when the slot unregisters", () => {
    const { rerender } = render(<Page withSlot />);
    expect(screen.getByTestId("slot").contains(screen.getByRole("button", { name: "Open help" }))).toBe(true);
    rerender(<Page withSlot={false} />);
    const trigger = screen.getByRole("button", { name: "Open help" });
    expect(trigger.className).toMatch(/(^|\s)fixed(\s|$)/);
  });

  it("carries no trust copy in the menu or the panel", () => {
    render(<Page withSlot={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open help" }));
    expect(document.body.textContent).not.toMatch(/stays on your Droplet/i);
    fireEvent.click(screen.getByRole("menuitem", { name: /search help/i }));
    expect(screen.getByRole("dialog", { name: /help and support/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/stays on your Droplet/i);
  });
});
