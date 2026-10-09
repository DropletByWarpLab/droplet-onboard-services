/**
 * WARP-3904 — the descriptor behind "connect it from chat".
 *
 * What these tests hold on to:
 *   - what a person types ("gmail", "our mail server", "QuickBooks") lands on
 *     the right family and provider, and nonsense lands on nothing;
 *   - a card is blocked for the right reason, in the contract's words;
 *   - EVERY card the service can produce survives the dashboard's own parser
 *     unchanged, carries no default on a secret, and posts only where the hub
 *     already posts;
 *   - the mailbox and calendar fields are the names the existing routes accept.
 *
 * The cards answer to the inline design: there is no setup dialog, so a blocked
 * card points at Settings (Account connection setup, Connected accounts) or the
 * Integrations hub, never at a popup.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetRegisteredProvidersForTest,
  CONNECT_OAUTH_START_PATHS,
  isAllowedConnectPostPath,
  parseConnectCard,
  providerDescriptors,
  registerProviderDescriptor,
  type ConnectCard,
  type ConnectField,
} from "@droplet/shared-types";
import { connectAccountBody } from "../routes/email.js";
import { sourceCreateSchema } from "../routes/calendar.js";
import {
  UnknownConnectionProviderError,
  buildConnectCard,
  connectionDisplayName,
  defaultConnectionSuggestions,
  resolveConnectionProvider,
  suggestConnectionProviders,
  type ConnectCardDeps,
  type ConnectionTarget,
} from "./connect-card.service.js";
import { connectInputFor, isCatalogAvailable } from "./connections-overview.service.js";
import { fakeConnectionsDb, googleRow, integrationRow, m365Row, userRow } from "../__tests__/helpers/fake-connections-db.js";

const owner = { id: "u-ada", role: "owner", username: "ada" };
const admin = { ...owner, role: "admin" };
const member = { ...owner, role: "family" };
const guest = { ...owner, role: "guest" };

const APP = { clientId: "app-client-id" };
/** A registration `parseAppRegistration` accepts: a GUID client id and the organisation's own tenant. */
const STORED_APP = { clientId: "6e261f89-12a7-4dac-a79a-3f345c8e8cce", tenantId: "org.onmicrosoft.com" };
const ready: ConnectCardDeps = { getGoogleApp: async () => APP, getMicrosoftApp: async () => APP };
const noApps: ConnectCardDeps = { getGoogleApp: async () => undefined, getMicrosoftApp: async () => undefined };

type Seed = Parameters<typeof fakeConnectionsDb>[0];

afterEach(() => __resetRegisteredProvidersForTest());

async function cardFor(
  actor: { id: string; role: string; username?: string },
  target: ConnectionTarget,
  seed: Seed = {},
  deps: Partial<ConnectCardDeps> = ready,
): Promise<ConnectCard> {
  const { prisma } = fakeConnectionsDb({ users: [userRow({ id: "u-ada", username: "ada" })], ...seed });
  return buildConnectCard(prisma, actor, target, deps);
}

const integration = (provider: string): ConnectionTarget => ({ family: "integration", provider });
const family = (name: "google" | "m365" | "mailbox" | "calendar"): ConnectionTarget => ({ family: name, provider: name });

const ROLE_BLOCK = (name: string) => `Only owners and admins can add box-wide connections like ${name}. You can still connect your own Google or Microsoft 365 account.`;

// ── Resolution ───────────────────────────────────────────────────────────

