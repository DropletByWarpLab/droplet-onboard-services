/**
 * WARP-3904 — connect cards in chat: a successful tool call whose result is a
 * connect descriptor renders as a card beneath the message, not as a chip, and
 * is a live form only on the newest assistant message of a conversation that
 * is open in this session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatToolCall } from "@/lib/types";

const authFetch = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import { ChatMessage } from "@/components/ChatMessage";

const STRIPE_CARD = {
  kind: "connect_card",
  provider: "stripe",
  family: "integration",
  displayName: "Stripe",
  scope: "box",
  summary: "Reads payouts, charges, customers · polled every 15 min",
  safety: "setup-internet",
  manageHref: "/integrations",
  mode: "credentials",
  fields: [{ name: "apiKey", label: "Restricted key", type: "password", required: true, secret: true }],
  post: { path: "/api/integrations/stripe/connect" },
};

const OVERVIEW = {
  kind: "connections_overview",
  connected: [
    {
      id: "integration:stripe",
      family: "integration",
      provider: "stripe",
      displayName: "Stripe",
      scope: "box",
      status: "connected",
      capabilities: ["payouts"],
      manageHref: "/integrations",
      canDisconnect: true,
      canReconnect: false,
    },
  ],
  available: [{ provider: "xero", family: "integration", displayName: "Xero", scope: "box", canConnect: true }],
  boxWideVisible: true,
};

function call(over: Partial<ChatToolCall> = {}): ChatToolCall {
  return { id: "c1", name: "start_connection", args: { service: "stripe" }, ok: true, data: STRIPE_CARD, ...over };
}

function renderMsg(
  toolCalls: ChatToolCall[],
  props: Partial<React.ComponentProps<typeof ChatMessage>> = {},
) {
  const onConnectOutcome = vi.fn();
  const utils = render(
    <ChatMessage
      message={{ id: "a1", role: "assistant", content: "Here is the form.", toolCalls }}
      isLastAssistant
      onConnectOutcome={onConnectOutcome}
      conversationId="conv-1"
      {...props}
    />,
  );
  return { onConnectOutcome, ...utils };
}

beforeEach(() => {
  authFetch.mockReset();
});
afterEach(cleanup);

describe("ChatMessage — connect cards", () => {
  it("renders a connect_card result as a live ConnectCard, not as a chip", () => {
    renderMsg([call()]);
    expect(screen.getByTestId("tool-connect-cards")).toBeInTheDocument();
    expect(screen.getByTestId("connect-card")).toHaveAttribute("data-provider", "stripe");
    expect(screen.getByLabelText(/restricted key/i)).toHaveAttribute("type", "password");
    // The call is the card; it is not also a chip.
    expect(screen.queryByTestId("tool-call-chips")).toBeNull();
  });

  it("keeps unrelated calls as chips beside the card", () => {
    renderMsg([call(), call({ id: "c2", name: "list_files", args: {}, data: { items: [] } })]);
    expect(screen.getByTestId("connect-card")).toBeInTheDocument();
    const chips = screen.getByTestId("tool-call-chips");
    expect(chips).toBeInTheDocument();
    expect(chips.children).toHaveLength(1);
  });

  it("leaves a call as a chip when its descriptor names a POST target off the allowlist", () => {
    renderMsg([call({ data: { ...STRIPE_CARD, post: { path: "/api/files/upload" } } })]);
    expect(screen.queryByTestId("tool-connect-cards")).toBeNull();
    expect(screen.queryByLabelText(/restricted key/i)).toBeNull();
    expect(screen.getByTestId("tool-call-chips")).toBeInTheDocument();
  });

  it("leaves a failed call as a chip", () => {
    renderMsg([call({ ok: false })]);
    expect(screen.queryByTestId("tool-connect-cards")).toBeNull();
    expect(screen.getByTestId("tool-call-chips")).toBeInTheDocument();
  });

  it("renders the overview and the disconnected line as non-form cards", () => {
    renderMsg([
      call({ id: "o", name: "list_connections", data: OVERVIEW }),
      call({ id: "d", name: "disconnect_connection", data: { kind: "connection_disconnected", provider: "stripe", family: "integration", displayName: "Stripe" } }),
    ]);
    expect(screen.getByTestId("connections-overview")).toBeInTheDocument();
    expect(screen.getByTestId("connection-disconnected")).toHaveTextContent("Disconnected Stripe");
    expect(screen.queryByTestId("tool-call-chips")).toBeNull();
  });

  it("a pill in the overview sends the ordinary 'Connect <Name>' turn through onConnectOutcome", () => {
    const { onConnectOutcome } = renderMsg([call({ name: "list_connections", data: OVERVIEW })]);
    fireEvent.click(screen.getByRole("button", { name: "Xero" }));
    expect(onConnectOutcome).toHaveBeenCalledTimes(1);
    expect(onConnectOutcome).toHaveBeenCalledWith("Connect Xero");
  });

  describe("only the newest message of a live conversation is a form", () => {
    it("fromHistory makes the card a compact row with no inputs and no buttons", () => {
      renderMsg([call()], { fromHistory: true });
      expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
      expect(screen.queryByTestId("connect-card")).toBeNull();
      expect(document.querySelectorAll("input")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /connect stripe|not now/i })).toBeNull();
      expect(screen.getByRole("link", { name: "Manage in Connectors" })).toHaveAttribute("href", "/integrations");
    });

    it("an older assistant message (not the last) is a compact row", () => {
      renderMsg([call()], { isLastAssistant: false });
      expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
      expect(document.querySelectorAll("input")).toHaveLength(0);
    });

    it("a surface that cannot send the follow-up turn (no onConnectOutcome) gets a compact row", () => {
      renderMsg([call()], { onConnectOutcome: undefined });
      expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
      expect(document.querySelectorAll("input")).toHaveLength(0);
    });

    it("never posts from a compact row", () => {
      renderMsg([call()], { fromHistory: true });
      expect(authFetch).not.toHaveBeenCalled();
    });
  });

  it("a connection made in the card reaches onConnectOutcome once, as the fixed sentence", async () => {
    authFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "PROVISIONING" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "CONNECTED" }), { status: 200 }));
    const { onConnectOutcome } = renderMsg([call()]);
    fireEvent.change(screen.getByLabelText(/restricted key/i), { target: { value: "sk_test_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Stripe" }));

    await waitFor(() => expect(onConnectOutcome).toHaveBeenCalledTimes(1));
    expect(onConnectOutcome).toHaveBeenCalledWith("Stripe is connected now.");
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/integrations/stripe/credentials",
      "/api/integrations/stripe/connect",
    ]);
  });
});
