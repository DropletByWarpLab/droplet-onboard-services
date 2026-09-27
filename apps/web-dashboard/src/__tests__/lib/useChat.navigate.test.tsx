import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { DashboardPage } from "@droplet/shared-types";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
}));

import { navigationTarget, useChat } from "@/lib/hooks/useChat";
import type { PersistedConversation } from "@/lib/api";

/**
 * WARP-3116 — "take me to it". The assistant's open_dashboard_page result
 * moves the viewer once the LIVE turn settles: to a page this turn sent,
 * never on a stopped turn, never when a conversation is reloaded.
 */

const PAGES: DashboardPage[] = [
  { href: "/voice", label: "Voice", section: "Systems › Network" },
  { href: "/settings", label: "Settings", section: "Admin" },
];

type Hook = ReturnType<typeof useChat>;
let hook: Hook | null = null;

function Probe({
  onNavigate,
  pages = PAGES,
}: {
  onNavigate: (href: string) => void;
  pages?: DashboardPage[];
}) {
  hook = useChat({ dashboardPages: pages, onNavigate });
  return null;
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function openPageTurn(href: string, tool = "open_dashboard_page"): string[] {
  return [
    frame("tool_call", { id: "call-1", name: tool, args: { page: "voice settings" } }),
    frame("tool_result", {
      id: "call-1",
      ok: true,
      data: { action: "navigate", href, label: "Voice" },
    }),
    frame("content_delta", { text: "Opening [Voice](/voice)." }),
    frame("done", { iterations: 2, stop_reason: "model_done" }),
  ];
}

beforeEach(() => {
  hook = null;
  mockSendChat.mockReset();
  mockFetchConversation.mockReset();
});

describe("useChat — dashboard navigation (WARP-3116)", () => {
  it("sends the page list and routes to the resolved page once the turn ends", async () => {
    const onNavigate = vi.fn();
    mockSendChat.mockResolvedValueOnce(sseResponse(openPageTurn("/voice")));
    render(<Probe onNavigate={onNavigate} />);

    await act(async () => {
      await hook!.sendMessage("take me to voice settings", "llama3:8b");
    });

    expect(mockSendChat.mock.calls[0][0]).toMatchObject({ dashboardPages: PAGES });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/voice"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // The answer is still there for when the viewer comes back.
    expect(hook!.messages.at(-1)?.content).toBe("Opening [Voice](/voice).");
  });

  it("never routes to a page this turn did not send", async () => {
    const onNavigate = vi.fn();
    mockSendChat.mockResolvedValueOnce(sseResponse(openPageTurn("/admin/audit")));
    render(<Probe onNavigate={onNavigate} />);

    await act(async () => {
      await hook!.sendMessage("take me to the audit log", "llama3:8b");
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("does not route on a lookup — only open_dashboard_page moves the viewer", async () => {
    const onNavigate = vi.fn();
    mockSendChat.mockResolvedValueOnce(
      sseResponse(openPageTurn("/voice", "find_dashboard_page")),
    );
    render(<Probe onNavigate={onNavigate} />);

    await act(async () => {
      await hook!.sendMessage("give me a link to the voice settings", "llama3:8b");
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("does not move a viewer who left the chat while the answer streamed", async () => {
    const onNavigate = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const [call, result, text, done] = openPageTurn("/voice");
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(call + result));
        await gate;
        controller.enqueue(enc.encode(text + done));
        controller.close();
      },
    });
    mockSendChat.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const { unmount } = render(<Probe onNavigate={onNavigate} />);

    let pending!: Promise<void>;
    act(() => {
      pending = hook!.sendMessage("take me to voice settings", "llama3:8b");
    });
    unmount(); // the viewer walked to another page mid-answer
    release();
    await act(async () => {
      await pending;
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("omits the page list when there is none, so the server withholds the tools", async () => {
    mockSendChat.mockResolvedValueOnce(sseResponse([frame("done", { iterations: 1, stop_reason: "model_done" })]));
    render(<Probe onNavigate={vi.fn()} pages={[]} />);

    await act(async () => {
      await hook!.sendMessage("hi", "llama3:8b");
    });

    expect(mockSendChat.mock.calls[0][0]).not.toHaveProperty("dashboardPages");
  });

  it("does not re-navigate when a conversation holding a navigation is reloaded", async () => {
    const onNavigate = vi.fn();
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-1",
      title: "Voice",
      model: "llama3:8b",
      provider: "local",
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:00Z",
      messages: [
        {
          id: "asst-1",
          role: "assistant",
          content: "Opening [Voice](/voice).",
          toolCalls: [
            {
              id: "call-1",
              name: "open_dashboard_page",
              args: { page: "voice" },
              ok: true,
              status: "ok",
              data: { action: "navigate", href: "/voice", label: "Voice" },
            },
          ],
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: "2026-09-25T00:00:00Z",
        },
      ],
    } as PersistedConversation);
    render(<Probe onNavigate={onNavigate} />);

    await act(async () => {
      await hook!.loadConversation("conv-1");
    });

    await waitFor(() => expect(hook!.messages).toHaveLength(1));
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("navigationTarget", () => {
  it("pairs the result with its call by id", () => {
    const ids = new Set<string>();
    expect(
      navigationTarget(
        { type: "tool_result", id: "x", ok: true, data: { action: "navigate", href: "/voice", label: "Voice" } },
        ids,
        PAGES,
      ),
    ).toBeNull();
    navigationTarget({ type: "tool_call", id: "x", name: "open_dashboard_page", args: {} }, ids, PAGES);
    expect(
      navigationTarget(
        { type: "tool_result", id: "x", ok: true, data: { action: "navigate", href: "/voice", label: "Voice" } },
        ids,
        PAGES,
      ),
    ).toBe("/voice");
  });

  it("ignores a failed or malformed result", () => {
    const ids = new Set(["x"]);
    expect(
      navigationTarget({ type: "tool_result", id: "x", ok: false, data: { action: "navigate", href: "/voice", label: "Voice" } }, ids, PAGES),
    ).toBeNull();
    expect(
      navigationTarget({ type: "tool_result", id: "x", ok: true, data: { action: "navigate", href: "//evil.example", label: "x" } }, ids, [
        ...PAGES,
        { href: "//evil.example", label: "x" },
      ]),
    ).toBeNull();
  });
});
