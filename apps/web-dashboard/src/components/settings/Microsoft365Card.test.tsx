/**
 * WARP-3056 — the per-person Microsoft 365 card.
 * WARP-3538 — and its "Your files" block: OneDrive's status and the person's
 * own SharePoint switch.
 *
 * `authFetch` and `useAuth` are replaced; everything else is the component.
 * What these pin: who sees it, that the redirect URI shown is the server's
 * verbatim, that signing in goes where the server says and nowhere else, the
 * callback outcomes (and that an unknown one is not reflected), the config
 * hints, and disconnect.
 *
 * For the files block (WARP-3538): the five states a person can be in (off; on
 * with libraries; on but waiting for Microsoft's approval; capped; turning it
 * off), that turning it OFF is confirmed in words that say what is deleted and
 * turning it ON is not, that every request goes to the route the box serves and
 * with the body it expects, that a status that cannot be read is said plainly
 * and never raised as an alert, and that a name Microsoft sends is text.
 *
 * 🔴 The box is served BY URL (`serveBox`), not by call order: the connected
 * card makes two reads on load (the connection, then the files status) and a
 * call-order mock would hand the second one a disconnect's answer.
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
// open) but no focus trap, so the confirm paths can be driven directly. It
// renders the title and description so the copy a person is asked to agree to
// can be pinned.
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: (p: {
    open: boolean;
    title: string;
    description: string;
    variant?: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
    accessory?: ReactNode;
  }) =>
    p.open ? (
      <div data-testid="confirm-dialog" data-variant={p.variant ?? "destructive"}>
        <h2>{p.title}</h2>
        <p>{p.description}</p>
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
import { SHAREPOINT_LIBRARY_LIMIT, SHAREPOINT_SWITCH_LABEL } from "./Microsoft365Files";
import { INTEGRATION_GUIDES, integrationGuideHref } from "@/lib/integration-guides";

const REDIRECT = "https://droplet-ai.local/api/m365/callback";
const APP = {
  clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
};

const SP_OFF = { enabled: false, granted: false, needsConsent: false };
const SP_ON = { enabled: true, granted: true, needsConsent: false };
const SP_CONSENT = { enabled: true, granted: false, needsConsent: true };

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
    sharePoint: SP_OFF,
    ...over,
  };
}

/** A person who is signed in. */
function connected(over: Record<string, unknown> = {}) {
  return view({ state: "CONNECTED", accountUpn: "sam@practice.com", app: APP, ...over });
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** One library as `GET /api/m365/sync-status` sends it. */
function library(over: Record<string, unknown> = {}) {
  return {
    driveId: "b!drive-1",
    siteName: "Front Desk",
    libraryName: "Documents",
    webUrl: "https://contoso.example/sites/frontdesk/Shared%20Documents",
    followed: true,
    files: 1284,
    lastSyncedAt: minutesAgo(5),
    state: "IDLE",
    lastError: null,
    ...over,
  };
}

/** `GET /api/m365/sync-status`. `sharePoint` is merged over an ON, uncapped, empty block. */
function syncStatus(over: { sharePoint?: Record<string, unknown>; oneDrive?: unknown } & Record<string, unknown> = {}) {
  const { sharePoint, ...rest } = over;
  return {
    workloads: [{ workload: "files", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: minutesAgo(5) }],
    oneDrive: { files: 312, lastSyncedAt: minutesAgo(5), state: "IDLE", lastError: null },
    sharePoint: { ...SP_ON, capped: 0, libraries: [], ...sharePoint },
    ...rest,
  };
}

interface Box {
  /** `GET /api/m365/connection` */
  view: Record<string, unknown>;
  /** `GET /api/m365/sync-status`: a body, a number (an HTTP status) or an Error (unreachable). */
  sync: unknown;
  /** `PUT /api/m365/sharepoint` */
  put: (body: { enabled: boolean }) => unknown;
  /** `DELETE /api/m365/connection` */
  del: () => unknown;
  /** `POST /api/m365/connect` */
  connect: () => unknown;
}

/** The box, answering by URL. A request a test did not expect throws. */
function serveBox(overrides: Partial<Box> = {}): Box {
  const box: Box = {
    view: view(),
    sync: syncStatus(),
    put: () => json({}),
    del: () => ({ ok: true, status: 204, json: async () => ({}) }),
    connect: () => json({ authorizeUrl: "https://sign-in.example/authorize?x=1" }),
    ...overrides,
  };
  authFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const answer = (r: unknown) => {
      if (r instanceof Error) throw r;
      return r;
    };
    if (url === "/api/m365/connection" && method === "GET") return json(box.view);
    if (url === "/api/m365/sync-status" && method === "GET") {
      if (box.sync instanceof Error) throw box.sync;
      return typeof box.sync === "number" ? json({}, box.sync) : json(box.sync);
    }
    if (url === "/api/m365/sharepoint" && method === "PUT") return answer(box.put(JSON.parse(init!.body!)));
    if (url === "/api/m365/connection" && method === "DELETE") return answer(box.del());
    if (url === "/api/m365/connect" && method === "POST") return answer(box.connect());
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return box;
}

/** The calls the card made to one URL. */
const callsTo = (url: string, method = "GET") =>
  authFetch.mock.calls.filter(([u, init]) => u === url && (init?.method ?? "GET") === method);

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

  it("shows family their own files block too", async () => {
    session.role = "family";
    serveBox({ view: connected() });
    render(<Microsoft365Card />);
    expect(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toBeInTheDocument();
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
    serveBox({ view: connected() });
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
    const box = serveBox({ view: connected() });
    box.del = () => {
      box.view = view({ app: APP });
      return { ok: true, status: 204, json: async () => ({}) };
    };
    render(<Microsoft365Card />);

    expect(await screen.findByText(/connected as sam@practice\.com/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Application (client) ID")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Disconnect" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith("/api/m365/connection", { method: "DELETE" }));
    // Back to the form, with the app still filled in.
    expect(await screen.findByDisplayValue(APP.clientId)).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    // …and the files block went with the connection.
    expect(screen.queryByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).not.toBeInTheDocument();
  });

  // The dialog stays open on a failed disconnect (so the person can retry),
  // which covers the card: the reason has to be said inside the dialog.
  it.each([
    ["the box refuses", () => json({ error: "internal" }, 500)],
    ["the box cannot be reached", () => new TypeError("Failed to fetch")],
  ])("says so inside the open dialog when %s", async (_label, fail) => {
    const box = serveBox({ view: connected() });
    box.del = fail;
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
    const box = serveBox({ view: connected() });
    box.del = () => json({ error: "internal" }, 500);
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

describe("your files — OneDrive", () => {
  it("shows OneDrive's file count and when it was last read, and says it never reads contents", async () => {
    serveBox({ view: connected() });
    render(<Microsoft365Card />);

    const onedrive = await screen.findByTestId("m365-onedrive");
    expect(onedrive).toHaveTextContent("OneDrive");
    expect(onedrive).toHaveTextContent(`${(312).toLocaleString()} files`);
    expect(onedrive).toHaveTextContent("last read 5 minutes ago");
    expect(within(onedrive).getByText("Up to date")).toHaveClass("badge", "ok");
    // The promise this block makes is the one the connector keeps (metadata only).
    expect(screen.getByTestId("m365-files")).toHaveTextContent(/never reads what is inside/i);
    expect(callsTo("/api/m365/sync-status")).toHaveLength(1);
  });

  it("says one file, not '1 files'", async () => {
    serveBox({ view: connected(), sync: syncStatus({ oneDrive: { files: 1, lastSyncedAt: minutesAgo(1), state: "IDLE", lastError: null } }) });
    render(<Microsoft365Card />);
    // The name and the count are separate elements, so there is no word
    // boundary between "OneDrive" and "1" in the text content.
    expect(await screen.findByTestId("m365-onedrive")).toHaveTextContent(/\D1 file(?!s)/);
  });

  it("says so while it is still reading for the first time", async () => {
    serveBox({
      view: connected(),
      sync: syncStatus({ oneDrive: { files: 40, lastSyncedAt: null, state: "SYNCING", lastError: null } }),
    });
    render(<Microsoft365Card />);
    const onedrive = await screen.findByTestId("m365-onedrive");
    expect(onedrive).toHaveTextContent("40 files so far");
    expect(within(onedrive).getByText("Reading")).toHaveClass("badge", "info");
    expect(onedrive).not.toHaveTextContent(/last read/);
  });

  it("shows no OneDrive row when the box reports none, and still shows SharePoint", async () => {
    serveBox({ view: connected(), sync: syncStatus({ oneDrive: null }) });
    render(<Microsoft365Card />);
    expect(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toBeInTheDocument();
    expect(screen.queryByTestId("m365-onedrive")).not.toBeInTheDocument();
  });

  it("a status that cannot be read is said plainly, not raised as an alert", async () => {
    serveBox({ view: connected(), sync: 500 });
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-sync-failed")).toHaveTextContent(/could not read the status of your files/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The switch is still there: turning SharePoint on does not need the status.
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toBeInTheDocument();
  });

  it.each([
    ["the box cannot be reached", new TypeError("Failed to fetch")],
    ["it answers something that is not a status", { state: "CONNECTED" }],
    ["it answers a list", []],
  ])("a status read that fails because %s does not crash the card", async (_label, sync) => {
    serveBox({ view: connected(), sync });
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-sync-failed")).toBeInTheDocument();
    expect(screen.getByText(/connected as sam@practice\.com/i)).toBeInTheDocument();
  });

  it("asks for no status, and shows no files block, when nobody is connected", async () => {
    serveBox({ view: view() });
    render(<Microsoft365Card />);
    await screen.findByText("Not connected");
    expect(screen.queryByTestId("m365-files")).not.toBeInTheDocument();
    expect(callsTo("/api/m365/sync-status")).toHaveLength(0);
  });

  it("shows no files block against a box that does not report SharePoint yet, rather than crashing", async () => {
    // A box mid-update: the dashboard is newer than the orchestrator.
    const { sharePoint: _gone, ...old } = connected();
    serveBox({ view: old });
    render(<Microsoft365Card />);
    expect(await screen.findByText(/connected as sam@practice\.com/i)).toBeInTheDocument();
    expect(screen.queryByTestId("m365-files")).not.toBeInTheDocument();
    expect(callsTo("/api/m365/sync-status")).toHaveLength(0);
  });
});

describe("your files — SharePoint is off", () => {
  it("shows the switch off and says what turning it on would read — names, folders and dates, never contents", async () => {
    serveBox({ view: connected({ sharePoint: SP_OFF }) });
    render(<Microsoft365Card />);

    const sw = await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL });
    expect(sw).toHaveAttribute("aria-checked", "false");
    const block = screen.getByTestId("m365-sharepoint");
    expect(block).toHaveTextContent(/reads only your onedrive/i);
    expect(block).toHaveTextContent(/names, folders and dates/i);
    expect(block).toHaveTextContent(new RegExp(`up to ${SHAREPOINT_LIBRARY_LIMIT} libraries`, "i"));
    expect(block).toHaveTextContent(/never reads what is inside/i);
    expect(screen.queryByTestId("m365-library")).not.toBeInTheDocument();
    expect(screen.queryByTestId("m365-sharepoint-consent")).not.toBeInTheDocument();
  });

  it("turning it on PUTs {enabled:true} to the route, with no confirmation, and then shows the libraries", async () => {
    const box = serveBox({ view: connected({ sharePoint: SP_OFF }), sync: syncStatus({ sharePoint: { ...SP_OFF, libraries: [] } }) });
    box.put = ({ enabled }) => {
      box.view = connected({ sharePoint: enabled ? SP_ON : SP_OFF });
      box.sync = syncStatus({ sharePoint: { libraries: [library()] } });
      return json({});
    };
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true"),
    );
    const [[url, init]] = callsTo("/api/m365/sharepoint", "PUT");
    expect(url).toBe("/api/m365/sharepoint");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
    expect(await screen.findByText("Front Desk › Documents")).toBeInTheDocument();
    // Turning it ON asks nothing: only turning it off deletes anything.
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("a refused turn-on leaves the switch off and says so in an alert", async () => {
    const box = serveBox({ view: connected({ sharePoint: SP_OFF }) });
    box.put = () => json({ error: "internal" }, 500);
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not turn on sharepoint\. nothing changed/i);
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).not.toBeDisabled();
  });

  it("an unreachable box is said the same way, not left spinning", async () => {
    const box = serveBox({ view: connected({ sharePoint: SP_OFF }) });
    box.put = () => new TypeError("Failed to fetch");
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not turn on sharepoint/i);
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).not.toBeDisabled();
  });

  it("holds the switch while the change is in flight, so a double click cannot send two", async () => {
    let release!: () => void;
    const box = serveBox({ view: connected({ sharePoint: SP_OFF }) });
    box.put = () =>
      new Promise((resolve) => {
        release = () => resolve(json({}));
      });
    render(<Microsoft365Card />);

    const sw = await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL });
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    fireEvent.click(sw);
    expect(callsTo("/api/m365/sharepoint", "PUT")).toHaveLength(1);
    release();
    await waitFor(() => expect(sw).not.toBeDisabled());
  });
});

