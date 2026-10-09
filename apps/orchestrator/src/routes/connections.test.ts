/**
 * WARP-3904 — the three routes behind "connect from chat".
 *
 * ── What this suite is weighted towards ────────────────────────────────────
 *
 * Two things can go wrong here that a happy-path test never sees.
 *
 *   1. WHOSE connection it is. The tools reach these routes as the trusted
 *      `_service:mcp` principal and name the person in `X-Droplet-User`. That
 *      header is honoured for that one principal and nobody else, and the
 *      PERSON's own role (not the service's) decides what they may do. A
 *      browser session that sends the header is not impersonating anyone.
 *   2. WHAT comes back. Every row in the double carries a secret-looking value
 *      (a ciphertext, a token inside a vendor error), so a response that
 *      serializes one fails on the value, not on a field name.
 *
 * The family disconnect functions are stubbed: they are tested where they live.
 * What is pinned here is which one is called, for whom, and when it is NOT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { ModuleId } from "@prisma/client";
import { parseConnectCard, parseConnectionDisconnected, parseConnectionsOverview } from "@droplet/shared-types";

const disconnectGoogleMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<void>>());
const disconnectM365Mock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<void>>());
const disconnectMailboxMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<{ removed: boolean; address: string | null }>>());
const deleteSourceMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown>>());
const integrationsDisconnectMock = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown>>());
const recordActivityMock = vi.hoisted(() => vi.fn<(a: Record<string, unknown>) => Promise<undefined>>(async () => undefined));
const logged = vi.hoisted(() => ({ lines: [] as Array<{ level: string; args: unknown[] }> }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { config: { ...actual.config, DROPLET_LAN_HOSTNAME: "box.customer.com" } };
});
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
// Every logger records what it was asked to write, so the route's failure logging can be inspected.
vi.mock("../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/logger.js")>();
  const fakeLogger = (): unknown =>
    new Proxy({}, { get: (_target, level: string) => (level === "child" ? fakeLogger : (...args: unknown[]) => { logged.lines.push({ level, args }); }) });
  return { ...actual, createLogger: () => fakeLogger() as never };
});
vi.mock("../middleware/rate-limit.js", () => ({
  standardRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  sensitiveRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../services/google/google-auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/google/google-auth.service.js")>()),
  disconnectGoogle: disconnectGoogleMock,
}));
vi.mock("../services/m365/m365-auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/m365/m365-auth.service.js")>()),
  disconnect: disconnectM365Mock,
}));
vi.mock("../services/email/provision.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/email/provision.service.js")>()),
  disconnectMailbox: disconnectMailboxMock,
}));
vi.mock("../services/calendar.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/calendar.service.js")>()),
  deleteSource: deleteSourceMock,
}));
vi.mock("../services/integrations.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/integrations.service.js")>()),
  createIntegrationsService: () => ({ disconnect: integrationsDisconnectMock }),
}));

import { config } from "../config.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { mountModuleGates } from "../modules/module-mounts.js";
import { MODULES } from "../modules/module-registry.js";
import { ErpError } from "../services/erp-error.js";
import { createConnectionsRouter } from "./connections.js";
import {
  SECRET_CIPHERTEXT,
  SECRET_PASSWORD,
  SECRET_TOKEN,
  VENDOR_ERROR,
  cursorRow,
  fakeConnectionsDb,
  googleRow,
  integrationRow,
  m365Row,
  mailboxRow,
  sourceRow,
  userRow,
} from "../__tests__/helpers/fake-connections-db.js";

// ── world ────────────────────────────────────────────────────────────────

const ADA = userRow({ id: "u-ada", username: "ada", role: "owner" });
const BO = userRow({ id: "u-bo", username: "bo", role: "admin" });
const GRACE = userRow({ id: "u-grace", username: "grace", role: "family" });
const GUS = userRow({ id: "u-gus", username: "gus", role: "guest" });
const GONE = userRow({ id: "u-gone", username: "gone", role: "owner", directoryStatus: "DEACTIVATED" });
/** Shares a Nextcloud handle with ADA's username: "ada" now names two people. */
const CLASH = userRow({ id: "u-clash", username: "clash", nextcloudUsername: "twin", role: "owner" });
const TWIN = userRow({ id: "u-twin", username: "twin", role: "family" });

const SESSIONS = {
  owner: { id: "u-ada", username: "ada", role: "owner" },
  admin: { id: "u-bo", username: "bo", role: "admin" },
  member: { id: "u-grace", username: "grace", role: "family" },
  guest: { id: "u-gus", username: "gus", role: "guest" },
  // Another service principal: the coarse "service" role is not enough.
  service: { id: "_service:email", username: "email", role: "service" },
  // The one trusted principal.
  mcp: { id: "_service:mcp", username: "mcp", role: "service" },
  // Right id, wrong role: not the pinned principal, so nobody to impersonate for.
  fakeMcp: { id: "_service:mcp", username: "mcp", role: "owner" },
} as const;
type Who = keyof typeof SESSIONS;

type Seed = Parameters<typeof fakeConnectionsDb>[0];

const APP = { clientId: "app-client-id" };