describe("resolveConnectionProvider", () => {
  it.each([
    // Google
    ["google", "google", "google"],
    ["gmail", "google", "google"],
    ["Gmail", "google", "google"],
    ["Google Workspace", "google", "google"],
    ["g suite", "google", "google"],
    ["google calendar", "google", "google"],
    // Microsoft 365
    ["outlook", "m365", "m365"],
    ["Outlook", "m365", "m365"],
    ["office 365", "m365", "m365"],
    ["Office365", "m365", "m365"],
    ["onedrive", "m365", "m365"],
    ["Microsoft 365", "m365", "m365"],
    ["m365", "m365", "m365"],
    ["sharepoint", "m365", "m365"],
    ["outlook calendar", "m365", "m365"],
    // mailbox on their own server
    ["our mail server", "mailbox", "mailbox"],
    ["imap", "mailbox", "mailbox"],
    ["IMAP", "mailbox", "mailbox"],
    ["work email", "mailbox", "mailbox"],
    ["my email", "mailbox", "mailbox"],
    ["email", "mailbox", "mailbox"],
    ["mailbox", "mailbox", "mailbox"],
    // calendar feed
    ["caldav", "calendar", "calendar"],
    ["CalDAV", "calendar", "calendar"],
    ["ics", "calendar", "calendar"],
    ["calendar feed", "calendar", "calendar"],
    ["a calendar feed", "calendar", "calendar"],
    ["webcal", "calendar", "calendar"],
    ["calendar", "calendar", "calendar"],
    // catalog providers, by id, by name and by what people call them
    ["stripe", "integration", "stripe"],
    ["Stripe", "integration", "stripe"],
    ["QuickBooks", "integration", "quickbooks-online"],
    ["quickbooks online", "integration", "quickbooks-online"],
    ["qbo", "integration", "quickbooks-online"],
    ["eaglesoft", "integration", "eaglesoft"],
    ["Cal.com", "integration", "calcom"],
    ["cal com", "integration", "calcom"],
    ["jira", "integration", "atlassian"],
    ["xero", "integration", "xero"],
    ["HubSpot", "integration", "hubspot"],
    ["Eaglesoft Patterson API", "integration", "eaglesoft-api"],
    ["connect Eaglesoft Patterson API", "integration", "eaglesoft-api"],
    ["Patterson API", "integration", "eaglesoft-api"],
    // inside a sentence
    ["connect my Stripe account", "integration", "stripe"],
    ["can you hook up gmail for me", "google", "google"],
    ["I want to add our own mail server", "mailbox", "mailbox"],
  ])("%j resolves to %s / %s", (query, fam, provider) => {
    expect(resolveConnectionProvider(query)).toEqual({ family: fam, provider });
  });

  it.each([
    "",
    "   ",
    "!!!",
    "frobnicate",
    "hello world",
    "connect it",
    "xyzzy plugh",
    // two different providers in one phrase: not a guess
    "connect stripe and hubspot",
    "set up the calendar for Stripe",
    "connect my email to the calendar",
  ])("%j resolves to nothing", (query) => {
    expect(resolveConnectionProvider(query)).toBeNull();
  });

  it("knows every catalog provider by id and by display name", () => {
    for (const descriptor of providerDescriptors()) {
      expect(resolveConnectionProvider(descriptor.id), descriptor.id).toEqual({ family: "integration", provider: descriptor.id });
      expect(resolveConnectionProvider(descriptor.displayName), descriptor.displayName).toEqual({ family: "integration", provider: descriptor.id });
    }
  });

  it("does not let a family word be taken for a vendor, or the reverse", () => {
    // "outlook" is Microsoft's, never a catalog provider's accident.
    expect(resolveConnectionProvider("outlook")?.family).toBe("m365");
    expect(resolveConnectionProvider("google")?.family).toBe("google");
  });
});

describe("suggestConnectionProviders", () => {
  it("offers close matches by prefix, then substring", () => {
    expect(suggestConnectionProviders("stri")).toContainEqual({ provider: "stripe", displayName: "Stripe" });
    expect(suggestConnectionProviders("goog")[0]).toEqual({ provider: "google", displayName: "Google" });
    expect(suggestConnectionProviders("mail").map((s) => s.provider)[0]).toBe("mailbox");
    expect(suggestConnectionProviders("books").map((s) => s.provider)).toEqual([]); // QuickBooks is coming soon: not offered
  });

  it("returns nothing for a query that is too short or matches nothing", () => {
    expect(suggestConnectionProviders("q")).toEqual([]);
    expect(suggestConnectionProviders("")).toEqual([]);
    expect(suggestConnectionProviders("zzzzzz")).toEqual([]);
  });

  it("only suggests what a person could pick", () => {
    const picked = ["e", "ea", "at", "open", "quick", "den", "pat", "qu"].flatMap((query) => suggestConnectionProviders(query, 100));
    const families = new Set(["google", "m365", "mailbox", "calendar"]);
    for (const { provider } of picked) {
      if (families.has(provider)) continue;
      const descriptor = providerDescriptors().find((d) => d.id === provider)!;
      expect(isCatalogAvailable(descriptor), provider).toBe(true);
      expect(connectInputFor(descriptor), provider).not.toBeNull();
    }
    const ids = picked.map((s) => s.provider);
    expect(ids).not.toContain("opendental"); // coming soon
    expect(ids).not.toContain("quickbooks-online"); // coming soon
    expect(ids).toContain("eaglesoft-api"); // its own wizard on the hub
    expect(ids).toContain("atlassian"); // connected through the credentials page, but still a pick
  });

  it("honours the limit and never repeats a provider", () => {
    const some = suggestConnectionProviders("ma", 2);
    expect(some.length).toBeLessThanOrEqual(2);
    const many = suggestConnectionProviders("a", 50).concat(suggestConnectionProviders("ma", 50));
    expect(new Set(many.map((s) => s.provider)).size).toBeLessThanOrEqual(many.length);
    const named = suggestConnectionProviders("ma", 50).map((s) => s.provider);
    expect(new Set(named).size).toBe(named.length);
  });

  it("falls back to the four connections anyone can ask for", () => {
    expect(defaultConnectionSuggestions()).toEqual([
      { provider: "google", displayName: "Google" },
      { provider: "m365", displayName: "Microsoft 365" },
      { provider: "mailbox", displayName: "Mailbox" },
      { provider: "calendar", displayName: "Calendar feed" },
    ]);
    // A copy: changing it cannot change the next caller's.
    defaultConnectionSuggestions().pop();
    expect(defaultConnectionSuggestions()).toHaveLength(4);
  });
});

describe("connectionDisplayName", () => {
  it("names each family, and a catalog provider by its descriptor", () => {
    expect(connectionDisplayName(family("google"))).toBe("Google");
    expect(connectionDisplayName(family("m365"))).toBe("Microsoft 365");
    expect(connectionDisplayName(family("mailbox"))).toBe("Mailbox");
    expect(connectionDisplayName(family("calendar"))).toBe("Calendar feed");
    expect(connectionDisplayName(integration("stripe"))).toBe("Stripe");
    expect(connectionDisplayName(integration("quickbooks-online"))).toBe("QuickBooks Online");
    expect(connectionDisplayName(integration("unheard-of"))).toBe("unheard-of");
  });
});

