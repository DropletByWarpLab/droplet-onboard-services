/**
 * WARP-3375 — the disconnect request carries the owner's answer to "what
 * happens to the records this connector imported?".
 *
 * Wire shape: `POST /api/connectors/:provider/disconnect` with an optional
 * JSON body `{ "records": "keep" | "delete" }`. Absent means `keep`, so a
 * client that predates the question (no body at all) can never delete a
 * business's customers by clicking Disconnect.
 *
 * Drives the real router with a stub service and asserts what the service was
 * ASKED to do, which is the contract; what `disconnect()` does with it is
 * pinned in `integrations.disconnect-purge.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const disconnect = vi.fn();

vi.mock("../services/integrations.service.js", () => ({
  createIntegrationsService: () => ({ disconnect, list: vi.fn() }),
}));

import { createIntegrationsRouter } from "./integrations.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u-owner", role: "owner" };
    next();
  });
  a.use("/api", createIntegrationsRouter({} as never));
  return a;
}

describe("disconnect body: records = keep | delete", () => {
  beforeEach(() => {
    disconnect.mockReset();
    disconnect.mockResolvedValue({ provider: "hubspot", status: "DISABLED" });
  });

  it("defaults to keep when there is no body at all", async () => {
    // Mutation: default the schema to "delete" (or drop `.default`) → red.
    const res = await request(app()).post("/api/connectors/hubspot/disconnect");

    expect(res.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith({ actor: "u-owner" }, "hubspot", { records: "keep" });
  });

  it("defaults to keep when the body is an empty object", async () => {
    await request(app()).post("/api/connectors/hubspot/disconnect").send({});

    expect(disconnect).toHaveBeenCalledWith({ actor: "u-owner" }, "hubspot", { records: "keep" });
  });

  it("passes an explicit delete through", async () => {
    await request(app()).post("/api/connectors/hubspot/disconnect").send({ records: "delete" });

    expect(disconnect).toHaveBeenCalledWith({ actor: "u-owner" }, "hubspot", {
      records: "delete",
    });
  });

  it("passes an explicit keep through", async () => {
    await request(app()).post("/api/connectors/hubspot/disconnect").send({ records: "keep" });

    expect(disconnect).toHaveBeenCalledWith({ actor: "u-owner" }, "hubspot", { records: "keep" });
  });

  it("honours the body on the deprecated eaglesoft alias too", async () => {
    await request(app()).post("/api/connectors/eaglesoft/disconnect").send({ records: "delete" });

    expect(disconnect).toHaveBeenCalledWith({ actor: "u-owner" }, "eaglesoft", {
      records: "delete",
    });
  });

  it("refuses an unknown disposition with a 400 and never calls the service", async () => {
    // A typo must not fall back to a default the owner did not choose.
    const res = await request(app())
      .post("/api/connectors/hubspot/disconnect")
      .send({ records: "purge" });

    expect(res.status).toBe(400);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("refuses a misspelt field with a 400 rather than silently keeping", async () => {
    const res = await request(app())
      .post("/api/connectors/hubspot/disconnect")
      .send({ record: "delete" });

    expect(res.status).toBe(400);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
