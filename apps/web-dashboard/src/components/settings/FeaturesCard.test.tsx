/**
 * WARP-1368 — Settings → "Features" panel (module toggles).
 *
 * The states this pins:
 *   - loads GET /api/modules and renders every module row grouped
 *     Workspace / Operations with label + description;
 *   - core modules render "Always on" (no switch); unavailable modules render
 *     a disabled switch + "Not installed on this Droplet";
 *   - a toggle is optimistic (switch flips immediately), PATCHes the module,
 *     and toasts `<label> turned on`;
 *   - a failed toggle reverts the switch and shows the error line;
 *   - lesser roles render nothing — Settings is an admin surface (§6.3).
 *
 * Born from the WARP-1367 incident: smart_home ships defaultEnabled:false and
 * there was no UI anywhere to switch it on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchAppModules = vi.fn();
const setAppModuleEnabled = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchAppModules: (...a: unknown[]) => fetchAppModules(...a),
  setAppModuleEnabled: (...a: unknown[]) => setAppModuleEnabled(...a),
}));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "stefan@warp-lab.ai", role: mockRole },
  }),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast }),
}));

import { FeaturesCard } from "./FeaturesCard";

function mod(over: Record<string, unknown> = {}) {
  return {
    id: "smart_home",
    label: "Devices",
    description: "Pair and control Matter smart-home devices.",
    category: "operations",
    core: false,
    available: true,
    enabled: false,
    effective: false,
    ...over,
  };
}

const VIEW = {
  businessType: "dental",
  modules: [
    mod({
      id: "chat",
      label: "Ask AI",
      description: "The Droplet assistant.",
      category: "workspace",
      core: true,
      enabled: true,
      effective: true,
    }),
    mod({
      id: "email",
      label: "Email",
      description: "Connected mailboxes and the email surface.",
      category: "workspace",
      available: false,
    }),
    mod(),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  fetchAppModules.mockResolvedValue(structuredClone(VIEW));
  setAppModuleEnabled.mockResolvedValue(undefined);
});

describe("FeaturesCard", () => {
  it("loads and renders module rows grouped by category", async () => {
    render(<FeaturesCard />);
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalled());

    expect(screen.getByText("Ask AI")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Devices")).toBeInTheDocument();
    expect(
      screen.getByText("Pair and control Matter smart-home devices."),
    ).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
  });

  it("pins core modules as always on with no switch", async () => {
    render(<FeaturesCard />);
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalled());

    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Ask AI" }),
    ).not.toBeInTheDocument();
  });

  it("disables the switch and explains when the backend is not deployed", async () => {
    render(<FeaturesCard />);
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalled());

    const sw = screen.getByRole("switch", { name: "Email" });
    expect(sw).toBeDisabled();
    expect(
      screen.getByText("Not installed on this Droplet"),
    ).toBeInTheDocument();
  });

  it("toggles a module optimistically, PATCHes it, and toasts", async () => {
    render(<FeaturesCard />);
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalled());

    const sw = screen.getByRole("switch", { name: "Devices" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);

    // Optimistic flip before the PATCH resolves.
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(setAppModuleEnabled).toHaveBeenCalledWith("smart_home", true),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Devices turned on"));
  });

  it("reverts the switch and shows the error line when the PATCH fails", async () => {
    setAppModuleEnabled.mockRejectedValueOnce(new Error("admin_required"));
    render(<FeaturesCard />);
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalled());

    const sw = screen.getByRole("switch", { name: "Devices" });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That didn't apply — the switch was put back. Try again.",
      ),
    );
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows the load-failed line with an inline retry that reloads", async () => {
    fetchAppModules.mockRejectedValueOnce(new Error("boom"));
    render(<FeaturesCard />);
    await waitFor(() =>
      expect(screen.getByText("Couldn't load features.")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Devices")).toBeInTheDocument();
  });

  it("renders nothing for family/guest", () => {
    mockRole = "family";
    const { container } = render(<FeaturesCard />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchAppModules).not.toHaveBeenCalled();
  });
});