function setup(who: Who | null, seed: Seed = {}, disabled: ModuleId[] = []) {
  const fake = fakeConnectionsDb({ users: [ADA, BO, GRACE, GUS, GONE, CLASH, TWIN], ...seed });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (who) (req as unknown as { user: unknown }).user = { ...SESSIONS[who] };
    next();
  });
  if (disabled.length > 0) {
    // The same registry-driven gate composition app.ts uses. Feature reads
    // stay blocked while the independent connection control plane is mounted.
    const moduleSetting = { findMany: vi.fn(async () => MODULES.map((module) => ({ moduleId: module.id, enabled: !disabled.includes(module.id) }))) };
    Object.assign(fake.db, { moduleSetting });
    mountModuleGates(app, createModuleGate(fake.prisma, { ...config, SERVICE_TOKEN_EMAIL: "test-email-service" }, 0));
    app.get("/api/calendar/sources", (_req, res) => res.json({ sources: [] }));
    app.get("/api/email/accounts", (_req, res) => res.json({ accounts: [] }));
  }
  app.use("/api", createConnectionsRouter(fake.prisma, { card: { getGoogleApp: async () => APP, getMicrosoftApp: async () => APP } }));
  return { app, ...fake };
}

/** What the tools send: the pinned principal, naming a person. */
const asAssistant = (call: request.Test, person: string): request.Test => call.set("X-Droplet-User", person);

