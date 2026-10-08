import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRegisteredProvidersForTest, parseConnectCard, providerDescriptors, registerProviderDescriptor } from "@droplet/shared-types";

const views = vi.hoisted(() => ({ google: vi.fn(), microsoft: vi.fn() }));
vi.mock("./google/google-auth.service.js", () => ({ getGoogleConnectionView: views.google }));
vi.mock("./m365/m365-auth.service.js", () => ({ getConnectionView: views.microsoft }));
import { buildConnectCard, resolveConnectionProvider } from "./connect-card.service.js";
import { connectInputFor, isCatalogAvailable } from "./connections-overview.service.js";

const owner = { id: "owner-id", username: "owner", role: "owner" };
const family = { id: "member-id", username: "member", role: "family" };
const prisma = { integrationConnection: { findFirst: vi.fn(async () => null) } };
const app = { clientId: "6e261f89-12a7-4dac-a79a-3f345c8e8cce", tenantId: "org.onmicrosoft.com" };
const deps = { getGoogleApp: vi.fn(async (): Promise<unknown> => ({ clientId: "google", clientSecret: "NEVER_IN_CARD" })), getMicrosoftApp: vi.fn(async (): Promise<unknown> => app) };

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegisteredProvidersForTest();
  prisma.integrationConnection.findFirst.mockResolvedValue(null);
  views.google.mockResolvedValue({ state: "DISCONNECTED" });
  views.microsoft.mockResolvedValue({ state: "DISCONNECTED", app: null });
  deps.getMicrosoftApp.mockResolvedValue(app);
  deps.getGoogleApp.mockResolvedValue({ clientId: "google", clientSecret: "NEVER_IN_CARD" });
});

describe("connection provider resolution", () => {
  it.each([
    ["connect my Gmail account", "google"], ["Google Calendar", "google"], ["our mail server", "mailbox"],
    ["Microsoft 365", "m365"], ["link Outlook", "m365"], ["CalDAV", "calendar"], ["QuickBooks", "quickbooks-online"],
    ["Eaglesoft Patterson API", "eaglesoft-api"], ["connect Eaglesoft Patterson API", "eaglesoft-api"], ["Patterson API", "eaglesoft-api"],
  ])("resolves %s", (phrase, provider) => expect(resolveConnectionProvider(phrase)?.provider).toBe(provider));
  it("refuses a phrase naming multiple providers", () => {
    expect(resolveConnectionProvider("connect Stripe and HubSpot")).toBeNull();
    expect(resolveConnectionProvider("connect calendar for Stripe")).toBeNull();
  });
  it("covers every registered descriptor key and display name", () => {
    for (const provider of providerDescriptors()) {
      expect(resolveConnectionProvider(provider.id)?.provider, provider.id).toBe(provider.id);
      expect(resolveConnectionProvider(provider.displayName)?.provider, provider.displayName).toBe(provider.id);
    }
  });
});

describe("connection setup descriptors", () => {
  it.each([
    [" \tReads!\nmail. and events!... \t", "Reads mail. and events"],
    ["Reads mail . \t. .!\n", "Reads mail"],
    [". \t. .!\n", ""],
    [`Reads${".".repeat(100_000)}${"\t".repeat(100_000)}events...`, `Reads${".".repeat(395)}`],
  ])("normalizes a provider summary without rescanning punctuation runs", async (description, expected) => {
    const template = providerDescriptors().find((descriptor) => descriptor.track === "mcp");
    if (!template || template.track !== "mcp") throw new Error("Expected an MCP descriptor fixture");
    registerProviderDescriptor({ ...template, id: "summary-fixture", displayName: "Summary fixture", datasets: [], description });
    const card = await buildConnectCard(prisma as never, owner, { family: "integration", provider: "summary-fixture" }, deps);
    expect(card.summary).toBe(expected);
  });
  it("provides validated setup for every available catalog provider, including MCP", async () => {
    for (const descriptor of providerDescriptors()) {
      const card = await buildConnectCard(prisma as never, owner, { family: "integration", provider: descriptor.id }, deps);
      expect(parseConnectCard(card), descriptor.id).not.toBeNull();
      if (isCatalogAvailable(descriptor) && connectInputFor(descriptor)) expect(card.blocked, descriptor.id).toBeUndefined();
      else expect(card.blocked?.reason, descriptor.id).toBe("unavailable");
      if (descriptor.track === "mcp" && isCatalogAvailable(descriptor)) {
        expect(card.mode).toBe("wizard");
        expect(card).toMatchObject({ wizardHref: "/integrations/credentials" });
      }
      if (card.mode === "credentials") {
        for (const field of [...card.fields, ...card.variants?.flatMap((variant) => variant.fields) ?? []]) {
          if (field.secret) expect(field).not.toHaveProperty("defaultValue");
        }
      }
    }
  });
  it("blocks box-wide cards for members before querying a connection", async () => {
    for (const target of [{ family: "mailbox", provider: "mailbox" }, { family: "integration", provider: "stripe" }] as const) {
      expect((await buildConnectCard(prisma as never, family, target, deps)).blocked?.reason).toBe("role");
    }
    expect(prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });
  it("keeps Patterson API setup distinct from SQL provisioning", async () => {
    const card = await buildConnectCard(prisma as never, owner, { family: "integration", provider: "eaglesoft-api" }, deps);
    expect(card.mode).toBe("wizard");
    if (card.mode !== "wizard") throw new Error("Expected API wizard metadata");
    expect(card.steps.join(" ")).toMatch(/Patterson integration key/);
    expect(card.steps.join(" ")).toMatch(/route map/);
    expect(card.steps.join(" ")).not.toMatch(/database account|SQL/);
  });
  it("permits members' own OAuth accounts and never returns an app secret", async () => {
    for (const provider of ["google", "m365"] as const) {
      const card = await buildConnectCard(prisma as never, family, { family: provider, provider }, deps);
      expect(card.blocked).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain("NEVER_IN_CARD");
    }
    expect(views.google).toHaveBeenCalledWith(prisma, family.id);
    expect(views.microsoft).toHaveBeenCalledWith(prisma, family.id);
  });
  it("requires owner setup for missing or invalid app registrations and unsupported Google callback", async () => {
    deps.getMicrosoftApp.mockResolvedValue(undefined);
    views.microsoft.mockResolvedValue({ state: "DISCONNECTED", app: { clientId: "invalid", tenantId: "common" } });
    expect((await buildConnectCard(prisma as never, family, { family: "m365", provider: "m365" }, deps)).blocked?.reason).toBe("setup_required");
    expect((await buildConnectCard(prisma as never, family, { family: "google", provider: "google" }, { ...deps, googleRedirectUri: "http://droplet.lan/api/google/callback" })).blocked?.reason).toBe("setup_required");
  });
  it("does not offer to overwrite a standing connection", async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue({ status: "CONNECTED" } as never);
    expect((await buildConnectCard(prisma as never, owner, { family: "integration", provider: "stripe" }, deps)).blocked?.reason).toBe("already_connected");
  });
});
