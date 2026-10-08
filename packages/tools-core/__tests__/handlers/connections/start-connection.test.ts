/**
 * WARP-3904 — `start_connection`.
 *
 * The tool turns what a person said ("gmail", "stripe", "our mail server")
 * into a connect-card descriptor. It writes nothing and never touches a key:
 * what is worth pinning is the argument guard (a pasted credential must not
 * reach a URL), the exact call made, the unknown-service answer the model can
 * act on, and that a card the shared-types parser rejects is an error and
 * never a half card.
 */
import { describe, it, expect } from "vitest";
import startConnection from "../../../src/handlers/connections/start-connection.js";
import { json } from "../../helpers/orchestrator-ctx.js";
import { ACTING_HEADERS, blockedCard, connectCtx, googleCard, stripeCard } from "../../helpers/connections-fixtures.js";

// Deliberately too short to be a usable key; exercises the credential-shape guard.
const syntheticStripeCredential = ["sk", "test", "fixture0"].join("_");

describe("start_connection: shape", () => {
  it("writes nothing, so it asks nothing", () => {
    expect(startConnection.requiresWrite).toBe(false);
    expect(startConnection.requiresConfirmation).toBe(false);
  });

  it("takes one required string, `service`, and no maxLength (WARP-1839)", () => {
    const schema = startConnection.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["service"]);
    expect(schema.properties.service.type).toBe("string");
    expect(schema.properties.service).not.toHaveProperty("maxLength");
    expect(schema.properties.service).not.toHaveProperty("pattern");
    expect(schema.required).toEqual(["service"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("tells the model when to use it and never to ask for a secret, in 240 characters or fewer", () => {
    const d = startConnection.description;
    expect(d.length).toBeLessThanOrEqual(240);
    for (const word of ["connect", "add", "service"]) {
      expect(d).toContain(word);
    }
    expect(d).toMatch(/NEVER request keys, passwords or tokens in chat/);
    expect(d).toMatch(/setup form collects them/);
  });
});

describe("start_connection: gate and arguments", () => {
  it.each([null, "guest", "service"] as const)("refuses role %s without any HTTP", async (role) => {
    const { ctx, get } = connectCtx(role);
    expect(await startConnection.handler({ service: "gmail" }, ctx)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "FORBIDDEN" },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an absent acting person without HTTP", async () => {
    const { ctx, get } = connectCtx("owner", null);
    expect(await startConnection.handler({ service: "gmail" }, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { service: "" }],
    ["blank", { service: "   \n\t " }],
    ["not a string", { service: 42 }],
    ["longer than 120 characters", { service: "a".repeat(121) }],
  ])("rejects a service that is %s, with no HTTP", async (_label, args) => {
    const { ctx, get } = connectCtx();
    expect(await startConnection.handler(args, ctx)).toMatchObject({ ok: false, status: "error", error: { code: "INVALID_ARGS" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts exactly 120 characters", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card: stripeCard }));
    const result = await startConnection.handler({ service: "a".repeat(120) }, ctx);
    expect(result.ok).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    syntheticStripeCredential,
    "here is my key rk_test_abcdefgh12345678 please use it",
    "xoxb-1234567890-abcdefghijkl",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    "-----BEGIN PRIVATE KEY-----",
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  ])("refuses a credential-shaped service (%s) before it can reach a URL", async (service) => {
    const { ctx, get } = connectCtx();
    const result = await startConnection.handler({ service }, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "INVALID_ARGS" } });
    expect(JSON.stringify(result)).not.toContain(service);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["gmail", "Microsoft 365", "our mail server", "mail.the-long-company-domain-name-here.example.test", "QuickBooks Online"])(
    "lets the ordinary name %j through",
    async (service) => {
      const { ctx, get } = connectCtx();
      get.mockResolvedValueOnce(json(200, { card: stripeCard }));
      expect((await startConnection.handler({ service }, ctx)).ok).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );
});

describe("start_connection: the call", () => {
  it("forwards the acting person and the query, URL-encoded", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card: stripeCard }));
    await startConnection.handler({ service: "Zoho Mail & Calendar? #1/ü" }, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/api/connections/card?q=${encodeURIComponent("Zoho Mail & Calendar? #1/ü")}`, ACTING_HEADERS);
    const path = String(get.mock.calls[0]![0]);
    // The ampersand, question mark and hash must not be able to add a parameter.
    expect(new URL(path, "http://orchestrator").searchParams.get("q")).toBe("Zoho Mail & Calendar? #1/ü");
    expect([...new URL(path, "http://orchestrator").searchParams.keys()]).toEqual(["q"]);
  });

  it("trims, collapses whitespace and strips control characters before encoding", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card: stripeCard }));
    await startConnection.handler({ service: "  our \n mail\u0000  server  " }, ctx);
    expect(get).toHaveBeenCalledWith(`/api/connections/card?q=${encodeURIComponent("our mail server")}`, ACTING_HEADERS);
  });

  it.each(["owner", "admin", "family"] as const)("works for %s", async (role) => {
    const { ctx, get } = connectCtx(role);
    get.mockResolvedValueOnce(json(200, { card: stripeCard }));
    expect((await startConnection.handler({ service: "stripe" }, ctx)).ok).toBe(true);
  });
});

describe("start_connection: the card", () => {
  it("returns a valid credentials card unchanged", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card: stripeCard }));
    expect(await startConnection.handler({ service: "stripe" }, ctx)).toEqual({ ok: true, data: stripeCard });
  });

  it("returns a valid OAuth card unchanged", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card: googleCard }));
    expect(await startConnection.handler({ service: "google" }, ctx)).toEqual({ ok: true, data: googleCard });
  });

  it("returns a blocked card as a card: the dashboard renders the reason", async () => {
    const { ctx, get } = connectCtx("family");
    get.mockResolvedValueOnce(json(200, { card: blockedCard }));
    expect(await startConnection.handler({ service: "stripe" }, ctx)).toEqual({ ok: true, data: blockedCard });
  });

  it("never lets a secret field arrive pre-filled", async () => {
    const { ctx, get } = connectCtx();
    const prefilled = {
      ...stripeCard,
      fields: [{ ...stripeCard.fields[0], defaultValue: "private-prefilled-key" }],
    };
    get.mockResolvedValueOnce(json(200, { card: prefilled }));
    const result = await startConnection.handler({ service: "stripe" }, ctx);
    expect(result).toEqual({ ok: true, data: stripeCard });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it.each([
    ["a post path that is not on the allowlist", { ...stripeCard, post: { path: "/api/anything/else" } }],
    ["a post path that leaves the box", { ...stripeCard, post: { path: "https://evil.example/collect" } }],
    ["an OAuth start path that is not allowlisted", { ...googleCard, start: { path: "/api/google/connect/../admin" } }],
    ["a manage link that leaves the box", { ...stripeCard, manageHref: "https://evil.example/manage" }],
    ["a card of an unknown mode", { ...stripeCard, mode: "teleport" }],
    ["no kind", { ...stripeCard, kind: undefined }],
  ])("returns an INTERNAL error, not a card, for %s", async (_label, card) => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, { card }));
    const result = await startConnection.handler({ service: "stripe" }, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(result).not.toHaveProperty("data");
  });

  it.each([
    ["a body with no card", json(200, { notACard: true })],
    ["a card at the top level", json(200, stripeCard)],
    ["a body that is not JSON", new Response("<html>nope</html>", { status: 200 })],
  ])("returns an INTERNAL error for %s", async (_label, response) => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(response);
    expect(await startConnection.handler({ service: "stripe" }, ctx)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});

describe("start_connection: refusals the model can act on", () => {
  it("maps 404 unknown_provider to UNKNOWN_SERVICE with the suggestions", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(
      json(404, {
        error: "unknown_provider",
        suggestions: [
          { provider: "mailchimp", displayName: "Mailchimp" },
          { provider: "mailbox", displayName: "Email account (IMAP)" },
        ],
      }),
    );
    expect(await startConnection.handler({ service: "mailchim" }, ctx)).toEqual({
      ok: false,
      status: "error",
      error: {
        code: "UNKNOWN_SERVICE",
        message: expect.stringMatching(/ask the person which one/i),
        details: {
          suggestions: [
            { provider: "mailchimp", displayName: "Mailchimp" },
            { provider: "mailbox", displayName: "Email account (IMAP)" },
          ],
        },
      },
    });
  });

  it("keeps only well-formed suggestions, at most eight", async () => {
    const { ctx, get } = connectCtx();
    const good = Array.from({ length: 10 }, (_, i) => ({ provider: `svc-${i}`, displayName: `Service ${i}` }));
    get.mockResolvedValueOnce(
      json(404, {
        error: "unknown_provider",
        suggestions: [
          { provider: "Not A Provider!", displayName: "Bad id" },
          { provider: "ok-one", displayName: "" },
          { provider: "ok-two" },
          "junk",
          null,
          { provider: "good-one", displayName: "Good one", apiKey: "private-key-value" },
          ...good,
        ],
      }),
    );
    const result = await startConnection.handler({ service: "x" }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_SERVICE" } });
    const suggestions = (result as { error: { details: { suggestions: Array<Record<string, string>> } } }).error.details.suggestions;
    expect(suggestions).toHaveLength(8);
    expect(suggestions[0]).toEqual({ provider: "good-one", displayName: "Good one" });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("answers UNKNOWN_SERVICE with no suggestions when the route sent none", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(404, { error: "unknown_provider" }));
    expect(await startConnection.handler({ service: "zzz" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_SERVICE", details: { suggestions: [] } },
    });
  });

  it("does not call a missing route an unknown service", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(404, { error: "not_found" }));
    const result = await startConnection.handler({ service: "stripe" }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECT_CARD_FAILED" } });
    expect(result).not.toMatchObject({ error: { code: "UNKNOWN_SERVICE" } });
  });

  it("maps 400 to INVALID_ARGS, 403 to FORBIDDEN and 401 to AUTH_REQUIRED", async () => {
    for (const [status, code] of [
      [400, "INVALID_ARGS"],
      [403, "FORBIDDEN"],
      [401, "AUTH_REQUIRED"],
    ] as const) {
      const { ctx, get } = connectCtx();
      get.mockResolvedValueOnce(json(status, { error: "x" }));
      expect(await startConnection.handler({ service: "stripe" }, ctx)).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("names the status but never echoes the orchestrator's error body", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(new Response("private-server-body with a stack trace", { status: 502 }));
    const result = await startConnection.handler({ service: "stripe" }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECT_CARD_FAILED" } });
    expect(JSON.stringify(result)).toContain("502");
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("writes every refusal in plain sentences: ASCII, no exclamation marks", async () => {
    const messages: string[] = [];
    const attempts: Array<[Record<string, unknown>, Response | null]> = [
      [{}, null],
      [{ service: "a".repeat(121) }, null],
      [{ service: syntheticStripeCredential }, null],
      [{ service: "x" }, json(404, { error: "unknown_provider", suggestions: [] })],
      [{ service: "x" }, json(404, {})],
      [{ service: "x" }, json(400, {})],
      [{ service: "x" }, json(403, {})],
      [{ service: "x" }, json(500, {})],
      [{ service: "x" }, json(200, { card: { kind: "connect_card" } })],
    ];
    for (const [args, response] of attempts) {
      const { ctx, get } = connectCtx();
      if (response) get.mockResolvedValueOnce(response);
      const result = await startConnection.handler(args, ctx);
      if (!result.ok) messages.push(result.error.message);
    }
    expect(messages).toHaveLength(attempts.length);
    for (const m of messages) {
      expect(m).toMatch(/^[\x20-\x7e]+$/);
      expect(m).not.toContain("!");
    }
  });
});
