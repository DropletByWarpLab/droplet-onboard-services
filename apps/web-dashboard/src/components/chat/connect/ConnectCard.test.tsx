/**
 * WARP-3904 — a connect card: how Ask AI adds a connection without sending a
 * secret through the chat.
 *
 * The rules under test:
 *   - Secrets are password inputs, never pre-filled, cleared after every submit.
 *   - The card posts ONLY where its parsed descriptor says (or to the credentials
 *     route derived from an allowlisted connect path), and nothing typed ever
 *     reaches `onOutcome`, the console or a URL.
 *   - `onOutcome` fires once, on success only, with the fixed connected sentence.
 *   - A card that is not live is a compact row with nothing that posts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { connectOutcomeTurn, parseConnectCard, type ConnectCard as ConnectCardData } from "@droplet/shared-types";

const authFetch = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import { ConnectCard, type ConnectCardProps } from "./ConnectCard";
import { CONNECT_RETURN_KEY } from "./connect-return";

// ── Fixtures, built through the real parser so they can not drift from the contract ──

function card(raw: Record<string, unknown>): ConnectCardData {
  const parsed = parseConnectCard({ kind: "connect_card", scope: "box", manageHref: "/integrations", ...raw });
  if (!parsed) throw new Error("fixture is not a valid connect card");
  return parsed;
}

const stripe = (over: Record<string, unknown> = {}) =>
  card({
    provider: "stripe",
    family: "integration",
    displayName: "Stripe",
    summary: "Reads payouts, charges, customers · polled every 15 min",
    safety: "setup-internet",
    helpHref: "/help/integrations/stripe",
    mode: "credentials",
    fields: [
      { name: "apiKey", label: "Restricted key", type: "password", required: true, secret: true, help: "Starts with rk_live_ or rk_test_." },
      { name: "accountLabel", label: "Account label", type: "text", required: false, secret: false },
    ],
    post: { path: "/api/integrations/stripe/connect" },
    ...over,
  });

const atlassian = () =>
  card({
    provider: "atlassian",
    family: "integration",
    displayName: "Atlassian",
    summary: "Lets Droplet call Jira and Confluence on request",
    safety: "setup-internet",
    mode: "credentials",
    fields: [{ name: "apiToken", label: "API token", type: "password", required: true, secret: true }],
    post: { path: "/api/integrations/atlassian/connect" },
  });

const xero = () =>
  card({
    provider: "xero",
    family: "integration",
    displayName: "Xero",
    summary: "Reads invoices and bank feeds",
    safety: "setup-internet",
    mode: "credentials",
    fields: [{ name: "tenantId", label: "Tenant ID", type: "text", required: true, secret: false }],
    variants: [
      {
        id: "custom-connection",
        label: "Custom connection",
        fields: [
          { name: "clientId", label: "Client ID", type: "text", required: true, secret: false },
          { name: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
        ],
      },
      {
        id: "pkce-app",
        label: "App with PKCE",
        fields: [{ name: "clientId", label: "Client ID", type: "text", required: true, secret: false }],
      },
    ],
    post: { path: "/api/integrations/xero/connect" },
  });

const google = () =>
  card({
    provider: "google",
    family: "google",
    displayName: "Google",
    scope: "personal",
    summary: "Reads your mail and calendar so Droplet can answer questions about them",
    safety: "setup-internet",
    manageHref: "/settings#connected-accounts",
    mode: "oauth",
    providerLabel: "Google",
    options: [
      { name: "mail", label: "Mail", help: "search, summarize, draft replies you approve", defaultChecked: true },
      { name: "calendar", label: "Calendar", help: "read your events, suggest times", defaultChecked: true },
    ],
    start: { path: "/api/google/connect" },
  });

const m365 = () =>
  card({
    provider: "m365",
    family: "m365",
    displayName: "Microsoft 365",
    scope: "personal",
    summary: "Reads your Outlook mail and calendar",
    safety: "setup-internet",
    manageHref: "/settings#connected-accounts",
    mode: "oauth",
    providerLabel: "Microsoft",
    options: [],
    start: { path: "/api/m365/connect" },
  });

const mailbox = () =>
  card({
    provider: "mailbox",
    family: "mailbox",
    displayName: "Email account",
    summary: "Reads and drafts mail through your own IMAP and SMTP server",
    safety: "setup-internet",
    manageHref: "/settings#email",
    mode: "mailbox",
    fields: [
      { name: "displayName", label: "Name", type: "text", required: true, secret: false, placeholder: "Front desk" },
      { name: "address", label: "Email address", type: "email", required: true, secret: false },
      { name: "imapHost", label: "Incoming server (IMAP)", type: "text", required: true, secret: false },
      { name: "imapPort", label: "Incoming port", type: "number", required: true, secret: false, defaultValue: "993" },
      { name: "smtpHost", label: "Outgoing server (SMTP)", type: "text", required: true, secret: false },
      { name: "smtpPort", label: "Outgoing port", type: "number", required: true, secret: false, defaultValue: "465" },
      { name: "username", label: "Username", type: "text", required: true, secret: false },
      { name: "password", label: "Password", type: "password", required: true, secret: true, help: "Stored encrypted on this box." },
    ],
    post: { path: "/api/email/accounts" },
  });

const calendar = () =>
  card({
    provider: "calendar",
    family: "calendar",
    displayName: "Calendar feed",
    scope: "personal",
    summary: "Reads a CalDAV calendar or a public ICS link",
    safety: "setup-internet",
    manageHref: "/calendar",
    mode: "calendar",
    fields: [
      { name: "name", label: "Name", type: "text", required: true, secret: false },
      { name: "url", label: "Calendar address", type: "url", required: true, secret: false },
      { name: "username", label: "Username", type: "text", required: false, secret: false },
      { name: "password", label: "Password", type: "password", required: false, secret: true },
    ],
    post: { path: "/api/calendar/sources" },
  });

const wizard = () =>
  card({
    provider: "eaglesoft",
    family: "integration",
    displayName: "Eaglesoft",
    summary: "Reads patients and appointments from your practice server",
    safety: "setup-lan",
    mode: "wizard",
    steps: ["Find the server on your network", "Create Droplet's read-only database account", "Confirm and connect"],
    estimate: "about 10 minutes",
    wizardHref: "/integrations?connect=eaglesoft",
  });

// ── Harness ──────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Queue the responses the next authFetch calls resolve (an Error rejects). */
function script(...responses: Array<Response | Error>) {
  for (const r of responses) authFetch.mockImplementationOnce(() => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)));
}

