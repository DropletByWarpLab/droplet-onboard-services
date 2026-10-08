import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { ModuleId } from "@prisma/client";
import { config } from "../config.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { mountModuleGates } from "../modules/module-mounts.js";
import { MODULES } from "../modules/module-registry.js";

const services = vi.hoisted(() => ({
  overview: vi.fn(), disconnectIntegration: vi.fn(), deleteCalendar: vi.fn(), disconnectMailbox: vi.fn(), auditMailbox: vi.fn(),
  googleView: vi.fn(), microsoftView: vi.fn(), disconnectGoogle: vi.fn(), disconnectMicrosoft: vi.fn(),
}));
vi.mock("../services/connections-overview.service.js", async (original) => ({ ...await original(), buildConnectionsOverview: services.overview }));
vi.mock("../services/integrations.service.js", () => ({ createIntegrationsService: () => ({ disconnect: services.disconnectIntegration }) }));
vi.mock("../services/calendar.service.js", () => ({ deleteSource: services.deleteCalendar }));
vi.mock("../services/email/provision.service.js", () => ({ disconnectMailbox: services.disconnectMailbox }));
vi.mock("../services/email/mailbox-audit.js", () => ({ auditMailboxDisconnected: services.auditMailbox }));
vi.mock("../services/google/google-auth.service.js", () => ({ getGoogleConnectionView: services.googleView, disconnectGoogle: services.disconnectGoogle, googleDependencies: () => ({}) }));
vi.mock("../services/m365/m365-auth.service.js", () => ({ getConnectionView: services.microsoftView, disconnect: services.disconnectMicrosoft }));
vi.mock("./google.js", () => ({ GOOGLE_CALLBACK_PATH: "/api/google/callback" }));

import { createConnectionsRouter } from "./connections.js";

const owner = { id: "owner-id", username: "owner", role: "owner", directoryStatus: "ACTIVE", displayName: "Owner", email: null };
const family = { ...owner, id: "member-id", username: "member", role: "family" };
const mcp = { id: "_service:mcp", username: "_service:mcp", role: "service" };
function world(person = owner, users = [owner, family], disabled: ModuleId[] = []) {
  const prisma = {
    moduleSetting: { findMany: vi.fn(async () => MODULES.map((module) => ({ moduleId: module.id, enabled: !disabled.includes(module.id) }))) },
    user: { findMany: vi.fn(async ({ where }: { where: { OR: Record<string, string>[] } }) => users.filter((user) => where.OR.some((arm) => Object.entries(arm).every(([key, value]) => user[key as keyof typeof user] === value))).slice(0, 2)) },
    emailAccount: { findMany: vi.fn(async () => [{ id: "mail" }]), findUnique: vi.fn(async () => ({ authMode: "PASSWORD" })) },
    calendarSource: { findMany: vi.fn(async () => [{ id: "feed" }]), findUnique: vi.fn(async () => ({ userId: person.username, authMode: "basic", name: "Personal feed" })) },
    integrationConnection: { findFirst: vi.fn(async () => ({ status: "CONNECTED", apiCredentialsEnc: "ENCRYPTED_SECRET", providerTokensEnc: null })) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = person as never; next(); });
  if (disabled.length) {
    // The same registry-driven gate composition app.ts uses. Feature reads
    // remain blocked while the independent connection control plane is mounted.
    mountModuleGates(app, createModuleGate(prisma as never, { ...config, SERVICE_TOKEN_EMAIL: "test-email-service" }, 0));
    app.get("/api/calendar/sources", (_req, res) => res.json({ sources: [] }));
    app.get("/api/email/accounts", (_req, res) => res.json({ accounts: [] }));
  }
  app.use("/api", createConnectionsRouter(prisma as never));
  return { app, prisma };
}
beforeEach(() => {
  vi.clearAllMocks();
  services.overview.mockResolvedValue({ kind: "connections_overview", connected: [], available: [], counts: { connected: 0, needsAttention: 0, available: 0 }, boxWideVisible: false });
  services.googleView.mockResolvedValue({ state: "CONNECTED" });
  services.microsoftView.mockResolvedValue({ state: "CONNECTED" });
  services.disconnectMailbox.mockResolvedValue({ removed: true, address: "desk" });
  services.auditMailbox.mockResolvedValue(undefined);
});

