import { describe, expect, it } from "vitest";
import {
  CONNECT_OAUTH_START_PATHS,
  CONNECT_POST_PATH_RES,
  connectOutcomeTurn,
  isAllowedConnectPostPath,
  isAllowedOauthStartPath,
  isSafeDashboardHref,
  parseAvailableConnection,
  parseConnectCard,
  credentialsConnectPath,
  parseConnectField,
  parseConnectionDisconnected,
  parseConnectionRow,
  parseConnectionsOverview,
  type ConnectCard,
} from "./chat-connect";

// ── fixtures ─────────────────────────────────────────────────────────────

const BASE = {
  kind: "connect_card",
  provider: "stripe",
  family: "integration",
  displayName: "Stripe",
  category: "Payments",
  scope: "box",
  summary: "Reads invoices, charges · read-only by default",
  safety: "setup-internet",
  helpHref: "/help/connectors/stripe",
  manageHref: "/connectors",
} as const;

const KEY_FIELD = { name: "apiKey", label: "Stripe restricted key", type: "password", required: true, secret: true, pattern: "^rk_(live|test)_" };

const credentialsCard = (over: Record<string, unknown> = {}) => ({
  ...BASE,
  mode: "credentials",
  fields: [KEY_FIELD],
  post: { path: "/api/connectors/stripe/connect" },
  ...over,
});

const oauthCard = (over: Record<string, unknown> = {}) => ({
  ...BASE,
  provider: "google",
  family: "google",
  displayName: "Google",
  scope: "personal",
  manageHref: "/settings#connected-accounts",
  helpHref: undefined,
  mode: "oauth",
  providerLabel: "Google",
  options: [
    { name: "mail", label: "Mail", defaultChecked: true },
    { name: "calendar", label: "Calendar", help: "read your events", defaultChecked: false },
  ],
  start: { path: "/api/google/connect" },
  ...over,
});

const mailboxCard = (over: Record<string, unknown> = {}) => ({
  ...BASE,
  provider: "mailbox",
  family: "mailbox",
  displayName: "Mailbox",
  helpHref: undefined,
  manageHref: "/settings#email",
  mode: "mailbox",
  fields: [
    { name: "address", label: "Email address", type: "email", required: true, secret: false },
    { name: "imapPort", label: "Incoming port", type: "number", required: true, secret: false, defaultValue: "993" },
    { name: "password", label: "Password", type: "password", required: true, secret: true },
  ],
  post: { path: "/api/email/accounts" },
  ...over,
});

const calendarCard = (over: Record<string, unknown> = {}) => ({
  ...BASE,
  provider: "calendar",
  family: "calendar",
  displayName: "Calendar feed",
  scope: "personal",
  helpHref: undefined,
  manageHref: "/calendar",
  mode: "calendar",
  fields: [{ name: "url", label: "Calendar address", type: "url", required: true, secret: false }],
  post: { path: "/api/calendar/sources" },
  ...over,
});

const wizardCard = (over: Record<string, unknown> = {}) => ({
  ...BASE,
  provider: "eaglesoft",
  displayName: "Eaglesoft",
  mode: "wizard",
  steps: ["Find the server on your network", "Confirm and connect"],
  estimate: "about 10 minutes",
  wizardHref: "/connectors?connect=eaglesoft",
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "integration:stripe",
  family: "integration",
  provider: "stripe",
  displayName: "Stripe",
  scope: "box",
  status: "connected",
  capabilities: ["invoices", "charges"],
  manageHref: "/connectors",
  canDisconnect: true,
  canReconnect: false,
  ...over,
});

// ── isSafeDashboardHref ──────────────────────────────────────────────────

describe("isSafeDashboardHref", () => {
  it.each([
    "/connectors",
    "/settings#connected-accounts",
    "/connectors?connect=eaglesoft",
    "/help/connectors/stripe",
    "/connectors?next=../x", // `..` in a query value is data, not a path segment
  ])("accepts %s", (u) => expect(isSafeDashboardHref(u)).toBe(true));

  it.each([
    "https://evil.example/settings",
    "http://evil.example",
    "//evil.example",
    "/a/../b",
    "/a/%2e%2e/b",
    "/..",
    "/a\\b",
    "/\\evil.example",
    "javascript:alert(1)",
    "settings",
    "/a\nb",
    "/a\u0000b",
    "/%E0%A4%A", // undecodable
    "",
    null,
    undefined,
    42,
    "/" + "a".repeat(2100),
  ])("rejects %j", (u) => expect(isSafeDashboardHref(u as unknown)).toBe(false));
});

