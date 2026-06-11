/**
 * Onboarding-Flow redesign §4 — the persistent help launcher (FAB → popover
 * menu → slide-in panel). Verifies the launcher opens, routes its menu items to
 * real surfaces (/help, /chat), opens the panel, searches the real in-repo help
 * index, deep-links a result to /help#<id>, and that "?" / Esc drive it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HelpLauncher } from "./HelpLauncher";

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