const SECRET_SHAPES = /gho_|ya29|Enc"|password":"[^"]|token":"[^"]/;

const everything = (): Seed => ({
  google: [googleRow("u-ada", { state: "ERROR" }), googleRow("u-grace")],
  m365: [m365Row("u-ada"), m365Row("u-grace", { accountUpn: "grace@contoso.example" })],
  cursors: [cursorRow("u-ada", "mail", "FAILED")],
  mailboxes: [mailboxRow({ id: "mbx-1", imapStatus: "error" })],
  sources: [sourceRow("ada", { id: "src-ada", lastSyncError: VENDOR_ERROR }), sourceRow("grace", { id: "src-grace", name: "Grace's feed" })],
  integrations: [integrationRow("stripe", "ERROR"), integrationRow("hubspot", "CONNECTED", { providerTokensEnc: SECRET_CIPHERTEXT })],
});

const mailboxAudits = () => recordActivityMock.mock.calls.map((c) => c[0]).filter((a) => a.what === "Mailbox disconnected");

beforeEach(() => {
  vi.clearAllMocks();
  logged.lines.length = 0;
  disconnectGoogleMock.mockResolvedValue(undefined);
  disconnectM365Mock.mockResolvedValue(undefined);
  disconnectMailboxMock.mockImplementation(async () => ({ removed: true, address: "desk@northgate.example" }));
  deleteSourceMock.mockResolvedValue(undefined);
  integrationsDisconnectMock.mockResolvedValue({});
  recordActivityMock.mockResolvedValue(undefined);
});
afterEach(() => {
  config.DROPLET_LAN_HOSTNAME = "box.customer.com";
});

// ── GET /api/connections ─────────────────────────────────────────────────

describe("GET /api/connections", () => {
  it("answers an owner with every family, as an overview the dashboard parser accepts, and no-store", async () => {
    const { app } = setup("owner", everything());
    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(parseConnectionsOverview(res.body)).toEqual(res.body);
    expect(res.body.boxWideVisible).toBe(true);
    expect(res.body.connected.map((r: { id: string }) => r.id).sort()).toEqual(
      ["calendar:src-ada", "google:me", "integration:hubspot", "integration:stripe", "m365:me", "mailbox:mbx-1"].sort(),
    );
    // The ERROR / FAILED / failed-sync rows count as needing a person.
    expect(res.body.counts.needsAttention).toBe(5);
  });

  it("answers a member with their own connections only", async () => {
    const { app } = setup("member", everything());
    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body.boxWideVisible).toBe(false);
    expect(res.body.connected.map((r: { id: string }) => r.id).sort()).toEqual(["calendar:src-grace", "google:me", "m365:me"]);
    expect(JSON.stringify(res.body)).not.toMatch(/desk@northgate|Stripe|HubSpot|ada@|Personal iCloud/);
    expect(JSON.stringify(res.body)).toContain("grace@contoso.example");
  });

  it("answers a guest with an empty overview, not an error", async () => {
    const { app } = setup("guest", everything());
    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "connections_overview", connected: [], available: [], counts: { connected: 0, needsAttention: 0, available: 0 }, boxWideVisible: false });
  });

  it.each([["service"], ["anon"]])("refuses %s", async (who) => {
    const { app } = setup(who === "anon" ? null : (who as Who), everything());
    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(403);
    expect(res.body.connected).toBeUndefined();
  });

  it("returns no token, key, ciphertext, password or vendor error", async () => {
    for (const who of ["owner", "member"] as const) {
      const { app } = setup(who, everything());
      const text = (await request(app).get("/api/connections")).text;
      expect(text).not.toMatch(SECRET_SHAPES);
      for (const secret of [SECRET_TOKEN, SECRET_CIPHERTEXT, SECRET_PASSWORD, "invalid_grant", "NORTHGATE-frontdesk"]) expect(text).not.toContain(secret);
    }
  });

  it("answers 503 with a fixed body when the database is down, never the error", async () => {
    const { app, db } = setup("owner", everything());
    db.googleConnection.findUnique.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${SECRET_TOKEN}`));
    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "connections_unavailable" });
    expect(res.text).not.toContain(SECRET_TOKEN);
  });
});

// ── Whose connection it is ───────────────────────────────────────────────

describe("X-Droplet-User", () => {
  it("is honoured for the pinned MCP principal: by username and by id", async () => {
    const { app } = setup("mcp", everything());
    for (const person of ["ada", "u-ada"]) {
      const res = await asAssistant(request(app).get("/api/connections"), person);
      expect(res.status, person).toBe(200);
      expect(res.body.boxWideVisible).toBe(true);
      expect(res.body.connected.some((r: { id: string }) => r.id === "mailbox:mbx-1")).toBe(true);
    }
  });

  it("makes the PERSON's role the bound, not the service's: an assistant acting for a member sees what a member sees", async () => {
    const { app } = setup("mcp", everything());
    const res = await asAssistant(request(app).get("/api/connections"), "grace");
    expect(res.status).toBe(200);
    expect(res.body.boxWideVisible).toBe(false);
    expect(res.body.connected.map((r: { id: string }) => r.id).sort()).toEqual(["calendar:src-grace", "google:me", "m365:me"]);
  });

  it("an assistant acting for a guest gets the guest's empty overview", async () => {
    const { app } = setup("mcp", everything());
    const res = await asAssistant(request(app).get("/api/connections"), "gus");
    expect(res.status).toBe(200);
    expect(res.body.connected).toEqual([]);
  });

  it("fails closed: no header, nobody, two people, or a deactivated person", async () => {
    const { app } = setup("mcp", everything());
    const none = await request(app).get("/api/connections");
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: "x_droplet_user_required" });
    for (const person of ["nobody-by-that-name", "   ", "gone"]) {
      const res = await asAssistant(request(app).get("/api/connections"), person);
      expect([401, 403], person).toContain(res.status);
      expect(res.body.connected, person).toBeUndefined();
    }
    // "twin" is CLASH's Nextcloud handle AND TWIN's username.
    const ambiguous = await asAssistant(request(app).get("/api/connections"), "twin");
    expect(ambiguous.status).toBe(403);
    expect(ambiguous.body).toEqual({ error: "acting_user_unavailable" });
  });

  it("is IGNORED for a browser owner: the session's own identity rules", async () => {
    const { app } = setup("owner", everything());
    // An owner "asserting" a member is still the owner: box-wide rows and ada's own Google, not grace's.
    const res = await asAssistant(request(app).get("/api/connections"), "grace");
    expect(res.status).toBe(200);
    expect(res.body.boxWideVisible).toBe(true);
    expect(res.body.connected.map((r: { id: string }) => r.id)).toContain("mailbox:mbx-1");
    expect(JSON.stringify(res.body)).not.toContain("grace@contoso.example");
    expect(res.body.connected.find((r: { id: string }) => r.id === "google:me").status).toBe("needs_attention"); // ada's ERROR grant, not grace's
  });

  it("is IGNORED for a member: asserting an owner does not widen what they see", async () => {
    const { app } = setup("member", everything());
    for (const header of ["ada", "u-ada", "bo"]) {
      const res = await asAssistant(request(app).get("/api/connections"), header);
      expect(res.status, header).toBe(200);
      expect(res.body.boxWideVisible, header).toBe(false);
      expect(res.body.connected.some((r: { scope: string }) => r.scope === "box"), header).toBe(false);
    }
  });

  it("is IGNORED by a principal that has the MCP id without the service role", async () => {
    const { app } = setup("fakeMcp", everything());
    const res = await asAssistant(request(app).get("/api/connections"), "grace");
    expect(res.status).toBe(200);
    // Acts as itself: an id nobody owns, so no Google row and no calendar feeds, and certainly not grace's.
    expect(JSON.stringify(res.body)).not.toContain("grace@contoso.example");
    expect(res.body.connected.some((r: { family: string }) => r.family === "google")).toBe(false);
  });

  it("does not turn another service principal into the MCP principal", async () => {
    const { app } = setup("service", everything());
    const res = await asAssistant(request(app).get("/api/connections"), "ada");
    expect(res.status).toBe(403);
  });
});

// ── GET /api/connections/card ────────────────────────────────────────────

describe("GET /api/connections/card", () => {
  it("400s on an empty, missing, blank, repeated or over-long q", async () => {
    const { app } = setup("owner");
    for (const url of ["/api/connections/card", "/api/connections/card?q=", "/api/connections/card?q=%20%20", "/api/connections/card?q=a&q=b", `/api/connections/card?q=${"a".repeat(121)}`]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(400);
      expect(res.body).toEqual({ error: "invalid_request" });
    }
  });

  it("404s on a provider it does not know, with close matches to offer", async () => {
    const { app } = setup("owner");
    const res = await request(app).get("/api/connections/card").query({ q: "stri" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_provider");
    expect(res.body.suggestions).toContainEqual({ provider: "stripe", displayName: "Stripe" });
  });

  it("404s on garbage with the four connections anyone can ask for", async () => {
    const { app } = setup("owner");
    const res = await request(app).get("/api/connections/card").query({ q: "frobnicate the gizmo" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "unknown_provider",
      suggestions: [
        { provider: "google", displayName: "Google" },
        { provider: "m365", displayName: "Microsoft 365" },
        { provider: "mailbox", displayName: "Mailbox" },
        { provider: "calendar", displayName: "Calendar feed" },
      ],
    });
  });

  it("answers a catalog provider with a card the dashboard parser returns unchanged", async () => {
    const { app } = setup("owner");
    const res = await request(app).get("/api/connections/card").query({ q: "Stripe" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.card).toMatchObject({ mode: "credentials", provider: "stripe", post: { path: "/api/integrations/stripe/connect" } });
    expect(parseConnectCard(res.body.card)).toEqual(res.body.card);
    expect(Object.keys(res.body)).toEqual(["card"]);
  });

  it.each([
    ["gmail", "google", "oauth"],
    ["outlook", "m365", "oauth"],
    ["our mail server", "mailbox", "mailbox"],
    ["caldav", "calendar", "calendar"],
    ["eaglesoft", "eaglesoft", "wizard"],
    ["qbo", "quickbooks-online", "credentials"],
  ])("resolves %j to a %s card", async (q, provider, mode) => {
    const { app } = setup("owner");
    const res = await request(app).get("/api/connections/card").query({ q });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ provider, mode });
    expect(parseConnectCard(res.body.card)).toEqual(res.body.card);
  });

  it("tells a member a box-wide connection is an owner's or admin's to add, in the contract's words", async () => {
    const { app } = setup("member");
    const res = await request(app).get("/api/connections/card").query({ q: "stripe" });
    expect(res.status).toBe(200);
    expect(res.body.card.blocked).toEqual({
      reason: "role",
      message: "Only owners and admins can add box-wide connections like Stripe. You can still connect your own Google or Microsoft 365 account.",
      requiredRole: "admin",
    });
  });

  it("refuses a guest outright", async () => {
    const { app } = setup("guest");
    expect((await request(app).get("/api/connections/card").query({ q: "stripe" })).status).toBe(403);
  });

  it("says a connection that stands is already connected", async () => {
    const { app } = setup("owner", { integrations: [integrationRow("stripe", "CONNECTED")], google: [googleRow("u-ada")] });
    const stripe = await request(app).get("/api/connections/card").query({ q: "stripe" });
    expect(stripe.body.card.blocked.reason).toBe("already_connected");
    const google = await request(app).get("/api/connections/card").query({ q: "google" });
    expect(google.body.card.blocked.reason).toBe("already_connected");
    expect(google.body.card.blocked.message).toContain("person@gmail.com");
  });

  it("judges Google by the callback this box would really give it", async () => {
    const { app } = setup("owner");
    const open = await request(app).get("/api/connections/card").query({ q: "google" });
    expect(open.body.card.blocked).toBeUndefined();
    config.DROPLET_LAN_HOSTNAME = "droplet-ai.lan";
    const lan = await request(app).get("/api/connections/card").query({ q: "google" });
    expect(lan.body.card.blocked).toMatchObject({ reason: "setup_required", requiredRole: "owner" });
    expect(lan.body.card.blocked.message).toMatch(/HTTPS address/);
  });

  it("acts for the person the assistant names, and that person's role decides", async () => {
    const { app } = setup("mcp");
    const owner = await asAssistant(request(app).get("/api/connections/card").query({ q: "stripe" }), "ada");
    expect(owner.body.card.blocked).toBeUndefined();
    const member = await asAssistant(request(app).get("/api/connections/card").query({ q: "stripe" }), "grace");
    expect(member.body.card.blocked.reason).toBe("role");
    expect((await asAssistant(request(app).get("/api/connections/card").query({ q: "stripe" }), "gus")).status).toBe(403);
    expect((await request(app).get("/api/connections/card").query({ q: "stripe" })).status).toBe(401);
  });

  it("ignores X-Droplet-User from a browser session", async () => {
    const { app } = setup("member");
    const res = await asAssistant(request(app).get("/api/connections/card").query({ q: "stripe" }), "ada");
    expect(res.body.card.blocked.reason).toBe("role");
  });

  it("returns no secret, whatever state the box is in", async () => {
    const { app } = setup("owner", everything());
    for (const q of ["stripe", "hubspot", "google", "m365", "mailbox", "calendar", "eaglesoft", "xero", "quickbooks"]) {
      const res = await request(app).get("/api/connections/card").query({ q });
      expect(res.status, q).toBe(200);
      expect(res.text, q).not.toMatch(SECRET_SHAPES);
      for (const secret of [SECRET_TOKEN, SECRET_CIPHERTEXT, SECRET_PASSWORD, "invalid_grant"]) expect(res.text, q).not.toContain(secret);
    }
  });

  it("writes nothing and calls no disconnect", async () => {
    const { app } = setup("owner", everything());
    await request(app).get("/api/connections/card").query({ q: "stripe" });
    expect(disconnectGoogleMock).not.toHaveBeenCalled();
    expect(integrationsDisconnectMock).not.toHaveBeenCalled();
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });
});

// ── POST /api/connections/disconnect ─────────────────────────────────────

describe("POST /api/connections/disconnect: the body", () => {
  it.each([
    ["nothing", {}],
    ["both id and provider", { id: "google:me", provider: "google" }],
    ["an unknown key", { id: "google:me", force: true }],
    ["an empty id", { id: "" }],
    ["a non-string id", { id: 7 }],
    ["an over-long provider", { provider: "a".repeat(121) }],
  ])("400s on %s", async (_label, body) => {
    const { app } = setup("owner", everything());
    const res = await request(app).post("/api/connections/disconnect").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
    expect(disconnectGoogleMock).not.toHaveBeenCalled();
  });

  it.each(["nonsense", "google:other", "m365:you", "ftp:thing", "calendar:../x", "mailbox:a b", "integration:Not Valid", ":me", "google:"])("400s on the row id %j", async (id) => {
    const { app } = setup("owner", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ id });
    expect(res.status).toBe(400);
  });

  it("404s on a provider it cannot place, with something to offer", async () => {
    const { app } = setup("owner", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ provider: "frobnicate" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_provider");
    expect(res.body.suggestions.length).toBeGreaterThan(0);
  });

  it("refuses a guest, and an unauthenticated or other-service caller", async () => {
    for (const who of ["guest", "service", null] as const) {
      const { app } = setup(who, everything());
      expect((await request(app).post("/api/connections/disconnect").send({ id: "google:me" })).status).toBe(403);
    }
    expect(disconnectGoogleMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/connections/disconnect: Google and Microsoft 365", () => {
  it("404s on Google when nothing is connected, and calls nothing", async () => {
    const { app } = setup("owner", { google: [googleRow("u-ada", { state: "DISCONNECTED" })] });
    const res = await request(app).post("/api/connections/disconnect").send({ id: "google:me" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "connection_not_found" });
    expect(disconnectGoogleMock).not.toHaveBeenCalled();
    const none = setup("owner");
    expect((await request(none.app).post("/api/connections/disconnect").send({ provider: "gmail" })).status).toBe(404);
  });

  it("calls the Google disconnect for the person themself", async () => {
    const { app, prisma } = setup("owner", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ id: "google:me" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: { kind: "connection_disconnected", provider: "google", family: "google", displayName: "Google" } });
    expect(parseConnectionDisconnected(res.body.disconnected)).toEqual(res.body.disconnected);
    expect(disconnectGoogleMock).toHaveBeenCalledOnce();
    expect(disconnectGoogleMock).toHaveBeenCalledWith(prisma, "u-ada", expect.anything());
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("resolves a name to the same thing", async () => {
    const { app } = setup("member", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ provider: "Gmail" });
    expect(res.status).toBe(200);
    expect(disconnectGoogleMock).toHaveBeenCalledWith(expect.anything(), "u-grace", expect.anything());
  });

  it("never disconnects anyone but the requester, whatever the header says", async () => {
    const { app } = setup("owner", everything());
    await asAssistant(request(app).post("/api/connections/disconnect"), "grace").send({ id: "google:me" });
    expect(disconnectGoogleMock).toHaveBeenCalledWith(expect.anything(), "u-ada", expect.anything());
    expect(disconnectGoogleMock).not.toHaveBeenCalledWith(expect.anything(), "u-grace", expect.anything());
  });

  it("calls the Microsoft 365 disconnect, and 404s when there is nothing to disconnect", async () => {
    const { app, prisma } = setup("member", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ id: "m365:me" });
    expect(res.status).toBe(200);
    expect(res.body.disconnected).toEqual({ kind: "connection_disconnected", provider: "m365", family: "m365", displayName: "Microsoft 365" });
    expect(disconnectM365Mock).toHaveBeenCalledWith(prisma, "u-grace");
    const none = setup("owner", { m365: [m365Row("u-ada", { state: "DISCONNECTED" })] });
    expect((await request(none.app).post("/api/connections/disconnect").send({ id: "m365:me" })).status).toBe(404);
    expect(disconnectM365Mock).toHaveBeenCalledOnce();
  });

  it("an assistant acting for a member disconnects that member's own account", async () => {
    const { app } = setup("mcp", everything());
    const res = await asAssistant(request(app).post("/api/connections/disconnect"), "grace").send({ id: "google:me" });
    expect(res.status).toBe(200);
    expect(disconnectGoogleMock).toHaveBeenCalledWith(expect.anything(), "u-grace", expect.anything());
  });
});

describe("POST /api/connections/disconnect: box-wide connections", () => {
  it.each([
    ["a mailbox by id", { id: "mailbox:mbx-1" }],
    ["a mailbox by name", { provider: "our mail server" }],
    ["a catalog provider by id", { id: "integration:stripe" }],
    ["a catalog provider by name", { provider: "stripe" }],
  ])("403s a member disconnecting %s, and touches nothing", async (_label, body) => {
    const { app } = setup("member", everything());
    const res = await request(app).post("/api/connections/disconnect").send(body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
    expect(disconnectMailboxMock).not.toHaveBeenCalled();
    expect(integrationsDisconnectMock).not.toHaveBeenCalled();
  });

  it("403s an assistant acting for a member in the same way: the person's role is the bound", async () => {
    const { app } = setup("mcp", everything());
    const res = await asAssistant(request(app).post("/api/connections/disconnect"), "grace").send({ id: "integration:stripe" });
    expect(res.status).toBe(403);
    expect(integrationsDisconnectMock).not.toHaveBeenCalled();
  });

  it("403s a browser member who sends an owner's name in the header", async () => {
    const { app } = setup("member", everything());
    const res = await asAssistant(request(app).post("/api/connections/disconnect"), "ada").send({ id: "mailbox:mbx-1" });
    expect(res.status).toBe(403);
    expect(disconnectMailboxMock).not.toHaveBeenCalled();
  });

  describe("a mailbox", () => {
    it.each([["owner"], ["admin"]] as const)("is removed by an %s, with an audit row naming the address", async (who) => {
      const { app, prisma } = setup(who, everything());
      const res = await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" });
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toEqual({ kind: "connection_disconnected", provider: "mailbox", family: "mailbox", displayName: "desk@northgate.example" });
      expect(disconnectMailboxMock).toHaveBeenCalledWith(prisma, "mbx-1");
      const [audit] = mailboxAudits();
      expect(audit).toMatchObject({ kind: "email", severity: "warn", sub: "desk@northgate.example", refs: { accountId: "mbx-1", address: "desk@northgate.example" }, actor: { type: "user", id: SESSIONS[who].id } });
      expect(JSON.stringify(audit)).not.toMatch(SECRET_SHAPES);
    });

    it("is attributed to the assistant when the assistant removed it for the person", async () => {
      const { app } = setup("mcp", everything());
      const res = await asAssistant(request(app).post("/api/connections/disconnect"), "ada").send({ id: "mailbox:mbx-1" });
      expect(res.status).toBe(200);
      expect(mailboxAudits()[0]).toMatchObject({ actor: { type: "ai", id: "u-ada" } });
    });

    it("by name finds the only mailbox, refuses to guess between two, and 404s on none", async () => {
      const one = setup("owner", { mailboxes: [mailboxRow({ id: "only" })] });
      expect((await request(one.app).post("/api/connections/disconnect").send({ provider: "imap" })).status).toBe(200);
      expect(disconnectMailboxMock).toHaveBeenLastCalledWith(one.prisma, "only");
      disconnectMailboxMock.mockClear();
      const two = setup("owner", { mailboxes: [mailboxRow({ id: "a", address: "a@x.example" }), mailboxRow({ id: "b", address: "b@x.example" })] });
      const ambiguous = await request(two.app).post("/api/connections/disconnect").send({ provider: "mailbox" });
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body).toEqual({ error: "ambiguous_connection" });
      const none = setup("owner");
      expect((await request(none.app).post("/api/connections/disconnect").send({ provider: "mailbox" })).status).toBe(404);
      expect(disconnectMailboxMock).not.toHaveBeenCalled();
    });

    it("leaves a Google or Microsoft mailbox to its own account, and 404s on an id that is not there", async () => {
      const { app } = setup("owner", { mailboxes: [mailboxRow({ id: "gm", authMode: "GOOGLE_OAUTH", address: "g@gmail.com" }), mailboxRow({ id: "mm", authMode: "M365_GRAPH", address: "m@contoso.example" })] });
      for (const id of ["mailbox:gm", "mailbox:mm", "mailbox:missing"]) {
        expect((await request(app).post("/api/connections/disconnect").send({ id })).status, id).toBe(404);
      }
      expect(disconnectMailboxMock).not.toHaveBeenCalled();
    });

    it("404s when the mailbox was already gone, and writes no audit row", async () => {
      disconnectMailboxMock.mockResolvedValueOnce({ removed: false, address: null });
      const { app } = setup("owner", everything());
      const res = await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" });
      expect(res.status).toBe(404);
      expect(mailboxAudits()).toHaveLength(0);
    });

    it("does not report a false failure when only the audit write fails", async () => {
      recordActivityMock.mockRejectedValueOnce(new Error("audit store down"));
      const { app } = setup("owner", everything());
      const res = await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" });
      expect(res.status).toBe(200);
      expect(disconnectMailboxMock).toHaveBeenCalledOnce();
    });
  });

  describe("a catalog provider", () => {
    it("is disconnected with the records KEPT (tokens purged, landed data stays)", async () => {
      const { app } = setup("owner", everything());
      const res = await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toEqual({ kind: "connection_disconnected", provider: "stripe", family: "integration", displayName: "Stripe" });
      expect(integrationsDisconnectMock).toHaveBeenCalledOnce();
      expect(integrationsDisconnectMock).toHaveBeenCalledWith({ actor: "u-ada" }, "stripe", { records: "keep" });
    });

    it("works by name, for an admin, and for an assistant acting for an owner", async () => {
      const admin = setup("admin", everything());
      expect((await request(admin.app).post("/api/connections/disconnect").send({ provider: "HubSpot" })).status).toBe(200);
      expect(integrationsDisconnectMock).toHaveBeenLastCalledWith({ actor: "u-bo" }, "hubspot", { records: "keep" });
      const mcp = setup("mcp", everything());
      expect((await asAssistant(request(mcp.app).post("/api/connections/disconnect"), "u-ada").send({ id: "integration:stripe" })).status).toBe(200);
      expect(integrationsDisconnectMock).toHaveBeenLastCalledWith({ actor: "u-ada" }, "stripe", { records: "keep" });
    });

    it("404s when there is no row, or its credentials are already purged", async () => {
      const { app } = setup("owner", { integrations: [integrationRow("hubspot", "DISABLED", { apiCredentialsEnc: null, providerTokensEnc: null })] });
      for (const id of ["integration:stripe", "integration:hubspot", "integration:not-a-provider"]) {
        const res = await request(app).post("/api/connections/disconnect").send({ id });
        expect(res.status, id).toBe(404);
        expect(res.body).toEqual({ error: "connection_not_found" });
      }
      expect(integrationsDisconnectMock).not.toHaveBeenCalled();
    });

    it("still disconnects a paused connection that holds a key", async () => {
      const { app } = setup("owner", { integrations: [integrationRow("stripe", "DISABLED")] });
      expect((await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" })).status).toBe(200);
    });

    it("maps a refusal from the service to its own status, a lost race to 409, and anything else to a fixed 503", async () => {
      const { app } = setup("owner", everything());
      integrationsDisconnectMock.mockRejectedValueOnce(new ErpError("NOT_FOUND", "no such connection"));
      const typed = await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
      expect(typed.status).toBe(404);
      integrationsDisconnectMock.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));
      const raced = await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
      expect(raced.status).toBe(409);
      expect(raced.body).toEqual({ error: "concurrent_mutation" });
      integrationsDisconnectMock.mockRejectedValueOnce(new Error(`vendor said: ${VENDOR_ERROR}`));
      const broken = await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
      expect(broken.status).toBe(503);
      expect(broken.body).toEqual({ error: "disconnect_failed" });
      expect(broken.text).not.toContain(SECRET_TOKEN);
    });
  });
});

describe("POST /api/connections/disconnect: calendar feeds", () => {
  it("lets a member remove their own feed, by id", async () => {
    const { app, prisma } = setup("member", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-grace" });
    expect(res.status).toBe(200);
    expect(res.body.disconnected).toEqual({ kind: "connection_disconnected", provider: "calendar", family: "calendar", displayName: "Grace's feed" });
    expect(deleteSourceMock).toHaveBeenCalledWith(prisma, "grace", "src-grace");
  });

  it("404s on someone else's feed, and does not delete it: not even an owner may remove a personal row that is not theirs", async () => {
    const { app } = setup("owner", everything());
    const res = await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-grace" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "connection_not_found" });
    expect(deleteSourceMock).not.toHaveBeenCalled();
    const member = setup("member", everything());
    expect((await request(member.app).post("/api/connections/disconnect").send({ id: "calendar:src-ada" })).status).toBe(404);
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("404s on a Google or Microsoft calendar: those go with their account", async () => {
    const { app } = setup("owner", { sources: [sourceRow("ada", { id: "g-cal", authMode: "google_oauth" }), sourceRow("ada", { id: "m-cal", authMode: "m365_oauth" })] });
    for (const id of ["calendar:g-cal", "calendar:m-cal", "calendar:missing"]) {
      expect((await request(app).post("/api/connections/disconnect").send({ id })).status, id).toBe(404);
    }
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("by name finds the only feed, and refuses to guess between two", async () => {
    const one = setup("member", { sources: [sourceRow("grace", { id: "only" })] });
    expect((await request(one.app).post("/api/connections/disconnect").send({ provider: "caldav" })).status).toBe(200);
    expect(deleteSourceMock).toHaveBeenLastCalledWith(one.prisma, "grace", "only");
    deleteSourceMock.mockClear();
    const two = setup("member", { sources: [sourceRow("grace", { id: "a" }), sourceRow("grace", { id: "b" }), sourceRow("ada", { id: "not-hers" })] });
    const res = await request(two.app).post("/api/connections/disconnect").send({ provider: "calendar feed" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "ambiguous_connection" });
    const none = setup("member", { sources: [sourceRow("ada", { id: "not-hers" })] });
    expect((await request(none.app).post("/api/connections/disconnect").send({ provider: "ics" })).status).toBe(404);
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("reads a vanished feed as 'not found', and a real failure as a fixed 503", async () => {
    const { app } = setup("member", everything());
    deleteSourceMock.mockRejectedValueOnce(new Error("source_not_found"));
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-grace" })).status).toBe(404);
    deleteSourceMock.mockRejectedValueOnce(new Error(`db: ${SECRET_CIPHERTEXT}`));
    const broken = await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-grace" });
    expect(broken.status).toBe(503);
    expect(broken.text).not.toContain(SECRET_CIPHERTEXT);
  });

  it("an assistant acting for a member removes that member's feed and nobody else's", async () => {
    const { app } = setup("mcp", everything());
    expect((await asAssistant(request(app).post("/api/connections/disconnect"), "grace").send({ id: "calendar:src-grace" })).status).toBe(200);
    expect(deleteSourceMock).toHaveBeenCalledWith(expect.anything(), "grace", "src-grace");
    deleteSourceMock.mockClear();
    expect((await asAssistant(request(app).post("/api/connections/disconnect"), "grace").send({ id: "calendar:src-ada" })).status).toBe(404);
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });
});

describe("responses never carry a secret", () => {
  it("not on success, not on refusal", async () => {
    const cases: Array<[Who, Record<string, unknown>]> = [
      ["owner", { id: "google:me" }],
      ["owner", { id: "mailbox:mbx-1" }],
      ["owner", { id: "integration:stripe" }],
      ["owner", { id: "calendar:src-ada" }],
      ["member", { id: "integration:stripe" }],
      ["owner", { id: "calendar:src-grace" }],
    ];
    for (const [who, body] of cases) {
      const { app } = setup(who, everything());
      const res = await request(app).post("/api/connections/disconnect").send(body);
      expect(res.text, JSON.stringify(body)).not.toMatch(SECRET_SHAPES);
      for (const secret of [SECRET_TOKEN, SECRET_CIPHERTEXT, SECRET_PASSWORD, "invalid_grant"]) expect(res.text).not.toContain(secret);
    }
  });
});

// ── A module being off does not strand a person's connections ────────────

describe("connection cleanup while a module is off", () => {
  it("keeps disabled Calendar reads blocked while members can still revoke only their own feed", async () => {
    const { app, prisma } = setup("member", everything(), ["calendar"]);
    expect((await request(app).get("/api/calendar/sources")).status).toBe(404);
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-grace" })).status).toBe(200);
    expect(deleteSourceMock).toHaveBeenCalledWith(prisma, "grace", "src-grace");
    deleteSourceMock.mockClear();
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:src-ada" })).status).toBe(404);
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("keeps disabled Email reads blocked while shared-mailbox cleanup stays admin-only", async () => {
    const owner = setup("owner", everything(), ["email"]);
    expect((await request(owner.app).get("/api/email/accounts")).status).toBe(404);
    expect((await request(owner.app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" })).status).toBe(200);
    disconnectMailboxMock.mockClear();
    const member = setup("member", everything(), ["email"]);
    expect((await request(member.app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" })).status).toBe(403);
    expect(disconnectMailboxMock).not.toHaveBeenCalled();
  });

  it("still answers the overview and a card with Calendar and Email off", async () => {
    const { app } = setup("owner", everything(), ["calendar", "email"]);
    expect((await request(app).get("/api/connections")).status).toBe(200);
    expect((await request(app).get("/api/connections/card").query({ q: "stripe" })).status).toBe(200);
  });
});

// ── Whose header, once more ──────────────────────────────────────────────

describe("X-Droplet-User and the user directory", () => {
  it("a browser session never reaches the directory lookup for the header", async () => {
    for (const who of ["owner", "member", "fakeMcp"] as const) {
      const { app, db } = setup(who, everything());
      await asAssistant(request(app).get("/api/connections"), "ada");
      expect(db.user.findMany, who).not.toHaveBeenCalled();
      expect(db.user.findFirst, who).not.toHaveBeenCalled();
    }
  });

  it("the pinned principal reaches the directory once per request", async () => {
    const { app, db } = setup("mcp", everything());
    await asAssistant(request(app).get("/api/connections"), "ada");
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
  });
});

// ── What the failures log ────────────────────────────────────────────────

describe("failure logging", () => {
  const written = (): string => JSON.stringify(logged.lines);

  it("an overview that fails logs the error type and nothing the error said", async () => {
    const { app, db } = setup("owner", everything());
    db.googleConnection.findUnique.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${SECRET_TOKEN}`));
    expect((await request(app).get("/api/connections")).status).toBe(503);
    const line = logged.lines.find((l) => l.level === "error");
    expect(line?.args[0]).toEqual({ errorType: "Error" });
    expect(written()).not.toContain(SECRET_TOKEN);
  });

  it("a disconnect that fails logs the error type and nothing the vendor said", async () => {
    const { app } = setup("owner", everything());
    integrationsDisconnectMock.mockRejectedValueOnce(new Error(`vendor said: ${VENDOR_ERROR}`));
    expect((await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" })).status).toBe(503);
    expect(logged.lines.find((l) => l.level === "error")?.args[0]).toEqual({ errorType: "Error" });
    expect(written()).not.toMatch(/invalid_grant|ya29/);
  });

  it("a card that fails logs the provider and the error type only", async () => {
    const { app, db } = setup("owner", everything());
    db.integrationConnection.findFirst.mockRejectedValueOnce(new Error(`db: ${SECRET_CIPHERTEXT}`));
    expect((await request(app).get("/api/connections/card").query({ q: "stripe" })).status).toBe(503);
    expect(logged.lines.find((l) => l.level === "error")?.args[0]).toEqual({ errorType: "Error", provider: "stripe" });
    expect(written()).not.toContain(SECRET_CIPHERTEXT);
  });

  it("a mailbox audit that fails logs a warning with the account id and error type only", async () => {
    recordActivityMock.mockRejectedValueOnce(new Error(`audit: ${SECRET_PASSWORD}`));
    const { app } = setup("owner", everything());
    expect((await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mbx-1" })).status).toBe(200);
    expect(logged.lines.find((l) => l.level === "warn")?.args[0]).toEqual({ errorType: "Error", accountId: "mbx-1" });
    expect(written()).not.toContain(SECRET_PASSWORD);
  });
});

// ── A name that is not one provider ──────────────────────────────────────

describe("GET /api/connections/card: a phrase naming more than one provider", () => {
  it.each(["Stripe and HubSpot", "connect calendar for Stripe", "connect my email to the calendar"])("404s on %j, with safe suggestions and no card", async (q) => {
    const { app } = setup("owner");
    const res = await request(app).get("/api/connections/card").query({ q });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_provider");
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.card).toBeUndefined();
  });
});
