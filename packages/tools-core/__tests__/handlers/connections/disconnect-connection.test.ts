/**
 * WARP-3904 — `disconnect_connection`.
 *
 * A confirmed write over `POST /api/connections/disconnect`. The interceptor
 * owns the prompt, so what is pinned here is the contract around it: the tool
 * is flagged so the interceptor challenges it, `precheck` refuses a call that
 * can never succeed before anyone is asked to approve it, the body is `{ id }`
 * for a row id and `{ provider }` for a name, and every refusal is a short
 * code and a human line, never the route's body.
 */
import { describe, it, expect } from "vitest";
import disconnectConnection from "../../../src/handlers/connections/disconnect-connection.js";
import { confirmationOwnerOf } from "../../../src/interceptor.js";
import { json } from "../../helpers/orchestrator-ctx.js";
import { ACTING_HEADERS, connectCtx, disconnectedOk } from "../../helpers/connections-fixtures.js";

const okReply = () => json(200, { disconnected: disconnectedOk });

describe("disconnect_connection: shape", () => {
  it("is a confirmed write, and the interceptor (not the route) asks", () => {
    expect(disconnectConnection.requiresWrite).toBe(true);
    expect(disconnectConnection.requiresConfirmation).toBe(true);
    expect(confirmationOwnerOf(disconnectConnection)).toBe("interceptor");
  });

  it("takes one required string, `connection`, and no `confirmed` flag", () => {
    const schema = disconnectConnection.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["connection"]);
    expect(schema.properties.connection).not.toHaveProperty("maxLength");
    expect(schema.required).toEqual(["connection"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("carries the sentence the approval card shows", () => {
    expect(disconnectConnection.description).toBe(
      "Disconnect a service and remove its saved access. Personal accounts, mailboxes and calendars delete local archives; catalog integration records stay.",
    );
  });
});

describe("disconnect_connection: gate and precheck", () => {
  it.each([null, "guest", "service"] as const)("refuses role %s without any HTTP", async (role) => {
    const { ctx, post } = connectCtx(role);
    expect(await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "FORBIDDEN" },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses an absent acting person without HTTP", async () => {
    const { ctx, post } = connectCtx("owner", null);
    expect(await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx)).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { connection: "" }],
    ["blank", { connection: "  " }],
    ["not a string", { connection: ["integration:mailchimp"] }],
    ["longer than 160 characters", { connection: `integration:${"a".repeat(160)}` }],
  ])("rejects a connection that is %s, with no HTTP", async (_label, args) => {
    const { ctx, post } = connectCtx();
    expect(await disconnectConnection.handler(args, ctx)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("precheck refuses what the handler would, before anyone is asked to approve", async () => {
    const guest = connectCtx("guest");
    expect(await disconnectConnection.precheck!({ connection: "integration:mailchimp" }, guest.ctx)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "FORBIDDEN" },
    });
    const noTarget = connectCtx();
    expect(await disconnectConnection.precheck!({}, noTarget.ctx)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    const anon = connectCtx("owner", null);
    expect(await disconnectConnection.precheck!({ connection: "x" }, anon.ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    for (const made of [guest, noTarget, anon]) expect(made.post).not.toHaveBeenCalled();
  });

  it("precheck lets a well-formed call through to the approval, and makes no HTTP call of its own", async () => {
    const { ctx, get, post, patch, delete: del } = connectCtx("family");
    expect(await disconnectConnection.precheck!({ connection: "mailbox:ckx1abc" }, ctx)).toBeNull();
    for (const call of [get, post, patch, del]) expect(call).not.toHaveBeenCalled();
  });
});

describe("disconnect_connection: the call", () => {
  it.each(["integration:mailchimp", "google:me", "m365:me", "mailbox:ckx1abc", "calendar:feed_2-b", "integration:square-2"])(
    "sends a row id (%s) as { id }",
    async (connection) => {
      const { ctx, post } = connectCtx();
      post.mockResolvedValueOnce(okReply());
      await disconnectConnection.handler({ connection }, ctx);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/api/connections/disconnect", { id: connection }, ACTING_HEADERS);
    },
  );

  it.each(["mailchimp", "our mailchimp", "Gmail", "mail server: main", "integration:", ":mailchimp", "a:b:c", "integration:has space"])(
    "sends a name (%j) as { provider }",
    async (connection) => {
      const { ctx, post } = connectCtx();
      post.mockResolvedValueOnce(okReply());
      await disconnectConnection.handler({ connection }, ctx);
      expect(post).toHaveBeenCalledWith("/api/connections/disconnect", { provider: connection }, ACTING_HEADERS);
    },
  );

  it("trims before choosing the body", async () => {
    const { ctx, post } = connectCtx();
    post.mockResolvedValueOnce(okReply());
    await disconnectConnection.handler({ connection: "  integration:mailchimp \n" }, ctx);
    expect(post).toHaveBeenCalledWith("/api/connections/disconnect", { id: "integration:mailchimp" }, ACTING_HEADERS);
  });

  it.each(["owner", "admin", "family"] as const)("forwards %s's identity", async (role) => {
    const { ctx, post } = connectCtx(role);
    post.mockResolvedValueOnce(okReply());
    expect((await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx)).ok).toBe(true);
    expect(post.mock.calls[0]![2]).toEqual(ACTING_HEADERS);
  });

  it("returns the parsed descriptor", async () => {
    const { ctx, post } = connectCtx();
    post.mockResolvedValueOnce(json(200, { disconnected: { ...disconnectedOk, token: "private-token-value" } }));
    const result = await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx);
    expect(result).toEqual({ ok: true, data: disconnectedOk });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});

describe("disconnect_connection: refusals", () => {
  it("maps 403 to FORBIDDEN", async () => {
    const { ctx, post } = connectCtx("family");
    post.mockResolvedValueOnce(json(403, { error: "forbidden" }));
    expect(await disconnectConnection.handler({ connection: "integration:stripe" }, ctx)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "FORBIDDEN", message: expect.stringMatching(/owner or admin/) },
    });
  });

  it("maps 404 to NOT_FOUND and points the model at list_connections", async () => {
    const { ctx, post } = connectCtx();
    post.mockResolvedValueOnce(json(404, { error: "not_found" }));
    expect(await disconnectConnection.handler({ connection: "integration:nothing" }, ctx)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("list_connections") },
    });
  });

  it("maps 400 to INVALID_ARGS and 401 to AUTH_REQUIRED", async () => {
    for (const [status, code] of [
      [400, "INVALID_ARGS"],
      [401, "AUTH_REQUIRED"],
    ] as const) {
      const { ctx, post } = connectCtx();
      post.mockResolvedValueOnce(json(status, { error: "x" }));
      expect(await disconnectConnection.handler({ connection: "mailchimp" }, ctx)).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("names the status, tells the person to check connections in chat, and never echoes the body", async () => {
    const { ctx, post } = connectCtx();
    post.mockResolvedValueOnce(new Response("private-server-body with a stack trace", { status: 500 }));
    const result = await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "DISCONNECT_FAILED" } });
    const text = JSON.stringify(result);
    expect(text).toContain("500");
    expect(text).toContain("here in this chat");
    expect(text).not.toContain("private-");
  });

  it.each([
    ["no descriptor", json(200, { ok: true })],
    ["a descriptor of the wrong kind", json(200, { disconnected: { ...disconnectedOk, kind: "connection_failed" } })],
    ["a body that is not JSON", new Response("done", { status: 200 })],
  ])("does not report a failure it cannot be sure of when the 2xx reply has %s", async (_label, response) => {
    const { ctx, post } = connectCtx();
    post.mockResolvedValueOnce(response);
    const result = await disconnectConnection.handler({ connection: "integration:mailchimp" }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL", message: expect.stringMatching(/may have disconnected/) } });
  });

  it("writes every refusal in plain sentences: ASCII, no exclamation marks", async () => {
    const attempts: Array<[Record<string, unknown>, Response | null]> = [
      [{}, null],
      [{ connection: "x".repeat(161) }, null],
      [{ connection: "a" }, json(400, {})],
      [{ connection: "a" }, json(403, {})],
      [{ connection: "a" }, json(404, {})],
      [{ connection: "a" }, json(500, {})],
      [{ connection: "a" }, json(200, {})],
    ];
    for (const [args, response] of attempts) {
      const { ctx, post } = connectCtx();
      if (response) post.mockResolvedValueOnce(response);
      const result = await disconnectConnection.handler(args, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toMatch(/^[\x20-\x7e]+$/);
      expect(result.error.message).not.toContain("!");
    }
  });
});
