/**
 * WARP-301: hit-target audit pass — Jump-to-latest pill sizing.
 *
 * The pill that surfaces when the user scrolls up off the live tail in
 * /chat used to be `px-3 py-1.5 type-caption-1` (~28 px tall). On
 * mobile that's well under the 36-40 px touch-target floor flagged by
 * the audit. Bumped to `px-4 py-2.5` so it clears that bar while
 * keeping the same accent-pill visual language.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

// Mock the chat-side hooks so the page renders without an actual
// orchestrator behind it. The pill is the only assertion target — we
// don't drive the streaming loop.
vi.mock("@/lib/hooks/useChat", () => ({
  useChat: () => ({
    messages: [
      { id: "u-1", role: "user", content: "hi" },
      { id: "a-1", role: "assistant", content: "hello" },
    ],
    isStreaming: false,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    retryMessage: vi.fn(),
    regenerate: vi.fn(),
    clearMessages: vi.fn(),
    attachments: [],
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({ models: [{ id: "m1", provider: "ollama" }] }),
}));

// Force `isDetached: true` so the pill is rendered with full opacity
// + tabIndex=0. The hit-target assertions don't care about visibility,
// only about which Tailwind utilities are on the button.
vi.mock("@/lib/hooks/useStickyScroll", () => ({
  STICKY_PX: 80,
  useStickyScroll: () => ({
    scrollRef: { current: null },
    isDetached: true,
    scrollToBottom: vi.fn(),
    onScroll: vi.fn(),
    stickyScrollToBottom: vi.fn(),
  }),
}));

// SessionHeader does an authFetch; stub it so we don't fight network.
// The page also reads useAuth().user (DASH-04: it gates the chat WS on an
// authenticated user); return a logged-in user so the page renders.
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice" },
  }),
}));

import ChatPage from "@/app/chat/page";

// WARP-3043 — the pill takes the Mac chrome: a glass pill with `--text`
// (the accent fill with white ink read 2.98:1 in dark). Its size and look
// live in chat-indigo.css's `.chat-jump`, so the ≥ 36 px floor is pinned
// there.
const CHAT_CSS = readFileSync(
  path.resolve(__dirname, "../../components/chat/chat-indigo.css"),
  "utf8",
);
function jumpRule(): string {
  const m = /\.droplet-shell \.chat-jump \{([^}]*)\}/.exec(CHAT_CSS);
  expect(m, "no `.droplet-shell .chat-jump` rule").not.toBeNull();
  return m![1];
}

describe("Jump-to-latest pill (WARP-301)", () => {
  it("keeps a ≥ 36 px tall touch target", () => {
    cleanup();
    render(<ChatPage />);
    const pill = screen.getByTestId("jump-to-latest");
    expect(pill.classList.contains("chat-jump")).toBe(true);
    const h = /min-height:\s*(\d+)px/.exec(jumpRule());
    expect(h, "`.chat-jump` sets no min-height").not.toBeNull();
    expect(Number(h![1])).toBeGreaterThanOrEqual(36);
  });

  it("is the glass pill in --text, not the accent fill", () => {
    cleanup();
    render(<ChatPage />);
    const pill = screen.getByTestId("jump-to-latest");
    expect(pill.className).not.toMatch(/bg-accent|text-white|shadow-md/);
    const rule = jumpRule();
    expect(rule).toMatch(/background:\s*var\(--glass\)/);
    expect(rule).toMatch(/color:\s*var\(--text\)/);
    expect(rule).toMatch(/border-radius:\s*999px/);
    expect(rule).not.toMatch(/--lift/);
  });

  it("remains keyboard reachable when detached (tabIndex=0)", () => {
    cleanup();
    render(<ChatPage />);
    const pill = screen.getByTestId("jump-to-latest");
    expect(pill.getAttribute("tabindex")).toBe("0");
    expect(pill.getAttribute("aria-label")).toBe("Jump to latest message");
  });
});
