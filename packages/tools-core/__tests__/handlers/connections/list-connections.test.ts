/**
 * WARP-3904 — `list_connections`.
 *
 * A read-only pass-through over `GET /api/connections`. What is worth pinning:
 * the role gate runs before any HTTP, the acting person is forwarded the way
 * `email_accounts` forwards them, and the answer is re-validated so a bad row
 * is dropped and a key-shaped extra never reaches the model.
 */
import { describe, it, expect } from "vitest";
import listConnections from "../../../src/handlers/connections/list-connections.js";
import { json } from "../../helpers/orchestrator-ctx.js";
import { ACTING_HEADERS, connectCtx, mailRow, overviewOf, stripeRow } from "../../helpers/connections-fixtures.js";

describe("list_connections", () => {
  it("is a read: no write, no confirmation, no arguments", () => {
    expect(listConnections.requiresWrite).toBe(false);
    expect(listConnections.requiresConfirmation).toBe(false);
    expect(listConnections.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("describes itself to the model in 200 characters or fewer, and says when to call it", () => {
    expect(listConnections.description.length).toBeLessThanOrEqual(200);
    expect(listConnections.description).toMatch(/connected and available/i);
    expect(listConnections.description).toMatch(/sync/i);
  });

  it.each([null, "guest", "service"] as const)("refuses role %s without any HTTP", async (role) => {
    const { ctx, get } = connectCtx(role);
    const result = await listConnections.handler({}, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "FORBIDDEN" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an absent acting person without HTTP", async () => {
    const { ctx, get } = connectCtx("family", null);
    expect(await listConnections.handler({}, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "family"] as const)("forwards %s's identity to GET /api/connections", async (role) => {
    const { ctx, get } = connectCtx(role);
    get.mockResolvedValueOnce(json(200, overviewOf([stripeRow])));
    const result = await listConnections.handler({}, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/connections", ACTING_HEADERS);
    expect(result.ok).toBe(true);
  });

  it("returns the overview, parsed", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, overviewOf([stripeRow, mailRow])));
    const result = await listConnections.handler({}, ctx);
    expect(result).toEqual({
      ok: true,
      data: {
        kind: "connections_overview",
        connected: [stripeRow, mailRow],
        available: [
          { provider: "hubspot", family: "integration", displayName: "HubSpot", category: "CRM", scope: "box", canConnect: true },
        ],
        // Recomputed from the rows that survived, never trusted from the wire.
        counts: { connected: 2, needsAttention: 1, available: 1 },
        boxWideVisible: true,
      },
    });
  });

  it("drops a malformed row instead of failing the whole list", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(
      json(
        200,
        overviewOf([
          stripeRow,
          { ...mailRow, family: "not-a-family" },
          { ...mailRow, id: "mailbox:other", manageHref: "https://evil.example/manage" },
          { ...mailRow, id: "mailbox:third", status: "exploded" },
          "not a row",
          null,
        ]),
      ),
    );
    const result = await listConnections.handler({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { connected: [stripeRow], counts: { connected: 1, needsAttention: 0, available: 1 } },
    });
  });

  it("passes on nothing the contract does not name", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(
      json(200, {
        ...overviewOf([{ ...stripeRow, apiKey: "private-key-value", oauthToken: "private-token-value" }]),
        debug: "private-debug",
      }),
    );
    const result = await listConnections.handler({}, ctx);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("returns an empty overview for a box with nothing connected", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(json(200, overviewOf([], [])));
    expect(await listConnections.handler({}, ctx)).toMatchObject({
      ok: true,
      data: { connected: [], available: [], counts: { connected: 0, needsAttention: 0, available: 0 } },
    });
  });

  it.each([
    ["a body that is not an overview", json(200, { connected: [] })],
    ["a body that is not JSON", new Response("<html>nope</html>", { status: 200 })],
  ])("returns an INTERNAL error for %s", async (_label, response) => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(response);
    const result = await listConnections.handler({}, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "INTERNAL" } });
  });

  it("maps the route's 403 to FORBIDDEN and 401 to AUTH_REQUIRED", async () => {
    const forbidden = connectCtx();
    forbidden.get.mockResolvedValueOnce(json(403, { error: "forbidden" }));
    expect(await listConnections.handler({}, forbidden.ctx)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const unauth = connectCtx();
    unauth.get.mockResolvedValueOnce(json(401, { error: "unauthorized" }));
    expect(await listConnections.handler({}, unauth.ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it("names the status but never echoes the orchestrator's error body", async () => {
    const { ctx, get } = connectCtx();
    get.mockResolvedValueOnce(new Response("private-server-body with a stack trace", { status: 500 }));
    const result = await listConnections.handler({}, ctx);
    expect(result).toMatchObject({ ok: false, status: "error", error: { code: "CONNECTIONS_FAILED" } });
    expect(JSON.stringify(result)).toContain("500");
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});
