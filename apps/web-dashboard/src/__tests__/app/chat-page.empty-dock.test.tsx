/**
 * WARP-3043 — the empty /chat is the Mac app's: a greeting over the pill,
 * with the suggestions inside the composer; the pill docks at the bottom
 * once there are messages, and it is the SAME element in both states, so a
 * half-typed message survives the switch.
 *
 * `isFresh` (no messages, no `?c=`, no interview session) drives both the
 * `is-empty` layout and the greeting, so a deep link whose load is still in
 * flight never flashes the empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

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
    models: [{ id: "m1", provider: "local", name: "Model one" }],
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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

const GREETING = /^(Still up|Good morning|Good afternoon|Good evening|Working late), Alex\.$/;

const main = (c: HTMLElement) => c.querySelector(".chat-main") as HTMLElement;

describe("chat /chat — greeting over the pill, docked once it has messages (WARP-3043)", () => {
  beforeEach(() => {
    ctl.search = "";
    ctl.user = { id: "u1", username: "alex", displayName: "Alex Rivera", role: "member" };
    ctl.fetchBusinessProfile.mockReset();
    ctl.fetchBusinessProfile.mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it("a fresh chat greets you and asks the question as its heading", async () => {
    const { container } = render(<ChatPage />);
    const empty = await screen.findByTestId("chat-empty");
    expect(main(container).classList.contains("is-empty")).toBe(true);
    expect(
      screen.getByRole("heading", { level: 1, name: "What can I help you with today?" }),
    ).toBeInTheDocument();
    expect(empty.querySelector(".l1")?.textContent).toMatch(GREETING);
    expect(container.textContent).not.toMatch(/nothing leaves/i);
    expect(container.querySelector(".chat-empty .ico")).toBeNull();
  });

  it("the suggestions sit inside the composer, after the pill", async () => {
    const { container } = render(<ChatPage />);
    await screen.findByTestId("chat-empty");
    const suggs = await vi.waitFor(() => {
      const el = container.querySelector(".chat-suggs");
      expect(el).not.toBeNull();
      return el!;
    });
    const composer = container.querySelector(".chat-composer")!;
    expect(suggs.parentElement).toBe(composer);
    const pill = composer.querySelector(":scope > .chat-composer-inner")!;
    expect(pill.compareDocumentPosition(suggs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main(container).lastElementChild).toBe(composer);
    expect(screen.queryByText(/lights to 30%/)).toBeNull();
  });

  it("a deep link still loading shows neither the empty layout nor the greeting", async () => {
    ctl.search = "c=abc";
    const { container } = render(<ChatPage />);
    await act(async () => {});
    expect(main(container).classList.contains("is-empty")).toBe(false);
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("the pill docks once there are messages, and keeps what you typed", async () => {
    const { container } = render(<ChatPage />);
    await screen.findByTestId("chat-empty");
    const field = screen.getByPlaceholderText("Ask Droplet anything…") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "half a thought" } });

    await act(async () =>
      ctl.setMessages!([
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi there" },
      ]),
    );

    expect(main(container).classList.contains("is-empty")).toBe(false);
    expect(screen.queryByTestId("chat-empty")).toBeNull();
    expect(container.querySelector(".chat-suggs")).toBeNull();
    const after = screen.getByPlaceholderText("Ask Droplet anything…") as HTMLTextAreaElement;
    expect(after).toBe(field);
    expect(after.value).toBe("half a thought");
  });

  it("no suggestions beside the interview intro card", async () => {
    ctl.user = { id: "u1", username: "alex", displayName: "Alex Rivera", role: "owner" };
    ctl.fetchBusinessProfile.mockResolvedValue({
      onboardingState: "not_started",
      workspaceType: "BUSINESS",
    });
    const { container } = render(<ChatPage />);
    await screen.findByTestId("interview-intro-card");
    expect(screen.queryByTestId("chat-empty")).toBeNull();
    expect(container.querySelector(".chat-suggs")).toBeNull();
  });
});
