/**
 * WARP-3043 — Help lives in /chat's header. HelpLauncher (mounted once, by
 * AuthGate, beside the routed page) portals its trigger into the header's
 * slot instead of floating it over the docked composer's send button — so
 * the page shows exactly one Help button, and it sits in `.chat-head`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

type Msg = { id: string; role: "user" | "assistant"; content: string };

const ctl = vi.hoisted(() => ({
  search: "",
  setMessages: null as null | ((m: Msg[]) => void),
  fetchBusinessProfile: vi.fn(),
  user: { id: "u1", username: "alex", displayName: "Alex Rivera", role: "member" } as Record<
    string,
    string
  >,
}));

vi.mock("@/lib/hooks/useChat", async () => {
  const React = await import("react");
  return {
    useChat: () => {
      const [messages, setMessages] = React.useState<Msg[]>([]);
      ctl.setMessages = setMessages;
      return {
        messages,
        isStreaming: false,
        sendMessage: vi.fn(),
        stop: vi.fn(),
        retryMessage: vi.fn(),
        regenerate: vi.fn(),
        editMessage: vi.fn(),
        rateMessage: vi.fn(),
        approveScene: vi.fn(),
        clearMessages: vi.fn(),
        attachments: [],
        sessionAttachments: [],
        attach: vi.fn(),
        removeAttachment: vi.fn(),
        clearAttachments: vi.fn(),
        conversationId: null,
        // A deep link's load never settles here: the page must hold its frame.
        loadConversation: vi.fn(() => new Promise<boolean>(() => {})),
        messagesEpoch: 0,
      };
    },
  };
});

vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({
    models: [
      { id: "m1", provider: "local", name: "Model one" },
      { id: "m2", provider: "local", name: "Model two" },
    ],
    defaultModel: "m1",
  }),
}));

vi.mock("@/lib/hooks/useStickyScroll", () => ({
  STICKY_PX: 80,
  useStickyScroll: () => ({
    scrollRef: { current: null },
    isDetached: false,
    scrollToBottom: vi.fn(),
    onScroll: vi.fn(),
    stickyScrollToBottom: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(ctl.search),
  usePathname: () => "/chat",
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: ctl.user }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchBusinessProfile: ctl.fetchBusinessProfile };
});

import ChatPage from "@/app/chat/page";
import { HelpLauncher } from "@/components/help/HelpLauncher";

describe("/chat — Help sits in the header (WARP-3043)", () => {
  beforeEach(() => {
    ctl.search = "";
    ctl.fetchBusinessProfile.mockReset();
    ctl.fetchBusinessProfile.mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it("renders exactly one Help button, inside .chat-head", async () => {
    const { container } = render(
      <>
        <ChatPage />
        <HelpLauncher />
      </>,
    );
    await screen.findByTestId("chat-empty");
    const buttons = screen.getAllByRole("button", { name: "Open help" });
    expect(buttons).toHaveLength(1);
    expect(container.querySelector(".chat-head")!.contains(buttons[0])).toBe(true);
    expect(buttons[0].closest(".help-slot")).not.toBeNull();
  });

  it("names no trust copy anywhere on the page", async () => {
    const { container } = render(
      <>
        <ChatPage />
        <HelpLauncher />
      </>,
    );
    await screen.findByTestId("chat-empty");
    // The composer's model picker is up (two local models: a menu button).
    await screen.findByRole("button", { name: /^Model: / });
    expect(container.textContent).not.toMatch(/on-device|stays on your Droplet|nothing leaves/i);
  });
});