// ── Blocking ─────────────────────────────────────────────────────────────

describe("role blocking", () => {
  it.each([
    ["Stripe", integration("stripe")],
    ["Mailbox", family("mailbox")],
    ["Eaglesoft", integration("eaglesoft")],
    ["Xero", integration("xero")],
  ])("a member cannot add %s, and is told why in the contract's words", async (name, target) => {
    const card = await cardFor(member, target);
    expect(card.blocked).toEqual({ reason: "role", message: ROLE_BLOCK(name), requiredRole: "admin" });
    expect(card.scope).toBe("box");
  });

  it.each([["owner", owner], ["admin", admin]])("%s is not blocked from a box-wide connection", async (_role, actor) => {
    for (const target of [integration("stripe"), family("mailbox"), integration("eaglesoft")]) {
      expect((await cardFor(actor, target)).blocked).toBeUndefined();
    }
  });

  it("a member can still connect their own Google, Microsoft 365 and calendar feed", async () => {
    for (const target of [family("google"), family("m365"), family("calendar")]) {
      const card = await cardFor(member, target);
      expect(card.blocked, target.provider).toBeUndefined();
      expect(card.scope).toBe("personal");
    }
  });

  it("a guest can connect nothing, and is told their account type is the reason", async () => {
    for (const target of [family("google"), family("m365"), family("calendar")]) {
      const card = await cardFor(guest, target);
      expect(card.blocked?.reason, target.provider).toBe("role");
      expect(card.blocked?.message).toMatch(/Your account type cannot connect/);
      expect(card.blocked?.requiredRole).toBeUndefined();
    }
    for (const target of [family("mailbox"), integration("stripe")]) {
      expect((await cardFor(guest, target)).blocked?.message).toBe(ROLE_BLOCK(connectionDisplayName(target)));
    }
  });

  it("the role block comes before anything that would reveal the box's state", async () => {
    // A member asking for a provider that is also coming soon, or already connected, hears about their role.
    const connected = await cardFor(member, integration("stripe"), { integrations: [integrationRow("stripe", "CONNECTED")] });
    expect(connected.blocked?.reason).toBe("role");
    const comingSoon = await cardFor(member, integration("quickbooks-online"));
    expect(comingSoon.blocked?.reason).toBe("role");
  });

  it("a blocked card still names where it would post, from the allowlist", async () => {
    const card = await cardFor(member, integration("stripe"));
    expect(card.mode).toBe("credentials");
    if (card.mode === "credentials") expect(isAllowedConnectPostPath(card.post.path)).toBe(true);
  });
});

describe("already connected", () => {
  it("Google, with the account named", async () => {
    const card = await cardFor(owner, family("google"), { google: [googleRow("u-ada", { state: "CONNECTED", accountAddress: "person@gmail.com" })] });
    expect(card.blocked).toEqual({ reason: "already_connected", message: "Google is already connected as person@gmail.com. Manage it in Settings under Connected accounts." });
  });

  it("Microsoft 365, with the account named", async () => {
    const card = await cardFor(owner, family("m365"), { m365: [m365Row("u-ada", { state: "CONNECTED", accountUpn: "person@contoso.example" })] });
    expect(card.blocked).toEqual({ reason: "already_connected", message: "Microsoft 365 is already connected as person@contoso.example. Manage it in Settings under Connected accounts." });
  });

  it.each(["NEEDS_RECONNECT", "ERROR", "PENDING_CONSENT", "DISCONNECTED"])("a %s Google sign-in can be started again", async (state) => {
    const card = await cardFor(owner, family("google"), { google: [googleRow("u-ada", { state, pendingExpiresAt: new Date(Date.now() + 60_000) })] });
    expect(card.blocked).toBeUndefined();
  });

  it.each(["CONNECTED", "CAPABILITY_LIMITED", "DEGRADED", "DRIFT_LOCKED"])("a %s catalog connection is not offered to overwrite", async (status) => {
    const card = await cardFor(owner, integration("stripe"), { integrations: [integrationRow("stripe", status)] });
    expect(card.blocked).toEqual({ reason: "already_connected", message: "Stripe is already connected. Manage it in Integrations." });
  });

  it("one that is still being set up says so", async () => {
    const card = await cardFor(owner, integration("stripe"), { integrations: [integrationRow("stripe", "PROVISIONING")] });
    expect(card.blocked).toEqual({ reason: "already_connected", message: "A Stripe connection is already being set up. Check its status in Integrations." });
  });

  it.each(["NEEDS_RECONNECT", "ERROR", "DISABLED", "NOT_CONFIGURED"])("a %s catalog connection may take a new key", async (status) => {
    const card = await cardFor(owner, integration("stripe"), { integrations: [integrationRow("stripe", status)] });
    expect(card.blocked).toBeUndefined();
  });

  it("only the same provider's row counts", async () => {
    const card = await cardFor(owner, integration("stripe"), { integrations: [integrationRow("hubspot", "CONNECTED")] });
    expect(card.blocked).toBeUndefined();
  });
});