describe("your files — SharePoint is on", () => {
  it("lists each library as site › library with its file count, when it was last read and its state", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({
        sharePoint: {
          libraries: [
            library(),
            library({ driveId: "b!drive-2", siteName: "Billing", libraryName: "Invoices", files: 1, lastSyncedAt: minutesAgo(90) }),
          ],
        },
      }),
    });
    render(<Microsoft365Card />);

    const rows = await screen.findAllByTestId("m365-library");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Front Desk › Documents");
    expect(rows[0]).toHaveTextContent(`${(1284).toLocaleString()} files`);
    expect(rows[0]).toHaveTextContent("last read 5 minutes ago");
    expect(within(rows[0]!).getByText("Up to date")).toHaveClass("badge", "ok");
    expect(rows[1]).toHaveTextContent("Billing › Invoices");
    expect(rows[1]).toHaveTextContent(/\D1 file(?!s)/);
    expect(rows[1]).toHaveTextContent("last read 2 hours ago");
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("m365-sharepoint-capped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("m365-sharepoint-consent")).not.toBeInTheDocument();
  });

  // The chip says the state in words and a colour; the colour alone is never
  // the message.
  it.each([
    ["IDLE", minutesAgo(5), "Up to date", "ok"],
    ["IDLE", null, "Waiting", "muted"],
    ["SYNCING", null, "Reading", "info"],
    ["SYNCING", minutesAgo(5), "Reading", "info"],
    ["RESYNC_REQUIRED", minutesAgo(5), "Reading again", "info"],
    ["BACKOFF", minutesAgo(5), "Retrying later", "warn"],
    ["FAILED", minutesAgo(5), "Needs attention", "danger"],
    ["A_STATE_FROM_A_NEWER_BOX", minutesAgo(5), "Checking", "muted"],
  ])("a library in %s (last read %s) is the chip %s", async (state, lastSyncedAt, label, tone) => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library({ state, lastSyncedAt })] } }) });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(within(row).getByText(label)).toHaveClass("badge", tone);
  });

  it("a library still on its first read shows the count so far, not a last-read time", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library({ state: "SYNCING", lastSyncedAt: null, files: 37 })] } }),
    });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(row).toHaveTextContent("37 files so far");
    expect(row).not.toHaveTextContent(/last read/);
  });

  it("a failed library names the reason the box recorded", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library({ state: "FAILED", lastError: "Microsoft answered 403 for this library" })] } }),
    });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(row).toHaveTextContent("Microsoft answered 403 for this library");
    // A library's trouble is not an emergency on a settings page.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a reason only for a library that failed, not for one that is merely retrying", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library({ state: "BACKOFF", lastError: "throttled" })] } }),
    });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(row).not.toHaveTextContent("throttled");
  });

  it("says when it has found no libraries yet, rather than showing an empty list", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [] } }) });
    render(<Microsoft365Card />);
    const block = await screen.findByTestId("m365-sharepoint");
    await waitFor(() => expect(block).toHaveTextContent(/no sharepoint document libraries yet/i));
    expect(block).toHaveTextContent(/few minutes/i);
    expect(screen.queryByTestId("m365-library")).not.toBeInTheDocument();
  });

  it("🔴 renders a name Microsoft sends as text, never as markup", async () => {
    // Site and library names are typed by whoever administers a tenant.
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({
        sharePoint: {
          libraries: [library({ siteName: "<img src=x onerror=boom>", libraryName: "<b>Docs</b>", lastError: null })],
        },
      }),
    });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(row).toHaveTextContent("<img src=x onerror=boom> › <b>Docs</b>");
    expect(row.querySelector("img, b")).toBeNull();
  });

  it("offers no link to a library, so no address from Microsoft is ever put in an href", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library({ webUrl: "javascript:void(0)" })] } }) });
    render(<Microsoft365Card />);
    const row = await screen.findByTestId("m365-library");
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(row.innerHTML).not.toContain("javascript:");
  });
});

