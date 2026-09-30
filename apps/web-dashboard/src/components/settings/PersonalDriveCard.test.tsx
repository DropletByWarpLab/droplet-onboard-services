/**
 * Settings -> "Personal drives" (owner only).
 *
 * The owner switch behind POST /api/storage/network-drive/personal. Pins:
 *   - it loads `personalDriveEnabled` from GET /api/settings/workspace and
 *     shows the switch OFF unless the server says true;
 *   - the copy discloses that Finder / File Explorer access is not recorded as
 *     downloads and skips the per-file upload limit, and that turning it off
 *     signs everyone out of their personal drive;
 *   - a toggle is optimistic, PUTs /api/settings/workspace/personal-drive and
 *     toasts; a failed PUT puts the switch back and shows the error line;
 *   - every role but owner renders nothing and never fetches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const authFetch = vi.fn();
let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
  useAuth: () => ({
    user: { id: "u1", username: "romain", role: mockRole },
  }),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast }),
}));

import { PersonalDriveCard } from "./PersonalDriveCard";

function res(ok: boolean, body: unknown = {}) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

/** GET returns the flag; PUT resolves per `put`. */
function mockServer(flag: boolean | undefined, put: () => Response = () => res(true)) {
  authFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? put()
      : res(true, { workspaceType: "business", personalDriveEnabled: flag }),
  );
}

const SWITCH = "Let people map their own drive";

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  mockServer(false);
});

describe("PersonalDriveCard", () => {
  it("loads the setting and shows the switch off by default", async () => {
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(authFetch).toHaveBeenCalledWith("/api/settings/workspace");
  });

  it("shows the switch on when the server says personal drives are on", async () => {
    mockServer(true);
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
  });

  it("treats a response without the flag as off", async () => {
    mockServer(undefined);
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("says plainly that drive access is not audited as downloads and skips the upload limit", async () => {
    render(<PersonalDriveCard />);
    await screen.findByRole("switch", { name: SWITCH });
    expect(
      screen.getByText(
        /Files opened or copied through Finder or File Explorer are not recorded as downloads in the activity log, and the per-file upload size limit does not apply there\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Guests can't\./)).toBeInTheDocument();
    // Off revokes the drive logins (no claim Nextcloud confirmed each sign-out);
    // only pre-update logins need removing by hand, and the copy says where to find them.
    expect(
      screen.getByText(/Turning this off revokes every personal drive login and stops new ones\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Drive logins made before this update are not revoked automatically; they show up in each person’s Paired devices as “Finder on …” or “File Explorer on …” and can be removed there\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/signs everyone out|signed out/)).not.toBeInTheDocument();
    expect(screen.queryByText(/keep working/)).not.toBeInTheDocument();
  });

  // The `family` tier is displayed as "Staff" everywhere (lib/access.ts
  // tierLabel); the raw enum value must never reach the owner's screen.
  it("names the audience with the dashboard's role labels, never the raw `family` tier", async () => {
    const { container } = render(<PersonalDriveCard />);
    await screen.findByRole("switch", { name: SWITCH });
    expect(
      screen.getByText(/Owners, admins and staff members can put their own files in Finder or File Explorer/),
    ).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/famil/i);
  });

  it("toggles optimistically, PUTs the owner endpoint, and toasts", async () => {
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).not.toBeDisabled());

    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith("/api/settings/workspace/personal-drive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Personal drives turned on"));
  });

  it("turns it back off with enabled:false", async () => {
    mockServer(true);
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(sw);
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        "/api/settings/workspace/personal-drive",
        expect.objectContaining({ body: JSON.stringify({ enabled: false }) }),
      ),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Personal drives turned off"));
  });

  it("puts the switch back and shows the error line when the PUT fails", async () => {
    mockServer(false, () => res(false));
    render(<PersonalDriveCard />);
    const sw = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(sw).not.toBeDisabled());

    fireEvent.click(sw);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That didn't apply — the switch was put back. Try again.",
      ),
    );
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows a load error and no switch when the setting cannot be read", async () => {
    authFetch.mockResolvedValue(res(false));
    render(<PersonalDriveCard />);
    expect(await screen.findByText("Couldn't load this setting.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it.each(["admin", "family", "guest"])("renders nothing and never fetches for %s", (role) => {
    mockRole = role;
    const { container } = render(<PersonalDriveCard />);
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
