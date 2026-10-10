/**
 * WARP-3904 — which tool calls become connect cards.
 *
 * A call is a card only when it SUCCEEDED and its result is a descriptor the
 * shared parsers accept. A descriptor whose POST target is off the allowlist is
 * a parser refusal, and the call keeps its chip instead of becoming a form.
 */
import { describe, it, expect } from "vitest";
import type { ChatToolCall } from "@/lib/types";
import { connectCallsOf, connectResultOf } from "./connect-split";

function call(over: Partial<ChatToolCall> = {}): ChatToolCall {
  return { id: "c1", name: "start_connection", args: {}, ok: true, ...over };
}

const STRIPE_CARD = {
  kind: "connect_card",
  provider: "stripe",
  family: "integration",
  displayName: "Stripe",
  scope: "box",
  summary: "Reads payouts, charges, customers · polled every 15 min",
  safety: "setup-internet",
  manageHref: "/connectors",
  mode: "credentials",
  fields: [{ name: "apiKey", label: "Restricted key", type: "password", required: true, secret: true }],
  post: { path: "/api/connectors/stripe/connect" },
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
      manageHref: "/connectors",
      canDisconnect: true,
      canReconnect: false,
    },
  ],
  available: [],
  boxWideVisible: true,
};

const DISCONNECTED = { kind: "connection_disconnected", provider: "stripe", family: "integration", displayName: "Stripe" };

describe("connectResultOf", () => {
  it("turns a tool_result whose data.kind is connect_card into a card", () => {
    const result = connectResultOf(call({ data: STRIPE_CARD }));
    expect(result?.kind).toBe("card");
    expect(result?.kind === "card" && result.card.provider).toBe("stripe");
    expect(result?.kind === "card" && result.card.mode).toBe("credentials");
  });

  it("reads the MCP-wrapped { data: <result> } shape too", () => {
    const result = connectResultOf(call({ data: { data: STRIPE_CARD } }));
    expect(result?.kind).toBe("card");
  });

  it("recognises an overview and a disconnected line", () => {
    expect(connectResultOf(call({ name: "list_connections", data: OVERVIEW }))?.kind).toBe("overview");
    expect(connectResultOf(call({ name: "disconnect_connection", data: DISCONNECTED }))?.kind).toBe("disconnected");
  });

  it.each([
    ["an upload route", "/api/files/upload"],
    ["the credentials save route (the card derives that one itself)", "/api/connectors/stripe/credentials"],
    ["another provider's path with a traversal", "/api/connectors/../admin/connect"],
    ["an absolute URL on another host", "https://evil.example/api/connectors/stripe/connect"],
    ["a protocol-relative URL", "//evil.example/api/email/accounts"],
    ["the mailbox route with a query string", "/api/email/accounts?next=https://evil.example"],
  ])("yields nothing when post.path is %s", (_label, path) => {
    const data = { ...STRIPE_CARD, post: { path } };
    expect(connectResultOf(call({ data }))).toBeNull();
    expect(connectCallsOf([call({ data })])).toEqual([]);
  });

  it("refuses a mailbox or calendar card pointed at the other family's route", () => {
    const mailbox = { ...STRIPE_CARD, mode: "mailbox", provider: "mailbox", family: "mailbox", post: { path: "/api/calendar/sources" } };
    expect(connectResultOf(call({ data: mailbox }))).toBeNull();
    const calendar = { ...STRIPE_CARD, mode: "calendar", provider: "calendar", family: "calendar", post: { path: "/api/email/accounts" } };
    expect(connectResultOf(call({ data: calendar }))).toBeNull();
  });

  it("refuses an OAuth card whose start path is not Google's or Microsoft's", () => {
    const oauth = {
      ...STRIPE_CARD,
      mode: "oauth",
      provider: "google",
      family: "google",
      providerLabel: "Google",
      options: [],
      start: { path: "/api/email/accounts" },
    };
    expect(connectResultOf(call({ data: oauth }))).toBeNull();
    expect(connectResultOf(call({ data: { ...oauth, start: { path: "/api/google/connect" } } }))?.kind).toBe("card");
  });

  it("drops a secret-shaped default instead of rendering it, and keeps the card", () => {
    const data = {
      ...STRIPE_CARD,
      fields: [{ name: "apiKey", label: "Restricted key", type: "password", required: true, secret: true, defaultValue: "sk_live_leak" }],
    };
    const result = connectResultOf(call({ data }));
    expect(result?.kind).toBe("card");
    expect(JSON.stringify(result)).not.toContain("sk_live_leak");
  });

  it.each([
    ["a failed call", { ok: false }],
    ["a pending call", { ok: undefined }],
    ["a call awaiting approval", { status: "confirmation_required" }],
  ])("keeps %s as a chip even when its data is a valid card", (_label, over) => {
    expect(connectResultOf(call({ data: STRIPE_CARD, ...over }))).toBeNull();
  });

  it("leaves unrelated calls and odd data as chips, and never throws", () => {
    const odd: unknown[] = [undefined, null, "text", 42, [], [STRIPE_CARD], { items: [] }, { kind: "camera_snapshot" }, { data: null }, { data: "x" }];
    for (const data of odd) {
      expect(() => connectResultOf(call({ data }))).not.toThrow();
      expect(connectResultOf(call({ data }))).toBeNull();
    }
    expect(connectResultOf(call({ name: "get_camera_snapshot", data: { media: { kind: "camera_snapshot", camera: "front" } } }))).toBeNull();
  });
});

describe("connectCallsOf", () => {
  it("returns only the connect calls, in call order, and tolerates no calls", () => {
    const calls = [
      call({ id: "a", name: "list_files", data: { items: [] } }),
      call({ id: "b", data: STRIPE_CARD }),
      call({ id: "c", name: "list_connections", data: OVERVIEW }),
      call({ id: "d", ok: false, data: STRIPE_CARD }),
      call({ id: "e", name: "disconnect_connection", data: DISCONNECTED }),
    ];
    const found = connectCallsOf(calls);
    expect(found.map((c) => c.call.id)).toEqual(["b", "c", "e"]);
    expect(found.map((c) => c.result.kind)).toEqual(["card", "overview", "disconnected"]);
    expect(connectCallsOf(undefined)).toEqual([]);
    expect(connectCallsOf([])).toEqual([]);
  });
});