describe("your files — the library limit", () => {
  it("says how many more libraries are not read, and the limit", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { capped: 7, libraries: [library()] } }),
    });
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-sharepoint-capped")).toHaveTextContent(
      `7 more libraries not read (limit ${SHAREPOINT_LIBRARY_LIMIT})`,
    );
  });

  it("says '1 more library', not '1 more libraries'", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { capped: 1, libraries: [library()] } }) });
    render(<Microsoft365Card />);
    expect(await screen.findByTestId("m365-sharepoint-capped")).toHaveTextContent(
      `1 more library not read (limit ${SHAREPOINT_LIBRARY_LIMIT})`,
    );
  });

  it("is silent when nothing was dropped", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { capped: 0, libraries: [library()] } }) });
    render(<Microsoft365Card />);
    await screen.findByTestId("m365-library");
    expect(screen.queryByTestId("m365-sharepoint-capped")).not.toBeInTheDocument();
  });
});

describe("your files — SharePoint is on but Microsoft has not approved it", () => {
  it("says so in plain words and offers to sign in again, instead of a list", async () => {
    serveBox({
      view: connected({ sharePoint: SP_CONSENT }),
      sync: syncStatus({ sharePoint: { ...SP_CONSENT, libraries: [] } }),
    });
    render(<Microsoft365Card />);

    const consent = await screen.findByTestId("m365-sharepoint-consent");
    expect(consent).toHaveTextContent("Microsoft needs to approve SharePoint access");
    expect(consent).toHaveTextContent(/administrator/i);
    expect(consent).toHaveTextContent(/grant admin consent/i);
    expect(within(consent).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
    expect(within(consent).getByRole("link", { name: /how your microsoft admin/i })).toHaveAttribute("href", SETUP_GUIDE_HREF);
    // The switch still says what the person chose; there is nothing to list.
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("m365-library")).not.toBeInTheDocument();
    expect(screen.queryByText(/no sharepoint document libraries yet/i)).not.toBeInTheDocument();
  });

  it("signing in again runs the card's own sign-in with the stored app, and goes where the box says", async () => {
    const navigate = vi.fn();
    serveBox({ view: connected({ sharePoint: SP_CONSENT }) });
    render(<Microsoft365Card navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://sign-in.example/authorize?x=1"));
    const [[url, init]] = callsTo("/api/m365/connect", "POST");
    expect(url).toBe("/api/m365/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(APP);
  });

  it("a sign-in the box refuses is said in the card's alert and goes nowhere", async () => {
    const navigate = vi.fn();
    const box = serveBox({ view: connected({ sharePoint: SP_CONSENT }) });
    box.connect = () => json({ error: "internal", message: "Droplet could not start the Microsoft sign-in." }, 500);
    render(<Microsoft365Card navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start the microsoft sign-in/i);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("your files — turning SharePoint off", () => {
  it("asks first, in words that say what is deleted and what stops, and sends nothing until confirmed", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library()] } }) });
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));

    const dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent(/stop reading sharepoint/i);
    expect(dialog).toHaveTextContent(/delete the list of SharePoint files it kept/i);
    expect(dialog).toHaveTextContent(/stop reading your SharePoint (document )?libraries/i);
    // OneDrive and Microsoft 365 itself are untouched, and that is said.
    expect(dialog).toHaveTextContent(/onedrive/i);
    expect(dialog).toHaveTextContent(/nothing in microsoft 365 changes/i);
    expect(dialog).toHaveAttribute("data-variant", "destructive");
    expect(within(dialog).getByRole("button", { name: "confirm-Turn off" })).toBeInTheDocument();
    expect(callsTo("/api/m365/sharepoint", "PUT")).toHaveLength(0);
    // The switch has not moved yet: the person has not agreed.
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true");
  });

  it("cancelling changes nothing and sends nothing", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library()] } }) });
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    fireEvent.click(await screen.findByRole("button", { name: "cancel" }));

    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(callsTo("/api/m365/sharepoint", "PUT")).toHaveLength(0);
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("m365-library")).toBeInTheDocument();
  });

  it("confirming PUTs {enabled:false}, closes the dialog and shows SharePoint off with its list gone", async () => {
    const box = serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library()] } }),
    });
    box.put = ({ enabled }) => {
      box.view = connected({ sharePoint: enabled ? SP_ON : SP_OFF });
      box.sync = syncStatus({ sharePoint: { ...SP_OFF, libraries: [] } });
      return json({});
    };
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Turn off" }));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "false"),
    );
    const [[url, init]] = callsTo("/api/m365/sharepoint", "PUT");
    expect(url).toBe("/api/m365/sharepoint");
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("m365-library")).not.toBeInTheDocument();
  });

  it.each([
    ["the box refuses", () => json({ error: "internal" }, 500)],
    ["the box cannot be reached", () => new TypeError("Failed to fetch")],
  ])("says so inside the open dialog, and stays on, when %s", async (_label, fail) => {
    const box = serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library()] } }) });
    box.put = fail;
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Turn off" }));

    const dialog = await screen.findByTestId("confirm-dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/could not turn off sharepoint\. nothing changed/i),
    );
    // Said once, inside the dialog that covers the card; and still on.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL })).toHaveAttribute("aria-checked", "true");
  });

  it("forgets a failed turn-off's reason once the dialog is dismissed and opened again", async () => {
    const box = serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [library()] } }) });
    box.put = () => json({ error: "internal" }, 500);
    render(<Microsoft365Card />);

    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm-Turn off" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    expect(await screen.findByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("also asks when SharePoint is on but waiting for Microsoft's approval", async () => {
    serveBox({ view: connected({ sharePoint: SP_CONSENT }), sync: syncStatus({ sharePoint: { ...SP_CONSENT, libraries: [] } }) });
    render(<Microsoft365Card />);
    fireEvent.click(await screen.findByRole("switch", { name: SHAREPOINT_SWITCH_LABEL }));
    expect(await screen.findByTestId("confirm-dialog")).toBeInTheDocument();
    expect(callsTo("/api/m365/sharepoint", "PUT")).toHaveLength(0);
  });
});