describe("setup required", () => {
  it("Google without an app asks an owner to set it up first", async () => {
    const card = await cardFor(owner, family("google"), {}, noApps);
    expect(card.blocked).toEqual({
      reason: "setup_required",
      message: "An owner needs to set up the Google app first, in Settings under Account connection setup.",
      requiredRole: "owner",
    });
  });

  it("Google with an app but a callback Google refuses (.lan, an IP, plain http) says what to fix", async () => {
    for (const googleRedirectUri of ["https://droplet-ai.lan/api/google/callback", "https://192.168.9.195/api/google/callback", "http://box.customer.com/api/google/callback", "https://localhost/api/google/callback"]) {
      const card = await cardFor(owner, family("google"), {}, { ...ready, googleRedirectUri });
      expect(card.blocked, googleRedirectUri).toMatchObject({ reason: "setup_required", requiredRole: "owner" });
      expect(card.blocked?.message).toMatch(/HTTPS address on this Droplet's own domain/);
    }
  });

  it("Google with an app and a public HTTPS callback is open", async () => {
    const card = await cardFor(owner, family("google"), {}, { ...ready, googleRedirectUri: "https://box.customer.com/api/google/callback" });
    expect(card.blocked).toBeUndefined();
    expect(card).toMatchObject({ mode: "oauth", start: { path: "/api/google/connect" }, providerLabel: "Google" });
  });

  it("when the caller does not know the callback, only the missing app is checked", async () => {
    expect((await cardFor(owner, family("google"), {}, ready)).blocked).toBeUndefined();
    expect((await cardFor(owner, family("google"), {}, { ...noApps, googleRedirectUri: "https://box.customer.com/api/google/callback" })).blocked?.message).toMatch(/set up the Google app first/);
  });

  it("Microsoft 365 needs the person's own stored app or the box's", async () => {
    const none = await cardFor(owner, family("m365"), {}, noApps);
    expect(none.blocked).toEqual({
      reason: "setup_required",
      message: "An owner needs to set up the Microsoft app first, in Settings under Account connection setup.",
      requiredRole: "owner",
    });
    const stored = await cardFor(owner, family("m365"), { m365: [m365Row("u-ada", { state: "DISCONNECTED", appClientId: STORED_APP.clientId, appTenantId: STORED_APP.tenantId })] }, noApps);
    expect(stored.blocked).toBeUndefined();
    const boxWide = await cardFor(owner, family("m365"), {}, ready);
    expect(boxWide.blocked).toBeUndefined();
  });

  it("a stored Microsoft app that is not a valid registration does not count", async () => {
    for (const [appClientId, appTenantId] of [["own-client", "own-tenant"], [STORED_APP.clientId, "common"], ["not a guid", STORED_APP.tenantId]]) {
      const card = await cardFor(owner, family("m365"), { m365: [m365Row("u-ada", { state: "DISCONNECTED", appClientId, appTenantId })] }, noApps);
      expect(card.blocked, `${appClientId} / ${appTenantId}`).toMatchObject({ reason: "setup_required", requiredRole: "owner" });
    }
  });

  it("an existing connection is reported before a missing app", async () => {
    const card = await cardFor(owner, family("google"), { google: [googleRow("u-ada")] }, noApps);
    expect(card.blocked?.reason).toBe("already_connected");
  });
});

describe("unavailable", () => {
  it("a provider the catalog marks coming soon", async () => {
    for (const [provider, name] of [["quickbooks-online", "QuickBooks Online"], ["dentrix-ascend", "Dentrix Ascend"], ["opendental", "Open Dental"]] as const) {
      const card = await cardFor(owner, integration(provider));
      expect(card.blocked, provider).toEqual({ reason: "unavailable", message: `${name} isn't available to connect yet.` });
    }
  });

  it("an MCP provider hands off to the credentials page in Integrations, with nothing to post from the card", async () => {
    const card = await cardFor(owner, integration("atlassian"));
    expect(card.blocked).toBeUndefined();
    expect(card).toMatchObject({ mode: "wizard", provider: "atlassian", wizardHref: "/integrations/credentials", safety: "setup-internet" });
    expect(card).not.toHaveProperty("post");
    expect(card).not.toHaveProperty("fields");
    if (card.mode === "wizard") expect(card.steps.length).toBeGreaterThan(0);
  });

  it("an id the registry does not know is an error, not a card", async () => {
    await expect(cardFor(owner, integration("not-a-provider"))).rejects.toBeInstanceOf(UnknownConnectionProviderError);
  });
});

// ── The cards themselves ─────────────────────────────────────────────────

describe("credentials cards", () => {
  it("Stripe: one secret key, its pattern, the hub's connect route and the internet chip", async () => {
    const card = await cardFor(owner, integration("stripe"));
    expect(card).toMatchObject({
      kind: "connect_card",
      mode: "credentials",
      provider: "stripe",
      family: "integration",
      displayName: "Stripe",
      category: "Payments",
      scope: "box",
      safety: "setup-internet",
      helpHref: "/help/integrations/stripe",
      manageHref: "/integrations",
      post: { path: "/api/integrations/stripe/connect" },
    });
    expect(card.summary).toBe("Reads invoices, charges · read-only by default");
    if (card.mode !== "credentials") throw new Error("expected credentials");
    expect(card.fields).toHaveLength(1);
    expect(card.fields[0]).toMatchObject({ name: "apiKey", label: "Stripe restricted key", type: "password", required: true, secret: true, pattern: "^rk_(live|test)_" });
    expect(card.fields[0]).not.toHaveProperty("defaultValue");
    expect(card.blocked).toBeUndefined();
  });

  it("Shopify: a plain field stays plain, the two secrets are masked", async () => {
    const card = await cardFor(owner, integration("shopify"));
    if (card.mode !== "credentials") throw new Error("expected credentials");
    const byName = Object.fromEntries(card.fields.map((f) => [f.name, f]));
    expect(byName.shopDomain).toMatchObject({ type: "text", secret: false });
    expect(byName.clientId).toMatchObject({ type: "password", secret: true });
    expect(byName.clientSecret).toMatchObject({ type: "password", secret: true });
  });

  it("a number field is a number field, whatever the registry calls it", async () => {
    const card = await cardFor(owner, integration("quickbooks-online"));
    if (card.mode !== "credentials") throw new Error("expected credentials");
    expect(card.fields.find((f) => f.name === "callCeiling")?.type).toBe("number");
  });

  it("Xero: the base set is separate from each variant's own fields", async () => {
    const descriptor = providerDescriptors().find((d) => d.id === "xero")!;
    const card = await cardFor(owner, integration("xero"));
    if (card.mode !== "credentials") throw new Error("expected credentials");
    expect(card.variants?.map((v) => v.id)).toEqual((descriptor.credentialVariants ?? []).map((v) => v.id));
    expect(card.variants!.length).toBeGreaterThan(1);
    for (const variant of card.variants!) {
      const expected = descriptor.credentialVariants!.find((v) => v.id === variant.id)!;
      expect(variant.fields.map((f) => f.name)).toEqual(expected.fields.map((f) => f.name));
      for (const field of variant.fields) if (field.secret) expect(field.type).toBe("password");
    }
    expect(card.post.path).toBe("/api/integrations/xero/connect");
  });

  it("the fields are the descriptor's, in order, with every descriptor secret masked", async () => {
    for (const descriptor of providerDescriptors()) {
      const card = await cardFor(owner, integration(descriptor.id));
      if (card.mode !== "credentials") continue;
      expect(card.fields.map((f) => f.name), descriptor.id).toEqual(descriptor.credentialFields.map((f) => f.name));
      for (const def of descriptor.credentialFields) {
        const field = card.fields.find((f) => f.name === def.name)!;
        expect(field.secret, `${descriptor.id}.${def.name}`).toBe(def.secret);
        if (def.secret) expect(field.type).toBe("password");
      }
    }
  });
});

describe("wizard cards", () => {
  it("Eaglesoft hands off to the hub wizard, on the box's own network", async () => {
    const card = await cardFor(owner, integration("eaglesoft"));
    expect(card).toMatchObject({
      mode: "wizard",
      provider: "eaglesoft",
      displayName: "Eaglesoft",
      safety: "setup-lan",
      scope: "box",
      estimate: "about 10 minutes",
      wizardHref: "/integrations?connect=eaglesoft",
      manageHref: "/integrations",
    });
    if (card.mode !== "wizard") throw new Error("expected wizard");
    expect(card.steps).toHaveLength(4);
    expect(card).not.toHaveProperty("post");
    expect(card).not.toHaveProperty("fields");
    expect(card.blocked).toBeUndefined();
  });

  it("the Patterson API transport also goes through the wizard, never a form on this card", async () => {
    const card = await cardFor(owner, integration("eaglesoft-api"));
    expect(card).toMatchObject({ mode: "wizard", safety: "setup-lan", wizardHref: "/integrations?connect=eaglesoft-api" });
    expect(card).not.toHaveProperty("fields");
  });

  it("every track=lan provider is a wizard, every cloud and REST provider a credentials form", async () => {
    for (const descriptor of providerDescriptors()) {
      const card = await cardFor(owner, integration(descriptor.id));
      if (descriptor.track === "lan") expect(card.mode, descriptor.id).toBe("wizard");
      if (descriptor.track === "cloud" || descriptor.track === "rest") expect(card.mode, descriptor.id).toBe("credentials");
      expect(card.safety, descriptor.id).toBe(descriptor.track === "lan" ? "setup-lan" : "setup-internet");
    }
  });

  it("the Patterson API transport carries its own four steps, none of them SQL provisioning", async () => {
    const card = await cardFor(owner, integration("eaglesoft-api"));
    if (card.mode !== "wizard") throw new Error("expected wizard");
    expect(card.steps).toHaveLength(4);
    expect(card.steps.join(" ")).toMatch(/Patterson integration key/);
    expect(card.steps.join(" ")).toMatch(/route map/);
    expect(card.steps.join(" ")).not.toMatch(/database account|SQL/);
  });

  it("how a provider is connected follows what the catalog says it takes", async () => {
    for (const descriptor of providerDescriptors()) {
      const card = await cardFor(owner, integration(descriptor.id));
      const input = connectInputFor(descriptor);
      if (input === "credentials") expect(card.mode, descriptor.id).toBe("credentials");
      else expect(card.mode, descriptor.id).toBe("wizard");
      if (input === "lan") expect(card.safety, descriptor.id).toBe("setup-lan");
      if (input === "lan" || input === "lan_api") expect(card.mode === "wizard" && card.wizardHref, descriptor.id).toBe(`/integrations?connect=${descriptor.id}`);
      if (!input) expect(card.blocked?.reason, descriptor.id).toBe("unavailable");
    }
  });
});

describe("oauth cards", () => {
  it("Google offers mail and calendar, ticked, and starts at the Google route", async () => {
    const card = await cardFor(owner, family("google"));
    expect(card).toMatchObject({
      mode: "oauth",
      provider: "google",
      family: "google",
      scope: "personal",
      safety: "setup-internet",
      providerLabel: "Google",
      start: { path: "/api/google/connect" },
      manageHref: "/settings#connected-accounts",
    });
    if (card.mode !== "oauth") throw new Error("expected oauth");
    expect(card.options).toEqual([
      { name: "mail", label: "Mail", help: "search, summarize, draft replies you approve", defaultChecked: true },
      { name: "calendar", label: "Calendar", help: "read your events, suggest times", defaultChecked: true },
    ]);
  });

  it("Microsoft 365 has no feature switches: what it reads is chosen in Settings after sign-in", async () => {
    const card = await cardFor(owner, family("m365"));
    expect(card).toMatchObject({ mode: "oauth", provider: "m365", providerLabel: "Microsoft", start: { path: "/api/m365/connect" } });
    if (card.mode !== "oauth") throw new Error("expected oauth");
    expect(card.options).toEqual([]);
  });

  it("starts only at the two OAuth routes", async () => {
    for (const target of [family("google"), family("m365")]) {
      const card = await cardFor(owner, target);
      if (card.mode !== "oauth") throw new Error("expected oauth");
      expect(CONNECT_OAUTH_START_PATHS).toContain(card.start.path);
    }
  });
});

describe("mailbox card", () => {
  it("posts to the mailbox route and asks for the mailbox's own server", async () => {
    const card = await cardFor(owner, family("mailbox"));
    expect(card).toMatchObject({ mode: "mailbox", scope: "box", safety: "setup-internet", post: { path: "/api/email/accounts" }, manageHref: "/settings#email" });
    if (card.mode !== "mailbox") throw new Error("expected mailbox");
    expect(card.fields.map((f) => f.name)).toEqual(["displayName", "address", "imapHost", "imapPort", "smtpHost", "smtpPort", "username", "password"]);
    expect(card.fields.find((f) => f.name === "imapPort")?.defaultValue).toBe("993");
    expect(card.fields.find((f) => f.name === "smtpPort")?.defaultValue).toBe("465");
  });

  it("uses exactly the names `connectAccountBody` accepts, and covers everything it requires", async () => {
    const card = await cardFor(owner, family("mailbox"));
    if (card.mode !== "mailbox") throw new Error("expected mailbox");
    const accepted = Object.keys(connectAccountBody.shape);
    const named = card.fields.map((f) => f.name);
    for (const name of named) expect(accepted, name).toContain(name);
    // Required = no default: TLS flags and ports default, the rest must come from the person.
    const required = ["displayName", "address", "imapHost", "smtpHost", "username", "password"];
    for (const name of required) expect(named, name).toContain(name);
    for (const field of card.fields.filter((f) => required.includes(f.name))) expect(field.required, field.name).toBe(true);
  });

  it("a body built from the card's fields is one the route accepts (and the route is strict about the rest)", async () => {
    const card = await cardFor(owner, family("mailbox"));
    if (card.mode !== "mailbox") throw new Error("expected mailbox");
    const body = bodyFrom(card.fields, { displayName: "Front desk", address: "desk@northgate.example", imapHost: "mail.northgate.example", smtpHost: "smtp.northgate.example", username: "frontdesk", password: "pw" });
    expect(connectAccountBody.safeParse(body).success).toBe(true);
    expect(connectAccountBody.safeParse({ ...body, extra: "x" }).success).toBe(false);
  });

  it("masks the password and never defaults it", async () => {
    const card = await cardFor(owner, family("mailbox"));
    if (card.mode !== "mailbox") throw new Error("expected mailbox");
    expect(card.fields.find((f) => f.name === "password")).toMatchObject({ type: "password", secret: true, required: true });
    expect(card.fields.find((f) => f.name === "password")).not.toHaveProperty("defaultValue");
  });
});

describe("calendar card", () => {
  it("posts to the calendar sources route", async () => {
    const card = await cardFor(owner, family("calendar"));
    expect(card).toMatchObject({ mode: "calendar", scope: "personal", safety: "setup-internet", post: { path: "/api/calendar/sources" }, manageHref: "/calendar" });
    if (card.mode !== "calendar") throw new Error("expected calendar");
    expect(card.fields.map((f) => f.name)).toEqual(["name", "url", "username", "password"]);
    expect(card.fields.find((f) => f.name === "url")).toMatchObject({ type: "url", required: true });
    expect(card.fields.find((f) => f.name === "password")).toMatchObject({ type: "password", secret: true, required: false });
  });

  it("uses names `sourceCreateSchema` accepts and a body from them passes (sign-in sets authMode)", async () => {
    const card = await cardFor(owner, family("calendar"));
    if (card.mode !== "calendar") throw new Error("expected calendar");
    const accepted = Object.keys(sourceCreateSchema.shape);
    for (const field of card.fields) expect(accepted, field.name).toContain(field.name);
    const open = bodyFrom(card.fields, { name: "Team", url: "https://calendars.example/team.ics" });
    expect(sourceCreateSchema.safeParse(open).success).toBe(true);
    const signedIn = bodyFrom(card.fields, { name: "Personal iCloud", url: "https://caldav.icloud.example/dav", username: "me", password: "pw" });
    expect(sourceCreateSchema.safeParse({ ...signedIn, authMode: "basic" }).success).toBe(true);
  });
});

// ── Every card, every role ───────────────────────────────────────────────

const allTargets = (): ConnectionTarget[] => [family("google"), family("m365"), family("mailbox"), family("calendar"), ...providerDescriptors().map((d) => integration(d.id))];

/** Fields of a card in any mode, variant fields included. */
function fieldsOf(card: ConnectCard): ConnectField[] {
  if (card.mode === "credentials") return [...card.fields, ...(card.variants ?? []).flatMap((v) => v.fields)];
  if (card.mode === "mailbox" || card.mode === "calendar") return card.fields;
  return [];
}

function textOf(card: ConnectCard): string[] {
  const out = [card.displayName, card.summary, card.blocked?.message ?? "", card.category ?? ""];
  for (const f of fieldsOf(card)) out.push(f.label, f.help ?? "", f.placeholder ?? "");
  if (card.mode === "oauth") for (const o of card.options) out.push(o.label, o.help ?? "");
  if (card.mode === "wizard") out.push(...card.steps, card.estimate ?? "");
  return out;
}

/** A body the way the dashboard builds it: a typed value, else the field's default. */
function bodyFrom(fields: ConnectField[], typed: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = typed[field.name] ?? field.defaultValue;
    if (value === undefined || value === "") continue;
    body[field.name] = field.type === "number" ? Number(value) : value;
  }
  return body;
}

