/**
 * DASH-04: the chat WS bridge (`/api/ws/events`) must not be opened until an
 * authenticated user is present. Before the gate, the effect mounted with
 * `[]` deps and connected (then reconnected with backoff forever) even on an
 * unauthenticated / expired session. `useChat` now takes `authReady` and only
 * opens the socket when it's true — mirroring the `if (!user) return` gate
 * NotificationToaster applies to the same endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  sendChat: vi.fn(),
  uploadBrainFile: vi.fn(),
  fetchConversation: vi.fn(),
}));

import { useChat, type UseChatOptions } from "@/lib/hooks/useChat";

// WebSocket double that records every construction + target URL so the test
// can assert whether the chat WS effect dialed out.
class CountingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: CountingWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    CountingWebSocket.instances.push(this);
  }
  send() {
    /* no-op */
  }
  close() {
    this.readyState = 3;
  }
}

function Probe(props: UseChatOptions) {
  useChat(props);
  return null;
}

beforeEach(() => {
  CountingWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", CountingWebSocket as unknown);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "http:", host: "localhost" } as Location,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChat WS auth gate (DASH-04)", () => {
  it("does NOT open the chat WS when authReady is false", () => {
    act(() => {
      render(<Probe authReady={false} />);
    });
    expect(CountingWebSocket.instances).toHaveLength(0);
  });

  it("opens the chat WS to /api/ws/events once authReady is true", () => {
    act(() => {
      render(<Probe authReady={true} />);
    });
    expect(CountingWebSocket.instances).toHaveLength(1);
    expect(CountingWebSocket.instances[0].url).toMatch(/\/api\/ws\/events$/);
  });

  it("defaults to opening the WS when authReady is omitted (back-compat)", () => {
    act(() => {
      render(<Probe />);
    });
    expect(CountingWebSocket.instances).toHaveLength(1);
  });

  it("opens the WS only after authReady flips false -> true", () => {
    let view: ReturnType<typeof render>;
    act(() => {
      view = render(<Probe authReady={false} />);
    });
    expect(CountingWebSocket.instances).toHaveLength(0);
    act(() => {
      view!.rerender(<Probe authReady={true} />);
    });
    expect(CountingWebSocket.instances).toHaveLength(1);
  });
});