describe("connections endpoint identity boundary", () => {
  it("browser sessions cannot borrow the MCP acting header", async () => {
    const { app, prisma } = world(family);
    const response = await request(app).get("/api/connections").set("X-Droplet-User", owner.id);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(services.overview).toHaveBeenCalledWith(prisma, { id: family.id, username: family.username, role: "family", viaAssistant: false });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
  it("MCP resolves the canonical human id, username and role", async () => {
    const { app, prisma } = world(mcp as typeof owner);
    expect((await request(app).get("/api/connections").set("X-Droplet-User", family.username)).status).toBe(200);
    expect(services.overview).toHaveBeenCalledWith(prisma, { id: family.id, username: family.username, role: "family", viaAssistant: true });
  });
  it("requires an MCP acting header", async () => {
    expect((await request(world(mcp as typeof owner).app).get("/api/connections")).status).toBe(401);
    expect(services.overview).not.toHaveBeenCalled();
  });
  it.each([
    ["missing", [owner]],
    [owner.id, [{ ...owner, directoryStatus: "DEACTIVATED" }]],
    [owner.id, [owner, { ...family, username: owner.id }]],
  ])("fails closed for unavailable or ambiguous asserted user %s", async (asserted, users) => {
    expect((await request(world(mcp as typeof owner, users).app).get("/api/connections").set("X-Droplet-User", asserted)).status).toBe(403);
    expect(services.overview).not.toHaveBeenCalled();
  });
  it("rejects other service principals", async () => {
    const response = await request(world({ ...owner, id: "_service:other", role: "service" }).app).get("/api/connections").set("X-Droplet-User", owner.id);
    expect(response.status).toBe(403);
  });
});

describe("connection cards and disconnect dispatch", () => {
  it("keeps disabled Calendar reads blocked while members can revoke only their own feed", async () => {
    const { app, prisma } = world(family, [owner, family], ["calendar"]);
    expect((await request(app).get("/api/calendar/sources")).status).toBe(404);
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:feed" })).status).toBe(200);
    expect(services.deleteCalendar).toHaveBeenCalledWith(prisma, family.username, "feed");
    services.deleteCalendar.mockClear();
    prisma.calendarSource.findUnique.mockResolvedValue({ userId: owner.username, authMode: "basic", name: "Owner feed" });
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:other" })).status).toBe(404);
    expect(services.deleteCalendar).not.toHaveBeenCalled();
  });
  it("keeps disabled Email reads blocked while shared-mailbox cleanup remains admin-only", async () => {
    const { app } = world(owner, [owner, family], ["email"]);
    expect((await request(app).get("/api/email/accounts")).status).toBe(404);
    expect((await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mail" })).status).toBe(200);
    services.disconnectMailbox.mockClear();
    expect((await request(world(family, [owner, family], ["email"]).app).post("/api/connections/disconnect").send({ id: "mailbox:mail" })).status).toBe(403);
    expect(services.disconnectMailbox).not.toHaveBeenCalled();
  });
  it("returns an actionable specific provider descriptor", async () => {
    const response = await request(world().app).get("/api/connections/card").query({ q: "connect Stripe" });
    expect(response.status).toBe(200);
    expect(response.body.card).toMatchObject({ kind: "connect_card", provider: "stripe", mode: "credentials" });
    expect(JSON.stringify(response.body)).not.toContain("ENCRYPTED_SECRET");
  });
  it("rejects ambiguous names and gives safe suggestions", async () => {
    const response = await request(world().app).get("/api/connections/card").query({ q: "Stripe and HubSpot" });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("unknown_provider");
    expect(response.body.suggestions.length).toBeGreaterThan(0);
  });
  it.each([{}, { id: "google:me", provider: "google" }, { id: "google:other" }, { id: "calendar:../private" }, { id: "google:me", token: "SECRET" }])("rejects malformed or credential-bearing disconnect input", async (body) => {
    expect((await request(world().app).post("/api/connections/disconnect").send(body)).status).toBe(400);
    expect(services.disconnectGoogle).not.toHaveBeenCalled();
  });
  it.each(["integration:stripe", "mailbox:mail"])("members cannot remove box-wide %s", async (id) => {
    expect((await request(world(family).app).post("/api/connections/disconnect").send({ id })).status).toBe(403);
    expect(services.disconnectIntegration).not.toHaveBeenCalled();
    expect(services.disconnectMailbox).not.toHaveBeenCalled();
  });
  it("MCP cannot widen the resolved member role", async () => {
    const response = await request(world(mcp as typeof owner).app).post("/api/connections/disconnect").set("X-Droplet-User", family.id).send({ id: "integration:stripe" });
    expect(response.status).toBe(403);
  });
  it.each(["google", "m365"])("disconnects only the session's own %s account", async (provider) => {
    const { app, prisma } = world(family);
    const response = await request(app).post("/api/connections/disconnect").set("X-Droplet-User", owner.id).send({ id: `${provider}:me` });
    expect(response.status).toBe(200);
    expect(provider === "google" ? services.disconnectGoogle : services.disconnectMicrosoft).toHaveBeenCalledWith(prisma, family.id, ...(provider === "google" ? [{}] : []));
  });
  it("refuses another person's calendar and OAuth-managed sources", async () => {
    const { app, prisma } = world(family);
    prisma.calendarSource.findUnique.mockResolvedValue({ userId: owner.username, authMode: "basic", name: "Owner feed" });
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:feed" })).status).toBe(404);
    prisma.calendarSource.findUnique.mockResolvedValue({ userId: family.username, authMode: "google_oauth", name: "Google" });
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:feed" })).status).toBe(404);
    expect(services.deleteCalendar).not.toHaveBeenCalled();
  });
  it("uses username ownership for personal calendar deletion", async () => {
    const { app, prisma } = world(family);
    expect((await request(app).post("/api/connections/disconnect").send({ id: "calendar:feed" })).status).toBe(200);
    expect(services.deleteCalendar).toHaveBeenCalledWith(prisma, family.username, "feed");
  });
  it("refuses ambiguous mailbox names instead of removing the first record", async () => {
    const { app, prisma } = world();
    prisma.emailAccount.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    expect((await request(app).post("/api/connections/disconnect").send({ provider: "mailbox" })).status).toBe(409);
    expect(services.disconnectMailbox).not.toHaveBeenCalled();
  });
  it("reports successful mailbox deletion even if follow-up auditing fails", async () => {
    const { app } = world();
    services.auditMailbox.mockRejectedValue(new Error("AUDIT_FAILURE_SECRET"));
    const response = await request(app).post("/api/connections/disconnect").send({ id: "mailbox:mail" });
    expect(response.status).toBe(200);
    expect(response.body.disconnected.displayName).toBe("desk");
    expect(services.auditMailbox).toHaveBeenCalledWith({ actor: { type: "user", id: owner.id }, accountId: "mail", address: "desk" });
  });
  it("delegates catalog removal while retaining landed records", async () => {
    const response = await request(world().app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
    expect(response.status).toBe(200);
    expect(services.disconnectIntegration).toHaveBeenCalledWith({ actor: owner.id }, "stripe", { records: "keep" });
  });
  it("does not retry an already purged catalog connection", async () => {
    const { app, prisma } = world();
    prisma.integrationConnection.findFirst.mockResolvedValue({ status: "DISABLED", apiCredentialsEnc: null as never, providerTokensEnc: null });
    expect((await request(app).post("/api/connections/disconnect").send({ id: "integration:stripe" })).status).toBe(404);
    expect(services.disconnectIntegration).not.toHaveBeenCalled();
  });
  it("returns a fixed disconnect error without vendor details", async () => {
    services.disconnectIntegration.mockRejectedValue(new Error("VENDOR_SECRET"));
    const response = await request(world().app).post("/api/connections/disconnect").send({ id: "integration:stripe" });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "disconnect_failed" });
  });
});
