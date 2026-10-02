import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/lib/api", () => ({
  listBuildingDevices: vi.fn(),
  readBuildingValues: vi.fn(),
  writeBuildingPoint: vi.fn(),
  saveBuildingDevice: vi.fn(),
  deleteBuildingDevice: vi.fn(),
  discoverBuildingDevices: vi.fn(),
}));

import * as api from "@/lib/api";
import { BuildingSystemsSection, slugify } from "../BuildingSystemsSection";

const a = vi.mocked(api);

const RTU = {
  id: "rtu-1", name: "Rooftop unit", protocol: "modbus" as const, address: "10.0.0.5", room: "Roof",
  points: [
    { id: "setpoint", name: "Setpoint", kind: "number" as const, unit: "°C", writable: true, min: 16, max: 28 },
    { id: "supply", name: "Supply temp", kind: "number" as const, unit: "°C", writable: false },
  ],
};

function wrap(ui: ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  a.listBuildingDevices.mockResolvedValue([RTU]);
  a.readBuildingValues.mockResolvedValue({
    read_at: "t",
    values: { setpoint: { value: 21, error: null }, supply: { value: null, error: "timeout" } },
  });
});

describe("BuildingSystemsSection", () => {
  it("stays out of the way for non-admins when there are no devices", async () => {
    a.listBuildingDevices.mockResolvedValue([]);
    const { container } = wrap(<BuildingSystemsSection canAdmin={false} />);
    await waitFor(() => expect(a.listBuildingDevices).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("tells admins when the gateway is unavailable", async () => {
    a.listBuildingDevices.mockRejectedValue(new Error("503"));
    wrap(<BuildingSystemsSection canAdmin />);
    expect(await screen.findByText(/isn’t available on this box/)).toBeInTheDocument();
  });

  it("reads live values with units and marks a failed point", async () => {
    wrap(<BuildingSystemsSection canAdmin={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read Rooftop unit" }));
    const card = screen.getByTestId("building-device-rtu-1");
    expect(await within(card).findByText("21 °C")).toBeInTheDocument();
    expect(within(card).getByText("No reading")).toHaveAttribute("title", "timeout");
  });

  it("non-admins get no write controls", async () => {
    wrap(<BuildingSystemsSection canAdmin={false} />);
    await screen.findByText("Rooftop unit");
    expect(screen.queryByRole("button", { name: "Set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add device/ })).not.toBeInTheDocument();
  });

  it("confirms before writing, enforces bounds in the input, and says when nothing was sent", async () => {
    a.writeBuildingPoint.mockResolvedValue({ applied: false, live_writes: false });
    wrap(<BuildingSystemsSection canAdmin />);
    const input = await screen.findByLabelText("New Setpoint");
    const set = screen.getByRole("button", { name: "Set" });

    fireEvent.change(input, { target: { value: "40" } });
    expect(set).toBeDisabled();
    fireEvent.change(input, { target: { value: "22.5" } });
    expect(set).toBeEnabled();
    fireEvent.click(set);

    expect(a.writeBuildingPoint).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm & apply" }));
    await waitFor(() => expect(a.writeBuildingPoint).toHaveBeenCalledWith("rtu-1", "setpoint", 22.5));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/nothing was sent/), "info");
  });

  it("the read-only point has no input", async () => {
    wrap(<BuildingSystemsSection canAdmin />);
    await screen.findByLabelText("New Setpoint");
    expect(screen.queryByLabelText("New Supply temp")).not.toBeInTheDocument();
  });

  it("adds an SNMP printer from its template with a slug id", async () => {
    a.saveBuildingDevice.mockResolvedValue({ ...RTU, id: "front-printer" });
    wrap(<BuildingSystemsSection canAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: /Add device/ }));
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "snmp" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Front Printer" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "10.0.0.20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save device" }));
    await waitFor(() =>
      expect(a.saveBuildingDevice).toHaveBeenCalledWith("front-printer", {
        name: "Front Printer", protocol: "snmp", address: "10.0.0.20", points: [],
        community: "public", template: "printer",
      }),
    );
  });

  it("rejects points that are not a JSON list before saving", async () => {
    wrap(<BuildingSystemsSection canAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: /Add device/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "AHU" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "10.0.0.9" } });
    fireEvent.change(screen.getByLabelText("Points (JSON)"), { target: { value: "{nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("JSON list");
    expect(a.saveBuildingDevice).not.toHaveBeenCalled();
  });
});

describe("slugify", () => {
  it.each([
    ["Rooftop Unit 1", "rooftop-unit-1"],
    ["  Réception  UPS ", "reception-ups"],
    ["***", "device"],
  ])("%j → %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