describe("post and oauth path allowlists", () => {
  it.each([
    "/api/connectors/stripe/connect",
    "/api/connectors/quickbooks-online/connect",
    "/api/email/accounts",
    "/api/calendar/sources",
  ])("allows posting to %s", (p) => expect(isAllowedConnectPostPath(p)).toBe(true));

  it.each([
    "/api/connectors/stripe/disconnect",
    "/api/connectors/stripe/credentials",
    "/api/connectors/Stripe/connect",
    "/api/connectors/../email/accounts/connect",
    "/api/connectors//connect",
    "/api/connectors/stripe/connect/extra",
    "/api/email/accounts/abc",
    "/api/email/accounts?x=1",
    "/api/files/upload",
    "https://evil.example/api/email/accounts",
    "//evil.example/api/email/accounts",
    "",
    null,
  ])("refuses to post to %j", (p) => expect(isAllowedConnectPostPath(p as unknown)).toBe(false));

  it("names exactly the three families of POST target and the two OAuth starts", () => {
    expect(CONNECT_POST_PATH_RES).toHaveLength(3);
    expect([...CONNECT_OAUTH_START_PATHS]).toEqual(["/api/google/connect", "/api/m365/connect"]);
    expect(isAllowedOauthStartPath("/api/google/connect")).toBe(true);
    expect(isAllowedOauthStartPath("/api/m365/connect")).toBe(true);
    expect(isAllowedOauthStartPath("/api/google/callback")).toBe(false);
    expect(isAllowedOauthStartPath("/api/google/connect?x=1")).toBe(false);
    expect(isAllowedOauthStartPath(undefined)).toBe(false);
  });
});

// ── parseConnectField ────────────────────────────────────────────────────

describe("parseConnectField", () => {
  it("keeps a plain field and its optional parts", () => {
    expect(
      parseConnectField({ name: "imapPort", label: "Port", type: "number", required: true, secret: false, defaultValue: "993", placeholder: "993", help: "TLS port", pattern: "^\\d+$" }),
    ).toEqual({ name: "imapPort", label: "Port", type: "number", required: true, secret: false, defaultValue: "993", placeholder: "993", help: "TLS port", pattern: "^\\d+$" });
  });

  it("strips defaultValue from a secret field", () => {
    const f = parseConnectField({ name: "password", label: "Password", type: "password", required: true, secret: true, defaultValue: "hunter2" });
    expect(f).not.toBeNull();
    expect(f).not.toHaveProperty("defaultValue");
    expect(JSON.stringify(f)).not.toContain("hunter2");
  });

  it("coerces a secret text field to a password field", () => {
    expect(parseConnectField({ name: "apiKey", label: "Key", type: "text", required: true, secret: true, defaultValue: "rk_live_x" })).toEqual({
      name: "apiKey",
      label: "Key",
      type: "password",
      required: true,
      secret: true,
    });
  });

  it("treats a password-typed field as secret even when the flag is missing, and strips its default", () => {
    const f = parseConnectField({ name: "password", label: "Password", type: "password", defaultValue: "hunter2" });
    expect(f).toMatchObject({ type: "password", secret: true, required: false });
    expect(f).not.toHaveProperty("defaultValue");
  });

  it("drops an unparseable pattern but keeps the field", () => {
    const f = parseConnectField({ name: "host", label: "Host", type: "text", required: true, secret: false, pattern: "([" });
    expect(f).toMatchObject({ name: "host" });
    expect(f).not.toHaveProperty("pattern");
  });

  it.each([
    [{ name: "9bad", label: "x", type: "text" }],
    [{ name: "has-dash", label: "x", type: "text" }],
    [{ name: "", label: "x", type: "text" }],
    [{ name: "ok", label: "", type: "text" }],
    [{ name: "ok", label: "x", type: "textarea" }],
    ["not an object"],
    [null],
    [[]],
  ])("rejects %j", (v) => expect(parseConnectField(v as unknown)).toBeNull());
});

// ── parseConnectCard ─────────────────────────────────────────────────────