describe.each([
  ["an owner", owner],
  ["an admin", admin],
  ["a member", member],
  ["a guest", guest],
])("every card for %s", (_who, actor) => {
  it("survives the dashboard's own parser unchanged", async () => {
    for (const target of allTargets()) {
      const card = await cardFor(actor, target);
      expect(parseConnectCard(card), `${target.family}:${target.provider}`).toEqual(card);
    }
  });

  it("carries no default on a secret, and masks every secret", async () => {
    for (const target of allTargets()) {
      const card = await cardFor(actor, target);
      for (const field of fieldsOf(card)) {
        if (field.secret) {
          expect(field, `${target.provider}.${field.name}`).not.toHaveProperty("defaultValue");
          expect(field.type, `${target.provider}.${field.name}`).toBe("password");
        }
        if (field.type === "password") expect(field.secret, `${target.provider}.${field.name}`).toBe(true);
      }
    }
  });

  it("posts only where the hub already posts, and starts OAuth only at the two routes", async () => {
    for (const target of allTargets()) {
      const card = await cardFor(actor, target);
      if (card.mode === "oauth") expect(CONNECT_OAUTH_START_PATHS).toContain(card.start.path);
      if (card.mode === "credentials") expect(card.post.path).toBe(`/api/integrations/${card.provider}/connect`);
      if (card.mode === "mailbox") expect(card.post.path).toBe("/api/email/accounts");
      if (card.mode === "calendar") expect(card.post.path).toBe("/api/calendar/sources");
      if (card.mode === "credentials" || card.mode === "mailbox" || card.mode === "calendar") expect(isAllowedConnectPostPath(card.post.path)).toBe(true);
    }
  });

  it("speaks in the house voice: sentence case, no emoji, no exclamation marks", async () => {
    for (const target of allTargets()) {
      const card = await cardFor(actor, target);
      for (const text of textOf(card)) {
        expect(text, `${target.provider}: ${text}`).not.toContain("!");
        expect(text, `${target.provider}: ${text}`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(card.summary.length).toBeLessThanOrEqual(400);
      if (card.blocked) expect(card.blocked.message.length).toBeLessThanOrEqual(600);
    }
  });

  it("points only at same-origin dashboard pages", async () => {
    for (const target of allTargets()) {
      const card = await cardFor(actor, target);
      for (const href of [card.manageHref, card.helpHref, card.mode === "wizard" ? card.wizardHref : undefined]) {
        if (href !== undefined) expect(href, target.provider).toMatch(/^\/[^/\\]/);
      }
    }
  });
});

describe("nothing secret in a card", () => {
  it("serializes no key, token, ciphertext or vendor error, whatever state the box is in", async () => {
    const seed: Seed = {
      google: [googleRow("u-ada")],
      m365: [m365Row("u-ada")],
      integrations: [integrationRow("stripe", "ERROR")],
    };
    for (const target of [family("google"), family("m365"), integration("stripe"), family("mailbox")]) {
      const text = JSON.stringify(await cardFor(owner, target, seed));
      expect(text).not.toMatch(/gho_|ya29|Enc"|password":"[^"]|token":"[^"]/);
      expect(text).not.toContain("invalid_grant");
    }
  });
});

// ── Behaviour carried over from the first connect-from-chat suite ────────

describe("setup descriptors", () => {
  it.each([
    [" \tReads!\nmail. and events!... \t", "Reads mail. and events"],
    ["Reads mail . \t. .!\n", "Reads mail"],
    [". \t. .!\n", ""],
    [`Reads${".".repeat(100_000)}${"\t".repeat(100_000)}events...`, `Reads${".".repeat(395)}`],
  ])("normalizes a provider summary without rescanning punctuation runs", async (description, expected) => {
    const template = providerDescriptors().find((descriptor) => descriptor.track === "mcp");
    if (!template || template.track !== "mcp") throw new Error("Expected an MCP descriptor fixture");
    registerProviderDescriptor({ ...template, id: "summary-fixture", displayName: "Summary fixture", datasets: [], description });
    const card = await cardFor(owner, integration("summary-fixture"));
    expect(card.summary).toBe(expected);
  });

  it("provides validated setup for every available catalog provider, including MCP", async () => {
    for (const descriptor of providerDescriptors()) {
      const card = await cardFor(owner, integration(descriptor.id));
      expect(parseConnectCard(card), descriptor.id).not.toBeNull();
      if (isCatalogAvailable(descriptor) && connectInputFor(descriptor)) expect(card.blocked, descriptor.id).toBeUndefined();
      else expect(card.blocked?.reason, descriptor.id).toBe("unavailable");
      if (descriptor.track === "mcp" && isCatalogAvailable(descriptor)) {
        expect(card.mode).toBe("wizard");
        expect(card).toMatchObject({ wizardHref: "/integrations/credentials" });
      }
    }
  });

  it("blocks box-wide cards for members before querying a connection", async () => {
    const { prisma, db } = fakeConnectionsDb({ users: [userRow({ id: "u-ada", username: "ada" })] });
    for (const target of [family("mailbox"), integration("stripe")]) {
      expect((await buildConnectCard(prisma, member, target, ready)).blocked?.reason).toBe("role");
    }
    expect(db.integrationConnection.findFirst).not.toHaveBeenCalled();
    expect(db.googleConnection.findUnique).not.toHaveBeenCalled();
  });

  it("looks up a member's own Google and Microsoft connection, and never returns an app secret", async () => {
    const withSecret: ConnectCardDeps = {
      getGoogleApp: async () => ({ clientId: "google", clientSecret: "NEVER_IN_CARD" }),
      getMicrosoftApp: async () => ({ ...APP, clientSecret: "NEVER_IN_CARD" }),
    };
    const { prisma, db } = fakeConnectionsDb({ users: [userRow({ id: "u-ada", username: "ada" })] });
    for (const name of ["google", "m365"] as const) {
      const card = await buildConnectCard(prisma, member, family(name), withSecret);
      expect(card.blocked).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain("NEVER_IN_CARD");
    }
    expect(db.googleConnection.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: member.id } }));
    expect(db.m365Connection.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: member.id } }));
  });

  it("asks a member to wait for an owner when the Google callback is unsupported", async () => {
    const card = await cardFor(member, family("google"), {}, { ...ready, googleRedirectUri: "http://droplet.lan/api/google/callback" });
    expect(card.blocked).toMatchObject({ reason: "setup_required", requiredRole: "owner" });
  });
});

