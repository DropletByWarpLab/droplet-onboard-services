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
const fetchBusinessTypes = vi.fn();
const applyBusinessType = vi.fn();
const swrMutate = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchAppModules: (...a: unknown[]) => fetchAppModules(...a),
  setAppModuleEnabled: (...a: unknown[]) => setAppModuleEnabled(...a),
  fetchBusinessTypes: (...a: unknown[]) => fetchBusinessTypes(...a),
  applyBusinessType: (...a: unknown[]) => applyBusinessType(...a),
}));
vi.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: (...a: unknown[]) => swrMutate(...a) }),
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
  businessType: "professional_office",
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

const BUSINESS_TYPES = [
  { id: "professional_office", label: "Professional office", description: "Office preset", modules: ["files"] },
  { id: "clinic", label: "Clinic / practice", description: "Practice preset", modules: ["files", "cameras"] },
  { id: "retail", label: "Retail", description: "Store preset", modules: ["cameras"] },
  { id: "hospitality", label: "Hospitality", description: "Venue preset", modules: ["voice"] },
  { id: "custom", label: "Custom", description: "Choose modules yourself", modules: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  fetchAppModules.mockResolvedValue(structuredClone(VIEW));
  fetchBusinessTypes.mockResolvedValue(structuredClone(BUSINESS_TYPES));
  setAppModuleEnabled.mockResolvedValue(undefined);
  applyBusinessType.mockResolvedValue({
    ...structuredClone(VIEW),
    businessType: "clinic",
    modules: VIEW.modules.map((item) => item.id === "smart_home"
      ? { ...item, enabled: true, effective: true }
      : item),
  });
  swrMutate.mockResolvedValue(undefined);
});