describe("parseConnectCard", () => {
  it("accepts a valid credentials card unchanged", () => {
    const card = credentialsCard({
      variants: [{ id: "custom-connection", label: "Custom connection", description: "For a Xero Custom Connection", fields: [{ name: "clientId", label: "Client id", type: "text", required: true, secret: false }] }],
      blocked: { reason: "already_connected", message: "Stripe is already connected. Manage it in Connectors." },
    });
    const parsed = parseConnectCard(card);
    expect(parsed).toEqual(card);
  });

  it("accepts a valid oauth card", () => {
    const parsed = parseConnectCard(oauthCard());
    expect(parsed).toMatchObject({ mode: "oauth", start: { path: "/api/google/connect" }, providerLabel: "Google" });
    expect((parsed as { options: unknown[] }).options).toHaveLength(2);
  });

  it("accepts a valid mailbox card, a valid calendar card and a valid wizard card", () => {
    expect(parseConnectCard(mailboxCard())).toMatchObject({ mode: "mailbox", post: { path: "/api/email/accounts" } });
    expect(parseConnectCard(calendarCard())).toMatchObject({ mode: "calendar", post: { path: "/api/calendar/sources" } });
    expect(parseConnectCard(wizardCard())).toMatchObject({ mode: "wizard", wizardHref: "/connectors?connect=eaglesoft", estimate: "about 10 minutes" });
  });

  it("is idempotent: parsing a parsed card changes nothing", () => {
    for (const raw of [credentialsCard(), oauthCard(), mailboxCard(), calendarCard(), wizardCard()]) {
      const once = parseConnectCard(raw) as ConnectCard;
      expect(once).not.toBeNull();
      expect(parseConnectCard(once)).toEqual(once);
    }
  });

  it("drops unknown keys", () => {
    const parsed = parseConnectCard({ ...credentialsCard(), authorization: "Bearer gho_secret", extra: { a: 1 } });
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toMatch(/gho_secret|authorization|extra/);
  });

  describe("credentials cards", () => {
    it.each([
      "/api/connectors/stripe/disconnect",
      "/api/files/upload",
      "https://evil.example/api/connectors/stripe/connect",
      "//evil.example/api/connectors/stripe/connect",
      "/api/connectors/../email/accounts",
      "/api/connectors/stripe/connect/extra",
      "/api/connectors/Stripe/connect",
    ])("rejects a post.path of %s that is off the allowlist", (path) => {
      expect(parseConnectCard(credentialsCard({ post: { path } }))).toBeNull();
    });

    it("rejects a card with no post at all", () => {
      expect(parseConnectCard(credentialsCard({ post: undefined }))).toBeNull();
      expect(parseConnectCard(credentialsCard({ post: "/api/connectors/stripe/connect" }))).toBeNull();
    });

    it("strips a default off a secret field and coerces it to a password field", () => {
      const parsed = parseConnectCard(
        credentialsCard({ fields: [{ name: "apiKey", label: "Key", type: "text", required: true, secret: true, defaultValue: "rk_live_prefilled" }] }),
      ) as Extract<ConnectCard, { mode: "credentials" }>;
      expect(parsed.fields[0]).toMatchObject({ type: "password", secret: true });
      expect(parsed.fields[0]).not.toHaveProperty("defaultValue");
      expect(JSON.stringify(parsed)).not.toContain("rk_live_prefilled");
    });

    it("strips a default off a secret field inside a variant too", () => {
      const parsed = parseConnectCard(
        credentialsCard({
          variants: [{ id: "pkce", label: "PKCE app", fields: [{ name: "clientSecret", label: "Secret", type: "text", secret: true, required: true, defaultValue: "s3cret" }] }],
        }),
      ) as Extract<ConnectCard, { mode: "credentials" }>;
      expect(parsed.variants?.[0].fields[0]).not.toHaveProperty("defaultValue");
      expect(JSON.stringify(parsed)).not.toContain("s3cret");
    });

    it("drops a duplicate field name and an invalid variant, keeping the rest", () => {
      const parsed = parseConnectCard(
        credentialsCard({
          fields: [KEY_FIELD, { ...KEY_FIELD, label: "Again" }, { name: "bad-name", label: "x", type: "text" }],
          variants: [{ id: "BAD ID", label: "x", fields: [] }, { id: "ok", label: "Fine", fields: [] }],
        }),
      ) as Extract<ConnectCard, { mode: "credentials" }>;
      expect(parsed.fields.map((f) => f.name)).toEqual(["apiKey"]);
      expect(parsed.variants?.map((v) => v.id)).toEqual(["ok"]);
    });
  });

  describe("same-origin hrefs", () => {
    it.each(["https://evil.example/settings", "//evil.example", "/a/../b", "/a/%2e%2e/b", "javascript:alert(1)", ""])(
      "rejects the whole card when manageHref is %j",
      (manageHref) => {
        for (const raw of [credentialsCard({ manageHref }), oauthCard({ manageHref }), mailboxCard({ manageHref }), calendarCard({ manageHref }), wizardCard({ manageHref })]) {
          expect(parseConnectCard(raw)).toBeNull();
        }
      },
    );

    it.each(["https://evil.example/help", "//evil.example", "/a/../b"])("drops an off-origin helpHref %j but keeps the card", (helpHref) => {
      const parsed = parseConnectCard(credentialsCard({ helpHref }));
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty("helpHref");
    });

    it.each(["https://evil.example/integrations", "//evil.example", "/a/../b", "integrations"])("rejects a wizard card whose wizardHref is %j", (wizardHref) => {
      expect(parseConnectCard(wizardCard({ wizardHref }))).toBeNull();
    });
  });

  describe("oauth cards", () => {
    it.each(["/api/google/callback", "/api/connectors/stripe/connect", "/api/m365/connect/", "https://accounts.google.com/o/oauth2/auth", "/api/google/connect?x=1", ""])(
      "rejects start.path %j",
      (path) => expect(parseConnectCard(oauthCard({ start: { path } }))).toBeNull(),
    );

    it("accepts the Microsoft start path", () => {
      expect(parseConnectCard(oauthCard({ provider: "m365", family: "m365", displayName: "Microsoft 365", providerLabel: "Microsoft", start: { path: "/api/m365/connect" } }))).toMatchObject({
        mode: "oauth",
        start: { path: "/api/m365/connect" },
      });
    });

    it("rejects an oauth card with no provider label, and an empty options list is fine", () => {
      expect(parseConnectCard(oauthCard({ providerLabel: "" }))).toBeNull();
      expect(parseConnectCard(oauthCard({ options: [] }))).toMatchObject({ options: [] });
    });

    it("drops options whose key is not a plain camel-case word", () => {
      const parsed = parseConnectCard(
        oauthCard({ options: [{ name: "mail", label: "Mail", defaultChecked: true }, { name: "Mail Box", label: "x", defaultChecked: true }, { name: "../x", label: "y", defaultChecked: true }] }),
      ) as Extract<ConnectCard, { mode: "oauth" }>;
      expect(parsed.options.map((o) => o.name)).toEqual(["mail"]);
    });
  });

  describe("mailbox and calendar cards", () => {
    it.each([
      "/api/calendar/sources",
      "/api/connectors/stripe/connect",
      "/api/email/accounts/abc",
      "https://evil.example/api/email/accounts",
      "//evil.example/api/email/accounts",
      "",
    ])("rejects a mailbox card whose post.path is %j", (path) => {
      expect(parseConnectCard(mailboxCard({ post: { path } }))).toBeNull();
    });

    it.each(["/api/email/accounts", "/api/connectors/stripe/connect", "https://evil.example/api/calendar/sources"])(
      "rejects a calendar card whose post.path is %j",
      (path) => {
        expect(parseConnectCard(calendarCard({ post: { path } }))).toBeNull();
      },
    );

    it("never lets a default through on the mailbox password", () => {
      const parsed = parseConnectCard(
        mailboxCard({
          fields: [{ name: "password", label: "Password", type: "text", required: true, secret: true, defaultValue: "hunter2" }],
        }),
      ) as Extract<ConnectCard, { mode: "mailbox" }>;
      expect(parsed.fields[0]).toMatchObject({ type: "password", secret: true });
      expect(JSON.stringify(parsed)).not.toContain("hunter2");
    });
  });

  describe("envelope", () => {
    it.each([
      ["not a card", { kind: "something_else" }],
      ["a string", "connect_card"],
      ["null", null],
      ["an array", []],
      ["no summary", credentialsCard({ summary: "" })],
      ["a bad provider key", credentialsCard({ provider: "Stripe!" })],
      ["a provider key that is too long", credentialsCard({ provider: "a".repeat(65) })],
      ["an unknown family", credentialsCard({ family: "ftp" })],
      ["an unknown scope", credentialsCard({ scope: "everyone" })],
      ["an unknown safety", credentialsCard({ safety: "setup-offline" })],
      ["an unknown mode", credentialsCard({ mode: "magic" })],
      ["a summary over the cap", credentialsCard({ summary: "x".repeat(401) })],
    ])("returns null for %s", (_label, raw) => expect(parseConnectCard(raw as unknown)).toBeNull());

    it("keeps a well-formed blocked block and drops a malformed one", () => {
      expect(parseConnectCard(credentialsCard({ blocked: { reason: "role", message: "Only owners and admins can add box-wide connections like Stripe.", requiredRole: "admin" } }))).toMatchObject({
        blocked: { reason: "role", requiredRole: "admin" },
      });
      for (const blocked of [{ reason: "nope", message: "x" }, { reason: "role" }, { reason: "role", message: "" }, "role"]) {
        const parsed = parseConnectCard(credentialsCard({ blocked }));
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty("blocked");
      }
      const odd = parseConnectCard(credentialsCard({ blocked: { reason: "role", message: "x", requiredRole: "superuser" } }));
      expect(odd?.blocked).toEqual({ reason: "role", message: "x" });
    });
  });
});