describe("no setup popup in any card", () => {
  it("every message and step points at Settings or Integrations, never at a popup or dialog", async () => {
    const blockedSeeds: Array<[typeof owner, ConnectionTarget, Seed, Partial<ConnectCardDeps>]> = [
      [owner, family("google"), {}, noApps],
      [owner, family("google"), {}, { ...ready, googleRedirectUri: "http://droplet.lan/api/google/callback" }],
      [owner, family("m365"), {}, noApps],
      [owner, family("google"), { google: [googleRow("u-ada")] }, ready],
      [owner, family("m365"), { m365: [m365Row("u-ada")] }, ready],
      [owner, integration("stripe"), { integrations: [integrationRow("stripe", "CONNECTED")] }, ready],
      [owner, integration("stripe"), { integrations: [integrationRow("stripe", "PROVISIONING")] }, ready],
      [member, integration("stripe"), {}, ready],
      [guest, family("google"), {}, ready],
    ];
    for (const [actor, target, seed, deps] of blockedSeeds) {
      const card = await cardFor(actor, target, seed, deps);
      expect(card.blocked, `${target.provider}`).toBeDefined();
      for (const text of textOf(card)) expect(text, `${target.provider}: ${text}`).not.toMatch(/pop-?up|dialog|\bhere\.?$/i);
    }
  });

  it("names Settings for the OAuth families and Integrations for the catalog", async () => {
    expect((await cardFor(owner, family("google"), { google: [googleRow("u-ada")] })).blocked?.message).toMatch(/Settings under Connected accounts\.$/);
    expect((await cardFor(owner, family("m365"), { m365: [m365Row("u-ada")] })).blocked?.message).toMatch(/Settings under Connected accounts\.$/);
    expect((await cardFor(owner, family("google"), {}, noApps)).blocked?.message).toMatch(/Settings under Account connection setup\.$/);
    expect((await cardFor(owner, family("m365"), {}, noApps)).blocked?.message).toMatch(/Settings under Account connection setup\.$/);
    expect((await cardFor(owner, integration("stripe"), { integrations: [integrationRow("stripe", "CONNECTED")] })).blocked?.message).toMatch(/Integrations\.$/);
    expect((await cardFor(owner, integration("stripe"), { integrations: [integrationRow("stripe", "PROVISIONING")] })).blocked?.message).toMatch(/Integrations\.$/);
  });
});