describe("your files — keeping up while Droplet reads", () => {
  const sync = () => callsTo("/api/m365/sync-status").length;

  it("re-reads the status while a library has not finished its first read, and stops once it has", async () => {
    const box = serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library({ state: "SYNCING", lastSyncedAt: null, files: 37 })] } }),
    });
    render(<Microsoft365Card syncPollMs={20} />);

    const row = await screen.findByTestId("m365-library");
    expect(within(row).getByText("Reading")).toBeInTheDocument();
    await waitFor(() => expect(sync()).toBeGreaterThan(2)); // it is polling
    box.sync = syncStatus({ sharePoint: { libraries: [library()] } });
    // The LIBRARY's own chip, not any "Up to date" on the card: OneDrive's row
    // says that from the start, and waiting on it would read the count before
    // the library had settled.
    await waitFor(() => expect(within(screen.getByTestId("m365-library")).getByText("Up to date")).toBeInTheDocument());
    // The effect that stops the timer runs just after the render that shows it.
    await new Promise((r) => setTimeout(r, 60));

    const settled = sync();
    await new Promise((r) => setTimeout(r, 150));
    expect(sync()).toBe(settled); // …and has stopped
  });

  it("keeps re-reading while it has found no libraries yet", async () => {
    const box = serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [] } }) });
    render(<Microsoft365Card syncPollMs={20} />);
    await waitFor(() => expect(sync()).toBeGreaterThan(2));
    box.sync = syncStatus({ sharePoint: { libraries: [library()] } });
    expect(await screen.findByTestId("m365-library")).toBeInTheDocument();
  });

  it("re-reads while OneDrive has not finished its first read", async () => {
    serveBox({
      view: connected({ sharePoint: SP_OFF }),
      sync: syncStatus({ oneDrive: { files: 5, lastSyncedAt: null, state: "RESYNC_REQUIRED", lastError: null } }),
    });
    render(<Microsoft365Card syncPollMs={20} />);
    await waitFor(() => expect(sync()).toBeGreaterThan(2));
  });

  it("does not poll a status that is settled, or one whose only unread part failed", async () => {
    serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({
        oneDrive: { files: 5, lastSyncedAt: null, state: "FAILED", lastError: "no" },
        sharePoint: { libraries: [library(), library({ driveId: "b!drive-2", state: "FAILED", lastSyncedAt: null })] },
      }),
    });
    render(<Microsoft365Card syncPollMs={20} />);
    await screen.findAllByTestId("m365-library");
    await new Promise((r) => setTimeout(r, 150));
    expect(sync()).toBe(1);
  });

  it("does not poll while SharePoint is off, however empty its list is", async () => {
    serveBox({ view: connected({ sharePoint: SP_OFF }), sync: syncStatus({ sharePoint: { ...SP_OFF, libraries: [] } }) });
    render(<Microsoft365Card syncPollMs={20} />);
    await screen.findByTestId("m365-onedrive");
    await new Promise((r) => setTimeout(r, 150));
    expect(sync()).toBe(1);
  });

  it("does not poll while it waits for Microsoft's approval, which no amount of waiting changes", async () => {
    serveBox({ view: connected({ sharePoint: SP_CONSENT }), sync: syncStatus({ sharePoint: { ...SP_CONSENT, libraries: [] } }) });
    render(<Microsoft365Card syncPollMs={20} />);
    await screen.findByTestId("m365-sharepoint-consent");
    await new Promise((r) => setTimeout(r, 150));
    expect(sync()).toBe(1);
  });

  // Three different ways a later read goes wrong, and each one is its own path
  // through the reader: a refusal, an unreachable box and a body that is not a
  // status. None of them may blank a list the person was looking at.
  it.each([
    ["the box refuses", 503],
    ["the box cannot be reached", new TypeError("Failed to fetch")],
    ["it answers something that is not a status", { state: "CONNECTED" }],
  ])("keeps the last good status when a later read fails because %s, rather than blanking the list", async (_label, bad) => {
    const box = serveBox({
      view: connected({ sharePoint: SP_ON }),
      sync: syncStatus({ sharePoint: { libraries: [library({ state: "SYNCING", lastSyncedAt: null })] } }),
    });
    render(<Microsoft365Card syncPollMs={20} />);
    await screen.findByTestId("m365-library");
    const before = sync();
    box.sync = bad;
    await waitFor(() => expect(sync()).toBeGreaterThan(before + 1)); // it read again, and it failed
    expect(screen.getByTestId("m365-library")).toBeInTheDocument();
    expect(screen.queryByTestId("m365-sync-failed")).not.toBeInTheDocument();
  });

  it("stops polling when the card goes away", async () => {
    serveBox({ view: connected({ sharePoint: SP_ON }), sync: syncStatus({ sharePoint: { libraries: [] } }) });
    const { unmount } = render(<Microsoft365Card syncPollMs={20} />);
    await waitFor(() => expect(sync()).toBeGreaterThan(1));
    unmount();
    const atUnmount = sync();
    await new Promise((r) => setTimeout(r, 120));
    expect(sync()).toBe(atUnmount);
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