// ── parseConnectionsOverview ─────────────────────────────────────────────

describe("parseConnectionsOverview", () => {
  const available = { provider: "google", family: "google", displayName: "Google", category: "Mail and calendar", scope: "personal", canConnect: true };

  it("accepts a valid overview and computes the counts itself", () => {
    const parsed = parseConnectionsOverview({
      kind: "connections_overview",
      connected: [row(), row({ id: "google:me", family: "google", provider: "google", displayName: "Google", scope: "personal", status: "needs_attention", statusDetail: "Sign in again to resume", canReconnect: true })],
      available: [available],
      counts: { connected: 99, needsAttention: 99, available: 99 },
      boxWideVisible: true,
    });
    expect(parsed).toEqual({
      kind: "connections_overview",
      connected: expect.any(Array),
      available: [available],
      counts: { connected: 2, needsAttention: 1, available: 1 },
      boxWideVisible: true,
    });
    expect(parsed?.connected[1]).toMatchObject({ status: "needs_attention", canReconnect: true, statusDetail: "Sign in again to resume" });
  });

  it("drops invalid rows, keeps the rest and recomputes the counts", () => {
    const parsed = parseConnectionsOverview({
      kind: "connections_overview",
      connected: [
        row(),
        row({ id: "integration:bad", status: "exploded" }), // unknown status
        row({ id: "integration:evil", manageHref: "https://evil.example/integrations" }), // off-origin
        row({ id: "integration:nofamily", family: "ftp" }),
        row({ id: "", provider: "stripe" }),
        row({ id: "mailbox:1", family: "mailbox", provider: "mailbox", displayName: "Mailbox", status: "needs_attention", statusDetail: "Droplet could not sign in to the mail server" }),
        "not a row",
        null,
      ],
      available: [available, { provider: "NOT OK", family: "google", displayName: "x", scope: "personal" }, { provider: "calendar", family: "calendar", displayName: "Calendar feed", scope: "nobody" }],
      boxWideVisible: false,
    });
    expect(parsed?.connected.map((r) => r.id)).toEqual(["integration:stripe", "mailbox:1"]);
    expect(parsed?.available.map((a) => a.provider)).toEqual(["google"]);
    expect(parsed?.counts).toEqual({ connected: 2, needsAttention: 1, available: 1 });
    expect(parsed?.boxWideVisible).toBe(false);
  });

  it("caps rows at 64", () => {
    const many = Array.from({ length: 80 }, (_, i) => row({ id: `calendar:${i}`, family: "calendar", provider: "calendar", scope: "personal" }));
    expect(parseConnectionsOverview({ kind: "connections_overview", connected: many, available: [] })?.counts.connected).toBe(64);
  });

  it("treats a missing or malformed list as empty and boxWideVisible as strictly true", () => {
    expect(parseConnectionsOverview({ kind: "connections_overview" })).toEqual({
      kind: "connections_overview",
      connected: [],
      available: [],
      counts: { connected: 0, needsAttention: 0, available: 0 },
      boxWideVisible: false,
    });
    expect(parseConnectionsOverview({ kind: "connections_overview", connected: "nope", available: {}, boxWideVisible: "true" })?.boxWideVisible).toBe(false);
  });

  it.each([null, undefined, "connections_overview", [], { kind: "connect_card" }])("returns null for %j", (v) => expect(parseConnectionsOverview(v as unknown)).toBeNull());
});

