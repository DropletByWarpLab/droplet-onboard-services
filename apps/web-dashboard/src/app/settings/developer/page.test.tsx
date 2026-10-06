/**
 * WARP-3533 — /settings/developer page tests.
 *
 * Contract under test:
 *   1. owner/admin (`isAdmin`) see the switch and everyone's tokens; a member
 *      sees neither, and never asks for everyone's tokens;
 *   2. an external guest is gated, in the nav and on the page;
 *   3. switch off: a member sees that it is off, and their own tokens with
 *      Revoke only (no create form);
 *   4. a created token is shown once and is gone after dismiss; what is sent is
 *      the name, the scopes picked and an expiry (or none);
 *   5. revoke goes through the confirm dialog and calls DELETE;
 *   6. with nothing to reach (Projects off) there is no form, only the reason;
 *   7. the OpenAPI document is fetched with the session, not linked;
 *   8. calendar links: "My work" and each project, created once, shown once with
 *      the whole address, turned off through a confirm; Projects off says so;
 *   9. the example carries the real address and never a real token;
 *   10. copy says "member", never the `family` wire value.
 *
 * ShellPage is mocked to a passthrough and `authFetch` routes on the URL — no
 * network. A fresh SWR cache per render keeps cases independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

const authFetch = vi.fn();
const userRef: { current: { role: string } } = { current: { role: "owner" } };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: userRef.current }),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import DeveloperPage from "./page";
import { settingsGroups } from "@/components/nav-config";

const SECRET = "dpm_" + "S".repeat(43);
const FEED_URL_PATH = "/api/calendar/publish/maria/my-work.ics?token=link-1." + "F".repeat(43);

const SCOPES = [
  { id: "pm:read", label: "Read projects", description: "List and read projects, work items, comments and activity." },
  { id: "pm:write", label: "Read and change projects", description: "Everything above, plus create, edit and delete work, as you." },
];

const ROW = {
  id: "tok-1",
  name: "Nightly export",
  prefix: "AbCd1234",
  scopes: ["pm:read"],
  status: "active",
  createdAt: "2026-10-01T10:00:00Z",
  expiresAt: "2027-01-01T10:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    canCreate: true,
    isAdmin: false,
    scopes: SCOPES,
    tokens: [] as unknown[],
    openapiPath: "/api/pm/openapi.json",
    ...overrides,
  };
}

const FEEDS = [
  { kind: "my_work", projectId: null, name: "My work", identifier: null, state: "none", createdAt: null, expiresAt: null },
  { kind: "project", projectId: "p-abc", name: "Alpha build", identifier: "ABC", state: "active", createdAt: "2026-10-01T10:00:00Z", expiresAt: "2027-03-30T10:00:00Z" },
  { kind: "project", projectId: "p-xyz", name: "Xylophone", identifier: "XYZ", state: "none", createdAt: null, expiresAt: null },
];

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  blob: async () => new Blob([JSON.stringify(body)], { type: "application/json" }),
});

function serve(s: ReturnType<typeof state>, all: unknown[] = [], feeds: unknown = { feeds: FEEDS }, feedsStatus = 200) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/developer" && method === "GET") return res(s);
    if (url === "/api/developer/tokens/all") return res({ tokens: all });
    if (url === "/api/developer/settings" && method === "PUT") return res({ ...s, enabled: JSON.parse(String(init?.body)).enabled });
    if (url === "/api/developer/tokens" && method === "POST") return res({ token: SECRET, row: ROW }, 201);
    if (url.startsWith("/api/developer/tokens/") && method === "DELETE") return res(null, 204);
    if (url === "/api/developer/feeds" && method === "GET") return res(feeds, feedsStatus);
    if (url === "/api/developer/feeds/rotate" && method === "POST") return res({ url: FEED_URL_PATH, expiresAt: "2027-04-01T00:00:00Z" });
    if (url === "/api/developer/feeds/revoke" && method === "POST") return res({ revoked: 1 });
    if (url === "/api/pm/openapi.json") return res({ openapi: "3.1.0" });
    return res({ error: "not_found" }, 404);
  });
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DeveloperPage />
    </SWRConfig>,
  );
}

const calledWith = (url: string) => authFetch.mock.calls.some(([u]) => u === url);
const bodyOf = (url: string, method: string) => {
  const call = authFetch.mock.calls.find(([u, init]) => u === url && (init as RequestInit | undefined)?.method === method);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

beforeEach(() => {
  authFetch.mockReset();
  userRef.current = { role: "owner" };
});
afterEach(() => vi.restoreAllMocks());

describe("who sees the admin controls", () => {
  it("an owner/admin sees the switch and everyone's tokens", async () => {
    serve(state({ isAdmin: true }), [{ ...ROW, user: { id: "u2", displayName: "Sam Rivera" } }]);
    renderPage();
    expect(await screen.findByRole("switch", { name: "Allow API tokens" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("Sam Rivera")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Everyone's tokens" })).toBeInTheDocument();
    expect(screen.getByText(/off by default/i)).toHaveTextContent(/none are deleted/i);
  });

  it("an admin flipping the switch saves it", async () => {
    serve(state({ isAdmin: true }));
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: /allow api tokens/i }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        "/api/developer/settings",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
      ),
    );
  });

  it("a member sees neither, and never asks for everyone's tokens", async () => {
    userRef.current = { role: "family" };
    serve(state());
    renderPage();
    expect(await screen.findByRole("heading", { name: "Your tokens" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Everyone's tokens" })).toBeNull();
    expect(calledWith("/api/developer/tokens/all")).toBe(false);
  });

  it("says member, never the family wire value", async () => {
    serve(state({ isAdmin: true }));
    renderPage();
    await screen.findByRole("switch");
    expect(document.body.textContent).toMatch(/owners, admins and members/i);
    expect(document.body.textContent).not.toMatch(/\bfamily\b/i);
  });
});

describe("an external guest is gated", () => {
  it("gets a not-allowed state, and the page never asks the box", () => {
    userRef.current = { role: "guest" };
    renderPage();
    expect(screen.getByText(/aren.t available to guests/i)).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("renders the same state when the box answers 403", async () => {
    authFetch.mockResolvedValue(res({ error: "role_not_allowed" }, 403));
    renderPage();
    expect(await screen.findByText(/aren.t available to guests/i)).toBeInTheDocument();
  });

  it("is offered in the Settings nav to owner, admin and member, and not to a guest", () => {
    const hrefs = (role: "owner" | "admin" | "guest" | "family") =>
      settingsGroups(role, { claudeActivity: true, ragEval: true, medicalConnector: true }, () => true).flatMap((g) =>
        g.items.map((i) => i.href),
      );
    for (const role of ["owner", "admin", "family"] as const) expect(hrefs(role)).toContain("/settings/developer");
    expect(hrefs("guest")).not.toContain("/settings/developer");
  });
});

describe("switch off", () => {
  it("a member sees that it is off, and can still revoke their own tokens", async () => {
    // Off does not revoke: the token is still active and would work again
    // when the switch comes back on, so a lost laptop's token must be killable.
    userRef.current = { role: "family" };
    serve(state({ enabled: false, canCreate: false, tokens: [ROW] }));
    renderPage();
    expect(await screen.findByText(/your admin hasn.t turned on api tokens/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your tokens" })).toBeInTheDocument();
    expect(screen.getByText("dpm_AbCd1234…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Revoke ${ROW.name}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create token/i })).toBeNull();
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(screen.queryByText(/using a token/i)).toBeNull();
  });
});

describe("tokens", () => {
  it("shows a created token once, sends name, scopes and expiry, and the token is gone after dismiss", async () => {
    serve(state());
    renderPage();
    const input = await screen.findByLabelText("Token name");
    fireEvent.change(input, { target: { value: "  Nightly export  " } });
    // The first scope (read) is pre-picked; add write and choose a year.
    fireEvent.click(screen.getByRole("checkbox", { name: /read and change projects/i }));
    fireEvent.change(screen.getByLabelText("Lasts"), { target: { value: "365" } });
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    const panel = await screen.findByRole("region", { name: /copy your new token now/i });
    expect(within(panel).getByText(SECRET)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/won.t see it again/i);
    expect(document.activeElement).toBe(panel);

    const sent = bodyOf("/api/developer/tokens", "POST");
    expect(sent.name).toBe("Nightly export");
    expect(sent.scopes).toEqual(["pm:read", "pm:write"]);
    const days = (Date.parse(sent.expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(364.9);
    expect(days).toBeLessThan(365.1);

    fireEvent.click(within(panel).getByRole("button", { name: /i.ve copied it/i }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("sends no expiry when 'No expiry' is chosen, and cannot be submitted without a name or a scope", async () => {
    serve(state());
    renderPage();
    const submit = await screen.findByRole("button", { name: "Create token" });
    expect(submit).toBeDisabled(); // no name yet
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "CI" } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /^read projects/i })); // un-pick the only scope
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /^read projects/i }));
    fireEvent.change(screen.getByLabelText("Lasts"), { target: { value: "none" } });
    fireEvent.click(submit);
    await screen.findByRole("region", { name: /copy your new token now/i });
    expect(bodyOf("/api/developer/tokens", "POST")).toEqual({ name: "CI", scopes: ["pm:read"], expiresAt: null });
  });

  it("says so when an admin switched tokens off meanwhile", async () => {
    serve(state());
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/developer" && (init?.method ?? "GET") === "GET") return res(state());
      if (url === "/api/developer/feeds") return res({ feeds: FEEDS });
      if (url === "/api/developer/tokens" && init?.method === "POST") return res({ error: "disabled" }, 409);
      return res({ error: "not_found" }, 404);
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText("Token name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/just turned api tokens off/i);
    expect(screen.queryByRole("region", { name: /copy your new token/i })).toBeNull();
  });

  it("lists the person's tokens by prefix, with their access, and revokes through the confirm", async () => {
    serve(state({ tokens: [ROW] }));
    renderPage();
    expect(await screen.findByText("dpm_AbCd1234…")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Read projects" })).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument(); // last used

    fireEvent.click(screen.getByRole("button", { name: `Revoke ${ROW.name}` }));
    const dialog = await screen.findByRole("dialog");
    expect(calledWith(`/api/developer/tokens/${ROW.id}`)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(`/api/developer/tokens/${ROW.id}`, expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("shows a token with no expiry as 'Never' and a revoked one without actions", async () => {
    serve(state({ tokens: [{ ...ROW, expiresAt: null }, { ...ROW, id: "tok-2", name: "Old", status: "revoked", revokedAt: "2026-10-02T10:00:00Z" }] }));
    renderPage();
    expect((await screen.findAllByText("dpm_AbCd1234…")).length).toBe(2);
    expect(screen.getAllByText("Never").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke Old" })).toBeNull();
  });

  it("with nothing for a token to reach, shows the reason and no form", async () => {
    serve(state({ scopes: [] }));
    renderPage();
    expect(await screen.findByText(/nothing is turned on for a token to reach/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
  });
});

describe("using a token", () => {
  it("shows the real address, never a real token, and says what limits apply", async () => {
    serve(state());
    renderPage();
    const origin = window.location.origin;
    await screen.findByText(/using a token/i, { selector: "h2, h3, .sect, div, span" });
    const example = document.querySelector("pre")?.textContent ?? "";
    expect(example).toContain(`${origin}/api/pm/projects`);
    expect(example).toContain("<your token>");
    expect(screen.getByText(/300 requests a minute/i)).toBeInTheDocument();

    // Mint a real one so there is a secret on the page to leak.
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    expect(document.querySelector("pre")?.textContent).not.toContain(SECRET);
  });

  it("fetches the OpenAPI document with the session and hands it to the browser as a file", async () => {
    serve(state());
    const createObjectURL = vi.fn(() => "blob:openapi");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /openapi document/i }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calledWith("/api/pm/openapi.json")).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:openapi");
  });

  it("says so when the document cannot be fetched", async () => {
    serve(state());
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/developer" && (init?.method ?? "GET") === "GET") return res(state());
      if (url === "/api/developer/feeds") return res({ feeds: FEEDS });
      return res({ error: "boom" }, 500);
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /openapi document/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t download the document/i);
  });
});

describe("calendar links", () => {
  it("lists My work first and then each project, with whether it has a link", async () => {
    serve(state());
    renderPage();
    expect(await screen.findByText("My work")).toBeInTheDocument();
    expect(screen.getByText("Alpha build")).toBeInTheDocument();
    expect(screen.getByText("ABC")).toBeInTheDocument();
    expect(screen.getByText(/a link is active until/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new link for Alpha build" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a link for My work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off the link for Alpha build" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off the link for My work" })).toBeNull();
  });

  it("creates a link, shows the whole address once with copy, and it is gone after dismiss", async () => {
    serve(state());
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Create a link for My work" }));
    const panel = await screen.findByRole("region", { name: /copy the link for my work now/i });
    expect(bodyOf("/api/developer/feeds/rotate", "POST")).toEqual({ kind: "my_work" });
    expect(within(panel).getByText(`${window.location.origin}${FEED_URL_PATH}`)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /copy calendar link/i })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(panel));
    fireEvent.click(within(panel).getByRole("button", { name: /i.ve copied it/i }));
    expect(screen.queryByText(new RegExp(FEED_URL_PATH.split("?")[0]))).toBeNull();
  });

  it("creates a project's link by project id", async () => {
    serve(state());
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Create a link for Xylophone" }));
    await screen.findByRole("region", { name: /copy the link for xylophone now/i });
    expect(bodyOf("/api/developer/feeds/rotate", "POST")).toEqual({ kind: "project", projectId: "p-xyz" });
  });

  it("turns a link off only after the confirm", async () => {
    serve(state());
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Turn off the link for Alpha build" }));
    const dialog = await screen.findByRole("dialog");
    expect(calledWith("/api/developer/feeds/revoke")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(bodyOf("/api/developer/feeds/revoke", "POST")).toEqual({ kind: "project", projectId: "p-abc" }));
  });

  it("says when Projects is off, and shows no rows", async () => {
    serve(state(), [], { error: "module_disabled", module: "projects" }, 404);
    renderPage();
    expect(await screen.findByText(/projects isn.t turned on/i)).toBeInTheDocument();
    expect(screen.queryByText("My work")).toBeNull();
  });

  it("says when the links cannot be loaded", async () => {
    serve(state(), [], { error: "boom" }, 500);
    renderPage();
    expect(await screen.findByText(/couldn.t load your calendar links/i)).toBeInTheDocument();
  });
});