/** What authFetch was asked to do, in order: just the target, method and body. */
function sent() {
  return authFetch.mock.calls.map(([url, init]) => ({
    url: url as string,
    method: (init as RequestInit | undefined)?.method,
    body: (init as RequestInit | undefined)?.body as string | undefined,
  }));
}

function setup(c: ConnectCardData, props: Partial<ConnectCardProps> = {}) {
  const onOutcome = vi.fn();
  const navigate = vi.fn();
  const utils = render(<ConnectCard card={c} interactive conversationId="conv-1" onOutcome={onOutcome} navigate={navigate} {...props} />);
  return { onOutcome, navigate, ...utils };
}

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));
const field = (label: RegExp | string) => screen.getByLabelText(label) as HTMLInputElement;

let consoleSpies: Array<{ mock: { calls: unknown[][] } }>;
/** Everything the page logged, as one string, so a leaked value can be searched for. */
const logged = () =>
  JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls.map((c) => c.map((a) => (a instanceof Error ? a.message : a)))));

beforeEach(() => {
  authFetch.mockReset();
  window.sessionStorage.clear();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECRET = "sk_test_5ecr3t-VALUE";
const CONNECTED_TURN = connectOutcomeTurn("Stripe", "connected");

// ── credentials ──────────────────────────────────────────────────────────

describe("ConnectCard — credentials form", () => {
  it("renders a password input for a secret field, empty, with autocomplete off", () => {
    setup(stripe());
    const key = field(/restricted key/i);
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    expect(key.value).toBe("");
    // The non-secret field is a plain text input.
    expect(field(/account label/i)).toHaveAttribute("type", "text");
  });

  it("never pre-fills a secret, even from a descriptor that did not go through the parser", () => {
    const sloppy = stripe();
    if (sloppy.mode !== "credentials") throw new Error("fixture");
    sloppy.fields[0] = { ...sloppy.fields[0], defaultValue: "sk_live_from_descriptor" };
    setup(sloppy);
    expect(field(/restricted key/i).value).toBe("");
    expect(document.body.innerHTML).not.toContain("sk_live_from_descriptor");
  });

  it("pre-fills a NON-secret default", () => {
    setup(mailbox());
    expect(field(/incoming port/i).value).toBe("993");
    expect(field(/outgoing port/i).value).toBe("465");
  });

  it("shows the title, summary, safety chip, lock note, guide link and both buttons", () => {
    setup(stripe());
    expect(screen.getByRole("heading", { name: "Connect Stripe" })).toBeInTheDocument();
    expect(screen.getByText("Reads payouts, charges, customers · polled every 15 min")).toBeInTheDocument();
    expect(screen.getByText("Setup · uses your internet")).toBeInTheDocument();
    expect(screen.getByText("This form posts to the box directly. Nothing you type here enters the conversation.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /setup guide/i })).toHaveAttribute("href", "/help/integrations/stripe");
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeDisabled();
  });

  it("wears the LAN chip for a LAN target", () => {
    setup(stripe({ safety: "setup-lan" }));
    expect(screen.getByText("Setup · stays on your box")).toBeInTheDocument();
  });

  it("every input has a real label", () => {
    const { container } = setup(mailbox());
    const inputs = Array.from(container.querySelectorAll("input"));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.labels?.length, `input "${input.name}" has no <label>`).toBeGreaterThan(0);
    }
  });

  it("enables Connect only when the required fields are filled", () => {
    setup(stripe());
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeDisabled();
    type(/restricted key/i, "   ");
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeDisabled();
    type(/restricted key/i, SECRET);
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeEnabled();
  });

  it("checks a typed value against the field's pattern after the person leaves the field", () => {
    setup(
      stripe({
        fields: [{ name: "apiKey", label: "Restricted key", type: "password", required: true, secret: true, pattern: "^rk_(live|test)_[A-Za-z0-9]+$" }],
      }),
    );
    type(/restricted key/i, "nope");
    fireEvent.blur(field(/restricted key/i));
    expect(screen.getByText("That doesn't look right. Check you copied the whole value.")).toBeInTheDocument();
    expect(field(/restricted key/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeDisabled();
    type(/restricted key/i, "rk_test_abc123");
    expect(screen.getByRole("button", { name: "Connect Stripe" })).toBeEnabled();
  });

  it("saves with PATCH /credentials then checks with POST /connect and an empty body, and nothing else", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([
      { url: "/api/integrations/stripe/credentials", method: "PATCH", body: JSON.stringify({ fields: { apiKey: SECRET } }) },
      { url: "/api/integrations/stripe/connect", method: "POST", body: "{}" },
    ]);
    // The JSON headers the hub sends, on both calls.
    for (const [, init] of authFetch.mock.calls) expect((init as RequestInit).headers).toEqual({ "Content-Type": "application/json" });
  });

  it("calls onOutcome exactly once, with the connected sentence and nothing that was typed", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    const { onOutcome, rerender } = setup(stripe());
    type(/restricted key/i, SECRET);
    type(/account label/i, "Main shop");
    click("Connect Stripe");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(onOutcome).toHaveBeenCalledWith(CONNECTED_TURN);
    expect(CONNECTED_TURN).toBe("Stripe is connected now.");
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain("Main shop");

    // The connected state survives the next turn making this card "old".
    rerender(<ConnectCard card={stripe()} interactive={false} conversationId="conv-1" onOutcome={onOutcome} />);
    expect(screen.getByTestId("connect-card-connected")).toBeInTheDocument();
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it("shows the connected state, with no form left on screen and the secret nowhere in the page", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");

    expect(await screen.findByText("Connected to Stripe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage in Integrations" })).toHaveAttribute("href", "/integrations");
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(logged()).not.toContain(SECRET);
  });

  it("omits an untouched field rather than sending it as an empty string", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(sent()[0].body as string)).toEqual({ fields: { apiKey: SECRET } });
  });

  it("takes the state the save returned for an MCP paste, and never calls /connect", async () => {
    script(json({ state: "CONNECTED" }));
    const { onOutcome } = setup(atlassian());
    type(/api token/i, SECRET);
    click("Connect Atlassian");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith("Atlassian is connected now."));
    expect(sent()).toEqual([{ url: "/api/integrations/atlassian/credentials", method: "PATCH", body: JSON.stringify({ fields: { apiToken: SECRET } }) }]);
  });

  it("shows a rejected key as an alert, clears the secret, and does not call onOutcome", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "NEEDS_RECONNECT" }));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Stripe didn't accept that key");
    expect(alert).toHaveTextContent("Check it's current and has read access, then paste it again.");
    expect(field(/restricted key/i).value).toBe("");
    expect(onOutcome).not.toHaveBeenCalled();
    // Focus goes back to the field that has to be retyped.
    await waitFor(() => expect(field(/restricted key/i)).toHaveFocus());
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(logged()).not.toContain(SECRET);
  });

  it("lets the person try again after a rejection and still calls onOutcome only once", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "NEEDS_RECONNECT" }));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    await screen.findByRole("alert");

    // Nothing to send until the key is typed again.
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    type(/restricted key/i, "sk_test_second");
    click("Try again");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sent()[2].body as string)).toEqual({ fields: { apiKey: "sk_test_second" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["the vendor refusing the connection", json({ status: "ERROR" }), /refused the connection/],
    ["an unconfirmed state", json({ status: "PROVISIONING" }), /couldn't confirm the connection to Stripe/],
  ])("treats %s as a failure and sends nothing to the model", async (_label, verdict, copy) => {
    script(json({ state: "PROVISIONING" }), verdict);
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't connect to Stripe");
    expect(alert).toHaveTextContent(copy);
    expect(field(/restricted key/i).value).toBe("");
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ["a plan limit", "CAPABILITY_LIMITED", /needs a plan or permission change at the vendor/],
    ["a flaky vendor", "DEGRADED", /isn't answering reliably right now/],
  ])("counts %s as connected and says what is limited", async (_label, status, note) => {
    script(json({ state: "PROVISIONING" }), json({ status }));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("connect-card-connected")).toHaveTextContent(note);
  });

  it("shows the field messages a validation error names, never a value, and skips the check call", async () => {
    script(json({ error: "validation", details: { fieldErrors: { apiKey: ["Key is too short."] } } }, 400));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Stripe didn't accept that key");
    expect(alert).toHaveTextContent("Key is too short.");
    expect(sent()).toHaveLength(1);
    expect(field(/restricted key/i).value).toBe("");
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it.each([
    [401, /session expired/],
    [403, /Only an owner or admin can connect this\./],
    [500, /Something went wrong on the box/],
  ])("answers a %i from the save in plain words", async (status, copy) => {
    script(json({}, status));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(field(/restricted key/i).value).toBe("");
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("survives a dropped connection, clears the secret and keeps it out of the console", async () => {
    script(new TypeError("Failed to fetch"));
    const { onOutcome } = setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    expect(await screen.findByRole("alert")).toHaveTextContent("Droplet couldn't reach itself. Check your connection and try again.");
    expect(field(/restricted key/i).value).toBe("");
    expect(onOutcome).not.toHaveBeenCalled();
    expect(logged()).not.toContain(SECRET);
  });

  it("does not submit twice while a check is running", async () => {
    let release: (r: Response) => void = () => undefined;
    authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    setup(stripe());
    type(/restricted key/i, SECRET);
    fireEvent.submit(screen.getByTestId("connect-card").querySelector("form") as HTMLFormElement);
    fireEvent.submit(screen.getByTestId("connect-card").querySelector("form") as HTMLFormElement);
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    release(json({}, 500));
    await screen.findByRole("alert");
  });

  it("clears a key typed for one way of connecting before showing another, and sends the variant it picked", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "CONNECTED" }));
    const { onOutcome } = setup(xero());
    type(/tenant id/i, "tenant-1");
    type(/client id/i, "client-1");
    type(/client secret/i, SECRET);

    fireEvent.click(screen.getByRole("radio", { name: /app with pkce/i }));
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /custom connection/i }));
    expect(field(/client secret/i).value).toBe("");

    type(/client secret/i, "second-secret");
    click("Connect Xero");
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sent()[0].body as string)).toEqual({
      fields: { tenantId: "tenant-1", clientId: "client-1", clientSecret: "second-secret", credentialVariant: "custom-connection" },
    });
  });
});