describe("parseConnectionRow / parseAvailableConnection / parseConnectionDisconnected", () => {
  it("keeps optional row parts only when valid", () => {
    expect(parseConnectionRow(row({ detail: "desk@x.example", lastSyncAt: "2026-10-08T12:00:00.000Z" }))).toMatchObject({ detail: "desk@x.example", lastSyncAt: "2026-10-08T12:00:00.000Z" });
    expect(parseConnectionRow(row({ lastSyncAt: "yesterday-ish" }))).not.toHaveProperty("lastSyncAt");
  });

  it("reads the booleans strictly", () => {
    expect(parseConnectionRow(row({ canDisconnect: "yes", canReconnect: 1 }))).toMatchObject({ canDisconnect: false, canReconnect: false });
  });

  it("limits capabilities to short strings", () => {
    const parsed = parseConnectionRow(row({ capabilities: ["mail", 7, "", "x".repeat(200), "calendar"] }));
    expect(parsed?.capabilities).toEqual(["mail", "calendar"]);
  });

  it("validates an available connection", () => {
    expect(parseAvailableConnection({ provider: "stripe", family: "integration", displayName: "Stripe", scope: "box", canConnect: false })).toEqual({
      provider: "stripe",
      family: "integration",
      displayName: "Stripe",
      scope: "box",
      canConnect: false,
    });
    expect(parseAvailableConnection({ provider: "stripe", family: "integration", displayName: "Stripe", scope: "box" })?.canConnect).toBe(false);
    expect(parseAvailableConnection({ provider: "stripe", family: "nope", displayName: "Stripe", scope: "box" })).toBeNull();
  });

  it("validates a disconnect result", () => {
    expect(parseConnectionDisconnected({ kind: "connection_disconnected", provider: "google", family: "google", displayName: "Google", token: "ya29.x" })).toEqual({
      kind: "connection_disconnected",
      provider: "google",
      family: "google",
      displayName: "Google",
    });
    expect(parseConnectionDisconnected({ kind: "connection_disconnected", provider: "google", family: "ftp", displayName: "Google" })).toBeNull();
    expect(parseConnectionDisconnected({ kind: "connected" })).toBeNull();
  });
});

