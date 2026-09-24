/**
 * WARP-3056 — the per-person Microsoft 365 card.
 *
 * `authFetch` and `useAuth` are replaced; everything else is the component.
 * What these pin: who sees it, that the redirect URI shown is the server's
 * verbatim, that signing in goes where the server says and nowhere else, the
 * callback outcomes (and that an unknown one is not reflected), the config
 * hints, and disconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";

const { authFetch, session } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  session: { role: "owner" as string | undefined },
}));
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
  useAuth: () => ({ user: session.role ? { id: "u1", role: session.role } : null }),
}));
// A ConfirmDialog with the real one's contract (resolve closes, reject stays
// open) but no focus trap, so the disconnect path can be driven directly.
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: (p: {
    open: boolean;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
    accessory?: ReactNode;
  }) =>
    p.open ? (
      <div data-testid="confirm-dialog">
        {p.accessory}
        <button type="button" onClick={p.onCancel}>
          cancel
        </button>
        <button type="button" onClick={() => void p.onConfirm().then(p.onCancel, () => {})}>
          confirm-{p.confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { Microsoft365Card, SETUP_GUIDE_HREF, hintForError } from "./Microsoft365Card";
import { INTEGRATION_GUIDES, integrationGuideHref } from "@/lib/integration-guides";

const REDIRECT = "https://droplet-ai.local/api/m365/callback";
const APP = {
  clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
};

function view(over: Record<string, unknown> = {}) {
  return {
    state: "DISCONNECTED",
    accountUpn: null,
    tenantId: null,
    app: null,
    grantedScopes: [],
    connectedAt: null,
    lastRefreshOkAt: null,
    lastError: null,
    redirectUri: REDIRECT,
    ...over,
  };
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "owner";
  window.history.replaceState(null, "", "/settings");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("who sees it", () => {
  it("renders nothing for a guest, and asks the box nothing", () => {
    session.role = "guest";
    const { container } = render(<Microsoft365Card />);
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("renders for family — each person connects their own account", async () => {
    session.role = "family";
    authFetch.mockResolvedValue(json(view()));
    render(<Microsoft365Card />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith("/api/m365/connection");
  });
});

describe("a status read that fails", () => {
  it("is said plainly, not raised as an alert over the rest of Settings", async () => {
    authFetch.mockRejectedValue(new Error("offline"));
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-load-failed")).toHaveTextContent(/could not read/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("connecting", () => {
  it("shows the server's redirect URI verbatim, to be pasted into the app registration", async () => {
    authFetch.mockResolvedValue(json(view()));
    render(<Microsoft365Card />);
    expect(await screen.findByDisplayValue(REDIRECT)).toHaveAttribute("readonly");
  });

  it("pre-fills the stored app so reconnecting is one click", async () => {
    authFetch.mockResolvedValue(json(view({ state: "NEEDS_RECONNECT", app: APP })));
    render(<Microsoft365Card />);
    expect(await screen.findByDisplayValue(APP.clientId)).toBeInTheDocument();
    expect(screen.getByDisplayValue(APP.tenantId)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("posts the two ids and sends the browser where the server says", async () => {
    const navigate = vi.fn();
    authFetch
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({ authorizeUrl: "https://sign-in.example/authorize?x=1" }));
    render(<Microsoft365Card navigate={navigate} />);

    fireEvent.change(await screen.findByLabelText("Application (client) ID"), {
      target: { value: ` ${APP.clientId} ` },
    });
    fireEvent.change(screen.getByLabelText("Directory (tenant) ID"), { target: { value: APP.tenantId } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Microsoft" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://sign-in.example/authorize?x=1"));
    const [url, init] = authFetch.mock.calls[1]!;
    expect(url).toBe("/api/m365/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(APP); // trimmed
  });

  it("shows the server's reason and goes nowhere when the ids are refused", async () => {
    const navigate = vi.fn();
    authFetch.mockResolvedValueOnce(json(view())).mockResolvedValueOnce(
      json(
        {
          error: "invalid_app_registration",
          field: "tenantId",
          message: "Use your organisation's own Directory (tenant) ID, not a shared sign-in endpoint.",
        },
        400,
      ),
    );
    render(<Microsoft365Card navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Microsoft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/your organisation's own directory/i);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("the callback outcome", () => {
  it("says the connection worked, once, and strips the parameter", async () => {
    window.history.replaceState(null, "", "/settings?m365=connected&tab=x");
    authFetch.mockResolvedValue(json(view({ state: "CONNECTED", accountUpn: "sam@practice.com", app: APP })));
    render(<Microsoft365Card />);

    expect(await screen.findByTestId("m365-outcome")).toHaveTextContent("Microsoft 365 is connected.");
    expect(window.location.search).toBe("?tab=x");
  });

  it("names a cancelled sign-in as cancelled, not as a failure", async () => {
    window.history.replaceState(null, "", "/settings?m365=cancelled");
    authFetch.mockResolvedValue(json(view()));
    render(<Microsoft365Card />);
    const note = await screen.findByTestId("m365-outcome");
    expect(note).toHaveTextContent(/cancelled/i);
    expect(note).toHaveAttribute("role", "status");
  });

  it("reflects nothing from an unknown outcome value", async () => {
    window.history.replaceState(null, "", "/settings?m365=%3Cb%3Ehi%3C%2Fb%3E");
    authFetch.mockResolvedValue(json(view()));
    render(<Microsoft365Card />);
    await screen.findByText("Not connected");
    expect(screen.queryByTestId("m365-outcome")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("<b>hi</b>");
    expect(window.location.search).toBe("");
  });

  // `in` walks the prototype chain: every plain object "has" these. The set
  // of outcomes is the five keys the callback can send, and nothing inherited.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "treats ?m365=%s as unknown, not as an outcome",
    async (raw) => {
      window.history.replaceState(null, "", `/settings?m365=${raw}`);
      authFetch.mockResolvedValue(json(view()));
      render(<Microsoft365Card />);
      await screen.findByText("Not connected");
      expect(screen.queryByTestId("m365-outcome")).not.toBeInTheDocument();
      expect(window.location.search).toBe("");
    },
  );
});

describe("a broken app registration", () => {
  it("points at the setting to change, not at signing in again", async () => {
    authFetch.mockResolvedValue(
      json(
        view({
          state: "ERROR",
          app: APP,
          lastError: "invalid_client: AADSTS7000218: The request body must contain client_assertion or client_secret.",
        }),
      ),
    );
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-hint")).toHaveTextContent(/mobile and desktop applications/i);
  });

  it("maps each registration error it knows, and nothing else", () => {
    expect(hintForError("AADSTS50011: redirect mismatch")).toMatch(/redirect uri below/i);
    expect(hintForError("AADSTS9002327: spa")).toMatch(/wrong platform/i);
    expect(hintForError("AADSTS700016: app not found")).toMatch(/client\) id/i);
    expect(hintForError("AADSTS90094: admin")).toMatch(/admin consent/i);
    expect(hintForError("AADSTS50173: grant expired")).toBeNull();
    expect(hintForError(null)).toBeNull();
  });
});

describe("connected", () => {
  it("shows the account and disconnects on confirm", async () => {
    authFetch
      .mockResolvedValueOnce(json(view({ state: "CONNECTED", accountUpn: "sam@practice.com", app: APP })))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) })
      .mockResolvedValueOnce(json(view({ app: APP })));
    render(<Microsoft365Card />);

    expect(await screen.findByText(/connected as sam@practice\.com/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Application (client) ID")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Disconnect" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/m365/connection", { method: "DELETE" }));
    // Back to the form, with the app still filled in.
    expect(await screen.findByDisplayValue(APP.clientId)).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  // The dialog stays open on a failed disconnect (so the person can retry),
  // which covers the card: the reason has to be said inside the dialog.
  it.each([
    ["the box refuses", () => authFetch.mockResolvedValueOnce(json({ error: "internal" }, 500))],
    ["the box cannot be reached", () => authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))],
  ])("says so inside the open dialog when %s", async (_label, fail) => {
    authFetch.mockResolvedValueOnce(json(view({ state: "CONNECTED", accountUpn: "sam@practice.com", app: APP })));
    fail();
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Disconnect" }));

    const dialog = await screen.findByTestId("confirm-dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/could not disconnect microsoft 365/i),
    );
    // Still connected, and said once: not a second copy on the card beneath.
    expect(screen.getByText(/connected as sam@practice\.com/i)).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("forgets a failed disconnect's reason once the dialog is dismissed and opened again", async () => {
    authFetch
      .mockResolvedValueOnce(json(view({ state: "CONNECTED", accountUpn: "sam@practice.com", app: APP })))
      .mockResolvedValueOnce(json({ error: "internal" }, 500));
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Disconnect" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the setup guide", () => {
  it("links to the bundled guide, at the href the guide registry would build", () => {
    expect(SETUP_GUIDE_HREF).toBe(integrationGuideHref("microsoft-365"));
    expect(INTEGRATION_GUIDES["microsoft-365"]).toMatch(/^# Microsoft 365/);
  });

  // The guide tells a person which button to press; it has to be one the card
  // actually shows. "Reconnect" is the state, not a button.
  it("names the card's buttons as the card labels them", async () => {
    const guide = INTEGRATION_GUIDES["microsoft-365"]!;
    const pressed = [...guide.matchAll(/select \*\*([^*]+)\*\*/gi)].map((m) => m[1]);
    const cardButtons = ["Sign in with Microsoft", "Sign in again", "Disconnect"];
    const onCard = pressed.filter((label) => cardButtons.includes(label!));
    expect(onCard).toEqual(expect.arrayContaining(["Sign in with Microsoft", "Sign in again"]));
    expect(guide).not.toMatch(/select \*\*Reconnect\*\*/i);

    authFetch.mockResolvedValue(json(view({ state: "NEEDS_RECONNECT", app: APP })));
    render(<Microsoft365Card />);
    expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    expect(screen.getByText("Needs reconnect")).toBeInTheDocument();
  });
});