describe("FeaturesCard", () => {
  it("loads and renders module rows grouped by category", async () => {
    render(<FeaturesCard />);
    // Wait for the fetched modules to be painted, not merely requested.
    await screen.findByText("Ask AI");

    expect(screen.getByText("Ask AI")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Devices")).toBeInTheDocument();
    expect(
      screen.getByText("Pair and control Matter smart-home devices."),
    ).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByLabelText("Business type preset")).toHaveValue("professional_office");
  });

  it("confirms a preset, revalidates the current view, saves, and renders returned effective modules", async () => {
    fetchAppModules
      .mockResolvedValueOnce(structuredClone(VIEW))
      .mockResolvedValueOnce(structuredClone(VIEW))
      .mockResolvedValueOnce({
        ...structuredClone(VIEW),
        businessType: "clinic",
        modules: VIEW.modules.map((item) => item.id === "smart_home"
          ? { ...item, enabled: true, effective: true }
          : item),
      });
    render(<FeaturesCard />);
    const picker = await screen.findByLabelText("Business type preset");
    fireEvent.change(picker, { target: { value: "clinic" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Apply the Clinic / practice preset?");
    expect(screen.getByRole("switch", { name: "Devices" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "This turns modules on or off to match the preset.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply preset" }));
    await waitFor(() => expect(applyBusinessType).toHaveBeenCalledWith("clinic"));
    expect(fetchAppModules).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Business preset applied"));
    expect(swrMutate).toHaveBeenCalledWith("/api/modules");
    expect(await screen.findByLabelText("Business type preset")).toHaveValue("clinic");
    expect(screen.getByRole("switch", { name: "Devices" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not post a preset that became current before confirmation", async () => {
    render(<FeaturesCard />);
    fireEvent.change(await screen.findByLabelText("Business type preset"), {
      target: { value: "clinic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fetchAppModules.mockResolvedValueOnce({ ...structuredClone(VIEW), businessType: "clinic" });
    fireEvent.click(await screen.findByRole("button", { name: "Apply preset" }));
    await waitFor(() => expect(fetchAppModules).toHaveBeenCalledTimes(2));
    expect(applyBusinessType).not.toHaveBeenCalled();
    await waitFor(() => expect(swrMutate).toHaveBeenCalledWith("/api/modules"));
    expect(await screen.findByLabelText("Business type preset")).toHaveValue("clinic");
  });

  it("keeps a successful module toggle applied when status refresh fails, then retries refresh", async () => {
    fetchAppModules
      .mockResolvedValueOnce(structuredClone(VIEW))
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    swrMutate.mockRejectedValueOnce(new Error("cache refresh unavailable"));
    render(<FeaturesCard />);
    const toggle = await screen.findByRole("switch", { name: "Devices" });
    fireEvent.click(toggle);
    await waitFor(() => expect(setAppModuleEnabled).toHaveBeenCalledWith("smart_home", true));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("status")).toHaveTextContent("Changes were applied");
    expect(toast).toHaveBeenCalledWith("Devices turned on");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fetchAppModules.mockRejectedValueOnce(new Error("retry still unavailable"));
    swrMutate.mockRejectedValueOnce(new Error("cache retry unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Changes were applied");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fetchAppModules.mockResolvedValueOnce({
      ...structuredClone(VIEW),
      modules: VIEW.modules.map((item) => item.id === "smart_home"
        ? { ...item, enabled: true, effective: true }
        : item),
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("keeps a successful preset applied when status refresh fails and closes confirmation", async () => {
    fetchAppModules
      .mockResolvedValueOnce(structuredClone(VIEW))
      .mockResolvedValueOnce(structuredClone(VIEW))
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    swrMutate.mockRejectedValueOnce(new Error("cache refresh unavailable"));
    render(<FeaturesCard />);
    fireEvent.change(await screen.findByLabelText("Business type preset"), {
      target: { value: "clinic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply preset" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Changes were applied");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByLabelText("Business type preset")).toHaveValue("clinic");
    expect(screen.getByRole("switch", { name: "Devices" })).toHaveAttribute("aria-checked", "true");
    expect(toast).toHaveBeenCalledWith("Business preset applied");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the server description and truthful confirmation for Custom", async () => {
    render(<FeaturesCard />);
    const picker = await screen.findByLabelText("Business type preset");
    expect(screen.getByRole("option", { name: "Custom" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Custom \(0 modules\)/ })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "custom" } });
    expect(screen.getByText("Choose modules yourself")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "The Custom option records this choice and keeps the current module settings.",
    );
  });

  it("keeps the confirmation open and reports an apply error", async () => {
    applyBusinessType.mockRejectedValueOnce(new Error("forbidden"));
    render(<FeaturesCard />);
    fireEvent.change(await screen.findByLabelText("Business type preset"), {
      target: { value: "clinic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply preset" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't apply that business preset");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("pins core modules as always on with no switch", async () => {
    render(<FeaturesCard />);
    await screen.findByText("Always on");

    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Ask AI" }),
    ).not.toBeInTheDocument();
  });

  it("disables the switch and explains when the backend is not deployed", async () => {
    render(<FeaturesCard />);
    await screen.findByRole("switch", { name: "Email" });

    const sw = screen.getByRole("switch", { name: "Email" });
    expect(sw).toBeDisabled();
    expect(
      screen.getByText("Not installed on this Droplet"),
    ).toBeInTheDocument();
  });

  it("toggles a module optimistically, PATCHes it, and toasts", async () => {
    render(<FeaturesCard />);
    await screen.findByRole("switch", { name: "Devices" });

    const sw = screen.getByRole("switch", { name: "Devices" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);

    // Optimistic flip before the PATCH resolves.
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(setAppModuleEnabled).toHaveBeenCalledWith("smart_home", true),
    );
    expect(swrMutate).toHaveBeenCalledWith("/api/modules");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Devices turned on"));
  });

  it("reverts the switch and shows the error line when the PATCH fails", async () => {
    setAppModuleEnabled.mockRejectedValueOnce(new Error("admin_required"));
    render(<FeaturesCard />);
    await screen.findByRole("switch", { name: "Devices" });

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