// ── connectOutcomeTurn ───────────────────────────────────────────────────

describe("connectOutcomeTurn", () => {
  it("words the three outcomes", () => {
    expect(connectOutcomeTurn("Stripe", "connected")).toBe("Stripe is connected now.");
    expect(connectOutcomeTurn("Stripe", "failed")).toBe("Connecting Stripe failed.");
    expect(connectOutcomeTurn("Stripe", "failed", "unauthorized")).toBe("Connecting Stripe failed (unauthorized).");
    expect(connectOutcomeTurn("Stripe", "cancelled")).toBe("I didn't connect Stripe.");
  });

  it("ignores a code on an outcome that does not take one", () => {
    expect(connectOutcomeTurn("Google", "connected", "ignored")).toBe("Google is connected now.");
    expect(connectOutcomeTurn("Google", "cancelled", "ignored")).toBe("I didn't connect Google.");
  });

  it("follows house style: no exclamation marks, no emoji", () => {
    for (const outcome of ["connected", "failed", "cancelled"] as const) {
      const text = connectOutcomeTurn("Microsoft 365", outcome, "timeout");
      expect(text).not.toContain("!");
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("a credentials card posts to its OWN provider's connect route", () => {
  it("names the route from the provider", () => {
    expect(credentialsConnectPath("stripe")).toBe("/api/connectors/stripe/connect");
  });

  it("accepts the matching route", () => {
    const card = parseConnectCard(credentialsCard({ provider: "stripe", post: { path: "/api/connectors/stripe/connect" } }));
    expect(card?.mode).toBe("credentials");
  });

  it.each([
    "/api/connectors/hubspot/connect", // another provider's allowlisted route
    "/api/email/accounts", // an allowlisted route of a different family
    "/api/calendar/sources",
  ])("refuses an allowlisted route that is not this provider's (%s)", (path) => {
    expect(parseConnectCard(credentialsCard({ provider: "stripe", post: { path } }))).toBeNull();
  });
});
