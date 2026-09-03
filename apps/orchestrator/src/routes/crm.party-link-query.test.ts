/**
 * WARP-2562 review — `GET /crm/party-links` must answer the both-or-neither
 * mistake at the FIELD, like the POST beside it does.
 *
 * `partyLinkCreateSchema` carries a `.refine()` that rejects "neither" and
 * "both" with a `path: ["contactId"]`, so a caller gets a 400 naming the field
 * they got wrong. The query schema shipped without it, so the same mistake on
 * the READ path fell through zod, reached `resolveParty()`, and came back as a
 * bare 422 `party_link_needs_exactly_one_party` — a body with no field in it,
 * from a layer whose job is to talk about rows rather than about request
 * shape.
 *
 * Driven through Express rather than asserted against the schema object: the
 * question is which LAYER answers, and only a request can distinguish the
 * route's 400 from the service's 422. The service double below throws if it is
 * reached at all, so "the refine is missing" cannot pass as "the service
 * happened to say something similar".
 */
import { describe, it, expect, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { createCrmRouter } from "./crm.js";

/**
 * `listPartyLinks` must never run for a malformed query. A prisma double whose
 * every method throws makes that an assertion rather than a hope — if the
 * refine is absent, the service reaches this and the test fails loudly instead
 * of on a status-code technicality.
 */
function makeApp(): { app: Express; contactLookup: ReturnType<typeof vi.fn> } {
  const contactLookup = vi.fn(async () => {
    throw new Error("the service must not be reached for a malformed query");
  });
  const prisma = {
    contact: { findFirst: contactLookup },
    crmCompany: { findUnique: contactLookup },
    partyLink: { findMany: contactLookup, findFirst: contactLookup, findUnique: contactLookup },
  };
  const app = express();
  app.use((req, _res, next) => {
    // The GET route needs an owner but no role — `requireRole` guards the
    // writes only, so this is the whole auth surface it reads.
    (req as { user?: unknown }).user = { id: "u1", role: "owner" };
    next();
  });
  app.use("/api", createCrmRouter(prisma as never));
  return { app, contactLookup };
}

describe("WARP-2562 review — GET /crm/party-links validates the party pair", () => {
  it("rejects a query naming NEITHER party at the route, pointing at the field", async () => {
    // MUTATION: delete the `.refine()` from `partyLinkQuerySchema` and this is
    // a 422 from `resolveParty()` with no field in the body.
    const { app, contactLookup } = makeApp();

    const res = await request(app).get("/api/crm/party-links");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details.fieldErrors).toHaveProperty("contactId");
    expect(contactLookup).not.toHaveBeenCalled();
  });

  it("rejects a query naming BOTH parties the same way", async () => {
    // "Both" is the more dangerous half: it looks like a filter and would
    // silently answer about one of the two.
    const { app, contactLookup } = makeApp();

    const res = await request(app)
      .get("/api/crm/party-links")
      .query({ contactId: "c1", companyId: "co1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details.fieldErrors).toHaveProperty("contactId");
    expect(contactLookup).not.toHaveBeenCalled();
  });

  it("still lets exactly one party through to the service", async () => {
    // Guards the guard: a refine that rejected everything would pass both
    // tests above and break the only working call.
    const prismaOk = {
      contact: { findFirst: vi.fn().mockResolvedValue({ id: "c1" }) },
      crmCompany: { findUnique: vi.fn() },
      partyLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const ok = express();
    ok.use((req, _res, next) => {
      (req as { user?: unknown }).user = { id: "u1", role: "owner" };
      next();
    });
    ok.use("/api", createCrmRouter(prismaOk as never));

    const res = await request(ok).get("/api/crm/party-links").query({ contactId: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([]);
  });
});
