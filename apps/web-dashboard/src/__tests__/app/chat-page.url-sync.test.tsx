/**
 * WARP-3043 — a deep link keeps its `?c=` while the conversation loads.
 *
 * The page mirrors `conversationId` into the URL (state → URL). On a deep-link
 * mount `conversationId` is still null — the load is in flight — so the
 * mirror used to DELETE `?c=` straight away. Next (≥14.1) patches
 * `history.replaceState`, so `useSearchParams` follows that strip: the URL id
 * read null until the load resolved, the empty state flashed, and switching
 * away early lost the open conversation.
 *
 * The mirror now removes `c` only when a conversation that WAS open closes
 * (set → null). The failed-load strip is a separate path and still runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

type Msg = { id: string; role: "user" | "assistant"; content: string };

const ctl = vi.hoisted(() => ({
  pending: null as null | { id: string; settle: (ok: boolean) => void },
}));

vi.mock("@/lib/hooks/useChat", async () => {
  const React = await import("react");
  return {
    useChat: () => {
      const [conversationId, setConversationId] = React.useState<string | null>(null);
      const [messages, setMessages] = React.useState<Msg[]>([]);
      const loadConversation = React.useCallback(
        (id: string) =>
          new Promise<boolean>((resolve) => {
            ctl.pending = {
              id,
              settle: (ok) => {
                if (ok) {
                  setConversationId(id);
                  setMessages([
                    { id: "m1", role: "user", content: "hello" },
                    { id: "m2", role: "assistant", content: "hi there" },
                  ]);
                }
                resolve(ok);
              },
            };
          }),
        [],
      );
      const clearMessages = React.useCallback(() => {
        setConversationId(null);
        setMessages([]);
      }, []);
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
        clearMessages,
        attachments: [],
        sessionAttachments: [],
        attach: vi.fn(),
        removeAttachment: vi.fn(),
        clearAttachments: vi.fn(),
        conversationId,
        loadConversation,
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
  useSearchParams: () => new URLSearchParams("c=abc"),
  usePathname: () => "/chat",
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { id: "u1", username: "alice", displayName: "Alice" } }),
}));

import ChatPage from "@/app/chat/page";

/** Every replaceState call whose target URL has no `c` — a strip. */
function strips(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args: unknown[]) => String(args[2]))
    .filter((url: string) => !new URL(url, window.location.origin).searchParams.has("c"));
}

describe("chat /chat — ?c= survives a deep-link load (WARP-3043)", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ctl.pending = null;
    window.history.replaceState(null, "", "/chat?c=abc");
    spy = vi.spyOn(window.history, "replaceState");
  });
  afterEach(() => {
    cleanup();
    spy.mockRestore();
  });

  it("does not strip ?c= while the conversation is still loading", async () => {
    render(<ChatPage />);
    await act(async () => {});
    expect(ctl.pending?.id).toBe("abc");
    expect(strips(spy)).toEqual([]);
    expect(new URL(window.location.href).searchParams.get("c")).toBe("abc");
  });

  it("does not strip it once the load resolves either", async () => {
    render(<ChatPage />);
    await act(async () => {});
    await act(async () => ctl.pending!.settle(true));
    expect(strips(spy)).toEqual([]);
    expect(new URL(window.location.href).searchParams.get("c")).toBe("abc");
  });

  it("strips it when New chat closes a loaded conversation", async () => {
    render(<ChatPage />);
    await act(async () => {});
    await act(async () => ctl.pending!.settle(true));
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await act(async () => {});
    expect(strips(spy).length).toBeGreaterThan(0);
    expect(new URL(window.location.href).searchParams.has("c")).toBe(false);
  });

  it("still strips it when the load fails (a stale or revoked id)", async () => {
    render(<ChatPage />);
    await act(async () => {});
    await act(async () => ctl.pending!.settle(false));
    expect(strips(spy).length).toBeGreaterThan(0);
    expect(new URL(window.location.href).searchParams.has("c")).toBe(false);
  });
});
