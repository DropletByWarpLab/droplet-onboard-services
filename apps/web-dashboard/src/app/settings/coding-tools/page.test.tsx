/**
 * WARP-3452 — /settings/coding-tools page tests.
 *
 * Contract under test:
 *   1. owner/admin (`isAdmin`) see the switch and everyone's tokens; a
 *      member sees neither, and never asks for everyone's tokens;
 *   2. an external guest is gated, in the nav and on the page;
 *   3. switch off: a member sees that it is off, and their own tokens with
 *      Revoke only (no create, no renew);
 *   4. a created token is shown once and is gone after dismiss;
 *   5. revoke goes through the confirm dialog and calls DELETE;
 *   6. snippets carry the real base URL and model id, never a real token;
 *   7. copy says "member", never the `family` wire value.
 *
 * ShellPage is mocked to a passthrough and `authFetch` routes on the URL —
 * no network. A fresh SWR cache per render keeps cases independent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import CodingToolsPage from "./page";
import { TOKEN_PLACEHOLDER, clientGuides } from "./clients";
import { settingsGroups } from "@/components/nav-config";

const SECRET = "dlk_" + "S".repeat(43);
const MODEL = "gpt-oss:20b";

const ROW = {
  id: "tok-1",
  label: "MacBook – VS Code",
  prefix: "AbCd1234",
  status: "active",
  createdAt: "2026-10-01T10:00:00Z",
  expiresAt: "2027-09-30T10:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
  usage30d: { requests: 12, promptTokens: 3000, completionTokens: 400, errors: 0 },
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    canCreate: true,
    isAdmin: false,
    activeModel: MODEL,
    contextWindow: 16384,
    tokens: [] as unknown[],
    ...overrides,
  };
}

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function serve(s: ReturnType<typeof state>, all: unknown[] = []) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/llm-access" && method === "GET") return res(s);
    if (url === "/api/llm-access/tokens/all") return res({ tokens: all });
    if (url === "/api/llm-access/settings" && method === "PUT")
      return res({ ...s, enabled: JSON.parse(String(init?.body)).enabled });
    if (url === "/api/llm-access/tokens" && method === "POST")
      return res({ token: SECRET, row: ROW }, 201);
    if (url.startsWith("/api/llm-access/tokens/") && method === "DELETE") return res(null, 204);
    return res({ error: "not_found" }, 404);
  });
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CodingToolsPage />
    </SWRConfig>,
  );
}

const calledWith = (url: string) => authFetch.mock.calls.some(([u]) => u === url);

beforeEach(() => {
  authFetch.mockReset();
  userRef.current = { role: "owner" };
});

describe("who sees the admin controls", () => {
  it("an owner/admin sees the switch and everyone's tokens", async () => {
    serve(state({ isAdmin: true }), [{ ...ROW, user: { id: "u2", displayName: "Sam Rivera" } }]);
    renderPage();
    expect(
      await screen.findByRole("switch", { name: "Coding tools can use the local model" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("Sam Rivera")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Everyone's tokens" })).toBeInTheDocument();
    expect(screen.getByText(/off by default/i)).toHaveTextContent(/none are deleted/i);
  });

  it("an admin flipping the switch saves it", async () => {
    serve(state({ isAdmin: true }));
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: /coding tools can use/i }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        "/api/llm-access/settings",
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
    expect(calledWith("/api/llm-access/tokens/all")).toBe(false);
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

  it("is not offered the page in the Settings nav", () => {
    const hrefs = (role: "guest" | "family") =>
      settingsGroups(role, { claudeActivity: true, ragEval: true, medicalConnector: true }, () => true)
        .flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs("guest")).not.toContain("/settings/coding-tools");
    expect(hrefs("family")).toContain("/settings/coding-tools");
  });
});

describe("switch off", () => {
  it("a member sees that it is off, and can still revoke their own tokens", async () => {
    // Off does not revoke: the token is still active and would work again
    // when the switch comes back on, so a lost laptop's token must be killable.
    userRef.current = { role: "family" };
    serve(state({ enabled: false, canCreate: false, tokens: [ROW] }));
    renderPage();
    expect(await screen.findByText(/your admin hasn.t turned this on/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your tokens" })).toBeInTheDocument();
    expect(screen.getByText("dlk_AbCd1234…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Revoke ${ROW.label}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /renew/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /create token/i })).toBeNull();
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(screen.queryByText(/\/llm\/v1/)).toBeNull();
  });
});

describe("tokens", () => {
  it("shows a created token once, and it is gone after dismiss", async () => {
    serve(state());
    renderPage();
    const input = await screen.findByLabelText("Token name");
    fireEvent.change(input, { target: { value: "  MacBook  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    const panel = await screen.findByRole("region", { name: /copy your new token now/i });
    expect(within(panel).getByText(SECRET)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/won.t see it again/i);
    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(authFetch).toHaveBeenCalledWith(
      "/api/llm-access/tokens",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ label: "MacBook" }) }),
    );

    fireEvent.click(within(panel).getByRole("button", { name: /i.ve copied it/i }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("lists the person's tokens by prefix and revokes through the confirm", async () => {
    serve(state({ tokens: [ROW] }));
    renderPage();
    expect(await screen.findByText("dlk_AbCd1234…")).toBeInTheDocument();
    expect(screen.getByText(/12 requests/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Revoke ${ROW.label}` }));
    const dialog = await screen.findByRole("dialog");
    expect(calledWith(`/api/llm-access/tokens/${ROW.id}`)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        `/api/llm-access/tokens/${ROW.id}`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});

describe("snippets", () => {
  it("carry the base URL and model id, and never the real token", async () => {
    serve(state());
    renderPage();
    const origin = window.location.origin;
    expect(await screen.findByText(`${origin}/llm/v1`)).toBeInTheDocument();
    expect(screen.getByText(`${origin}/llm`)).toBeInTheDocument();

    // Mint a real token so there is one on the page to leak.
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);

    const guides = document.querySelectorAll("details[data-client]");
    expect(guides.length).toBe(10);
    for (const guide of guides) {
      const id = guide.getAttribute("data-client");
      expect(guide.querySelector("pre")?.textContent, `${id} snippet`).toContain(`${origin}/llm`);
      // The Ollama extension discovers the model, so its id is in the steps.
      expect(guide.textContent, `${id}`).toContain(MODEL);
      expect(guide.textContent, `${id}`).not.toContain(SECRET);
    }
  });

  it("fill the client-specific fields", () => {
    const origin = "https://droplet.example";
    const guides = clientGuides({ origin, model: MODEL, contextWindow: 16384 });
    const byId = Object.fromEntries(guides.map((g) => [g.id, g.snippet]));

    const [copilot] = JSON.parse(byId["copilot-vscode"]);
    expect(copilot).toMatchObject({ vendor: "customendpoint", apiKey: TOKEN_PLACEHOLDER });
    expect(copilot.models[0]).toEqual({
      id: MODEL,
      name: MODEL,
      url: `${origin}/llm/v1/chat/completions`,
      toolCalling: true,
      maxInputTokens: 16384,
    });

    expect(JSON.parse(byId["ollama-vscode"])).toEqual({
      "ollama.endpoint": `${origin}/llm`,
      "ollama.headers": { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
    });

    expect(byId["copilot-cli"]).toContain("COPILOT_PROVIDER_TYPE=openai");
    expect(byId["copilot-cli"]).toContain(`COPILOT_PROVIDER_BASE_URL="${origin}/llm/v1"`);
    expect(byId["aider"]).toContain(`--model "openai/${MODEL}"`);
  });
});

describe("copy", () => {
  it("says member, never the family wire value", async () => {
    serve(state({ isAdmin: true, tokens: [ROW] }));
    const admin = renderPage();
    await screen.findByRole("heading", { name: "Everyone's tokens" });
    expect(document.body.textContent).toMatch(/members/);
    expect(document.body.textContent).not.toMatch(/family|household/i);
    admin.unmount();

    userRef.current = { role: "family" };
    serve(state({ enabled: false, canCreate: false }));
    renderPage();
    await screen.findByText(/your admin hasn.t turned this on/i);
    expect(document.body.textContent).not.toMatch(/family|household/i);
  });
});