// ── Not now ──────────────────────────────────────────────────────────────

describe("ConnectCard — Not now", () => {
  it.each([
    ["credentials", stripe],
    ["oauth", google],
    ["mailbox", mailbox],
    ["calendar", calendar],
    ["wizard", wizard],
  ])("collapses a %s card to the compact row without calling onOutcome or the box", (_mode, make) => {
    const { onOutcome, navigate } = setup(make());
    click("Not now");
    expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

// ── Not live ─────────────────────────────────────────────────────────────

describe("ConnectCard — interactive=false", () => {
  it.each([
    ["credentials", stripe, "Stripe", "/integrations", "Manage in Integrations"],
    ["oauth", google, "Google", "/settings#connected-accounts", "Manage in Settings"],
    ["mailbox", mailbox, "Email account", "/settings#email", "Manage in Settings"],
    ["calendar", calendar, "Calendar feed", "/calendar", "Manage"],
    ["wizard", wizard, "Eaglesoft", "/integrations", "Manage in Integrations"],
  ])("renders a %s card as a compact row with no inputs and no buttons", (_mode, make, name, href, linkText) => {
    const { onOutcome } = setup(make(), { interactive: false });
    const row = screen.getByTestId("connect-card-compact");
    expect(within(row).getByText(name)).toBeInTheDocument();
    expect(row).toHaveTextContent(make().summary);
    expect(within(row).getByRole("link", { name: linkText })).toHaveAttribute("href", href);
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("renders a blocked card as the compact row too, never a live panel", () => {
    setup(stripe({ blocked: { reason: "role", message: "Only owners and admins can add box-wide connections like Stripe." } }), { interactive: false });
    expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-card-blocked")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("goes from a live form to the compact row when the card stops being the newest, without posting", () => {
    const { rerender, onOutcome } = setup(stripe());
    expect(screen.getByLabelText(/restricted key/i)).toBeInTheDocument();
    rerender(<ConnectCard card={stripe()} interactive={false} conversationId="conv-1" onOutcome={onOutcome} />);
    expect(screen.queryByLabelText(/restricted key/i)).toBeNull();
    expect(screen.getByTestId("connect-card-compact")).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

// ── Blocked ──────────────────────────────────────────────────────────────

describe("ConnectCard — blocked", () => {
  const message = "Only owners and admins can add box-wide connections like Stripe.";

  it("renders the message and no inputs, even for a card that carries fields", () => {
    const { onOutcome } = setup(stripe({ blocked: { reason: "role", message, requiredRole: "admin" } }));
    const panel = screen.getByTestId("connect-card-blocked");
    expect(panel).toHaveAttribute("data-reason", "role");
    expect(panel).toHaveTextContent("Ask an owner or admin");
    expect(panel).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /connect stripe/i })).toBeNull();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["role", "Ask an owner or admin"],
    ["already_connected", "Stripe is already connected"],
    ["setup_required", "Set up Stripe first"],
    ["unavailable", "Stripe isn't available yet"],
  ])("titles a %s block in plain words", (reason, title) => {
    setup(stripe({ blocked: { reason, message } }));
    expect(screen.getByTestId("connect-card-blocked")).toHaveTextContent(title);
  });

  it("offers a member the one alternative it can: a plain turn asking for their own Google account", () => {
    const { onOutcome } = setup(
      card({ ...JSON.parse(JSON.stringify(google())), blocked: { reason: "role", message: "Only owners and admins can add this. You can still connect your own account." } }),
    );
    const button = screen.getByRole("button", { name: "Connect my own Google instead" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith("Connect my Google account");
    expect(button).toBeDisabled();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

// ── oauth ────────────────────────────────────────────────────────────────

describe("ConnectCard — OAuth", () => {
  const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz";

  it("shows the options, the provider note and the Continue button", () => {
    setup(google());
    expect(screen.getByRole("heading", { name: "Connect Google" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /mail/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /calendar/i })).toBeChecked();
    expect(
      screen.getByText("Sign-in happens on Google's site. Droplet never sees your password. Disconnecting deletes the token from the box."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("writes the return record BEFORE the call, posts start.path with the options and returnTo, and navigates to the returned https URL only", async () => {
    let recordDuringCall: string | null = null;
    authFetch.mockImplementationOnce(() => {
      recordDuringCall = window.sessionStorage.getItem(CONNECT_RETURN_KEY);
      return Promise.resolve(json({ authorizeUrl: AUTHORIZE }));
    });
    const { onOutcome, navigate } = setup(google());
    click("Continue with Google");

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE);
    expect(sent()).toEqual([
      { url: "/api/google/connect", method: "POST", body: JSON.stringify({ mail: true, calendar: true, returnTo: "/chat" }) },
    ]);

    expect(recordDuringCall).not.toBeNull();
    const record = JSON.parse(window.sessionStorage.getItem(CONNECT_RETURN_KEY) as string) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["at", "conversationId", "displayName", "provider"]);
    expect(record).toMatchObject({ conversationId: "conv-1", provider: "google", displayName: "Google" });
    expect(typeof record.at).toBe("number");
    // Leaving the page is not a connection yet: the model hears nothing until the return.
    expect(onOutcome).not.toHaveBeenCalled();
    // Busy stays on so a second click can not start a second sign-in.
    expect(screen.getByRole("button", { name: "Opening Google…" })).toBeDisabled();
  });

  it("sends only the scopes that are ticked", async () => {
    script(json({ authorizeUrl: AUTHORIZE }));
    const { navigate } = setup(google());
    fireEvent.click(screen.getByRole("checkbox", { name: /calendar/i }));
    click("Continue with Google");
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(JSON.parse(sent()[0].body as string)).toEqual({ mail: true, calendar: false, returnTo: "/chat" });
  });

  it("will not continue with nothing ticked", () => {
    setup(google());
    fireEvent.click(screen.getByRole("checkbox", { name: /mail/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /calendar/i }));
    expect(screen.getByText("Choose at least one to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
  });

  it("starts a Microsoft sign-in that has no options with just returnTo, under the m365 record", async () => {
    script(json({ authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1" }));
    const { navigate } = setup(m365());
    click("Continue with Microsoft");
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ url: "/api/m365/connect", method: "POST", body: JSON.stringify({ returnTo: "/chat" }) }]);
    expect(JSON.parse(window.sessionStorage.getItem(CONNECT_RETURN_KEY) as string)).toMatchObject({ provider: "m365", displayName: "Microsoft 365" });
  });

  it.each([
    ["a plain http URL", json({ authorizeUrl: "http://accounts.google.com/auth" })],
    ["a javascript: URL", json({ authorizeUrl: "javascript:void(0)" })],
    ["a relative URL", json({ authorizeUrl: "/api/google/callback" })],
    ["no URL at all", json({})],
    ["a server error", json({ error: "no_app" }, 500)],
  ])("never navigates when the box answers with %s, shows an alert and leaves no record behind", async (_label, response) => {
    script(response);
    const { navigate, onOutcome } = setup(google());
    click("Continue with Google");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't start Google sign-in");
    expect(alert).toHaveTextContent(/Droplet could not start Google sign-in/);
    expect(navigate).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("survives a dropped connection while starting", async () => {
    script(new TypeError("Failed to fetch"));
    const { navigate } = setup(google());
    click("Continue with Google");
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection and try again");
    expect(navigate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });
});

// ── mailbox ──────────────────────────────────────────────────────────────

describe("ConnectCard — mailbox", () => {
  function fillMailbox() {
    type(/^name/i, "Front desk");
    type(/^email address/i, "desk@acme.test");
    type(/incoming server/i, "mail.acme.test");
    type(/outgoing server/i, "smtp.acme.test");
    type(/^username/i, "desk@acme.test");
    type(/^password/i, "hunter2-correct-horse");
  }

  it("posts the existing form's body, with numeric ports and TLS on, to /api/email/accounts only", async () => {
    script(json({ id: "acct-1" }, 201));
    const { onOutcome } = setup(mailbox());
    fillMailbox();
    click("Check and save");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ url: "/api/email/accounts", method: "POST" });
    expect(JSON.parse(sent()[0].body as string)).toEqual({
      displayName: "Front desk",
      address: "desk@acme.test",
      imapHost: "mail.acme.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.acme.test",
      smtpPort: 465,
      smtpTls: true,
      username: "desk@acme.test",
      password: "hunter2-correct-horse",
    });
    expect(onOutcome).toHaveBeenCalledWith("Email account is connected now.");
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain("hunter2");
  });

  it("uses a password input for the password and a real email input for the address", () => {
    setup(mailbox());
    expect(field(/^password/i)).toHaveAttribute("type", "password");
    expect(field(/^password/i)).toHaveAttribute("autocomplete", "off");
    expect(field(/^email address/i)).toHaveAttribute("type", "email");
  });

  it("keeps Check and save disabled until every required field is filled", () => {
    setup(mailbox());
    expect(screen.getByRole("button", { name: "Check and save" })).toBeDisabled();
    fillMailbox();
    expect(screen.getByRole("button", { name: "Check and save" })).toBeEnabled();
  });

  it("explains a refused login, clears only the password, keeps the rest for a retry and logs nothing typed", async () => {
    script(json({ error: "email_mailbox_refused" }, 400));
    const { onOutcome } = setup(mailbox());
    fillMailbox();
    click("Check and save");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email account didn't accept those details");
    expect(field(/^password/i).value).toBe("");
    expect(field(/incoming server/i).value).toBe("mail.acme.test");
    expect(onOutcome).not.toHaveBeenCalled();
    expect(logged()).not.toContain("hunter2");
    expect(document.body.innerHTML).not.toContain("hunter2");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });
});

// ── calendar ─────────────────────────────────────────────────────────────

describe("ConnectCard — calendar", () => {
  it("says both halves are needed when only a username is typed, and does not post", async () => {
    const { onOutcome } = setup(calendar());
    type(/^name/i, "Personal iCloud");
    type(/calendar address/i, "https://caldav.example.test/me");
    type(/^username/i, "me@example.test");
    click("Add calendar");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Signing in needs both a username and a password.");
    expect(authFetch).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("says the same when only a password is typed, and clears it", async () => {
    setup(calendar());
    type(/^name/i, "Personal iCloud");
    type(/calendar address/i, "https://caldav.example.test/me");
    type(/^password/i, "app-specific-pass");
    click("Add calendar");

    expect(await screen.findByRole("alert")).toHaveTextContent("both a username and a password");
    expect(authFetch).not.toHaveBeenCalled();
    expect(field(/^password/i).value).toBe("");
  });

  it("posts a public link with authMode none and no credentials", async () => {
    script(json({ id: "src-1" }, 201));
    const { onOutcome } = setup(calendar());
    type(/^name/i, "Holidays");
    type(/calendar address/i, "https://calendars.example.test/holidays.ics");
    click("Add calendar");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([
      {
        url: "/api/calendar/sources",
        method: "POST",
        body: JSON.stringify({ name: "Holidays", url: "https://calendars.example.test/holidays.ics", authMode: "none" }),
      },
    ]);
    expect(onOutcome).toHaveBeenCalledWith("Calendar feed is connected now.");
  });

  it("posts basic auth when both halves are typed", async () => {
    script(json({ id: "src-2" }, 201));
    const { onOutcome } = setup(calendar());
    type(/^name/i, "Personal iCloud");
    type(/calendar address/i, "https://caldav.example.test/me");
    type(/^username/i, "me@example.test");
    type(/^password/i, "app-specific-pass");
    click("Add calendar");

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sent()[0].body as string)).toEqual({
      name: "Personal iCloud",
      url: "https://caldav.example.test/me",
      username: "me@example.test",
      password: "app-specific-pass",
      authMode: "basic",
    });
    expect(JSON.stringify(onOutcome.mock.calls)).not.toContain("app-specific-pass");
  });
});

// ── wizard ───────────────────────────────────────────────────────────────

describe("ConnectCard — wizard hand-off", () => {
  it("lists the steps and links to the wizard, with no form", () => {
    const { onOutcome } = setup(wizard());
    expect(screen.getByRole("heading", { name: "Connect Eaglesoft" })).toBeInTheDocument();
    expect(screen.getByText("Setup · stays on your box")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Takes about 10 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the wizard" })).toHaveAttribute("href", "/integrations?connect=eaglesoft");
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

// ── House style ──────────────────────────────────────────────────────────

describe("ConnectCard — copy", () => {
  it.each([
    ["credentials", stripe],
    ["oauth", google],
    ["mailbox", mailbox],
    ["calendar", calendar],
    ["wizard", wizard],
  ])("a live %s card has no exclamation marks and no emoji", (_mode, make) => {
    const { container } = setup(make());
    const text = container.textContent ?? "";
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the failure block has no exclamation marks or emoji either", async () => {
    script(json({ state: "PROVISIONING" }), json({ status: "NEEDS_RECONNECT" }));
    setup(stripe());
    type(/restricted key/i, SECRET);
    click("Connect Stripe");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("!");
    expect(alert.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
