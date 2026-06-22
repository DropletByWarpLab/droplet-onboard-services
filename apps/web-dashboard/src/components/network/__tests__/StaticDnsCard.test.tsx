/**
 * WARP-871 — StaticDnsCard: list / add / delete local DNS names from the
 * Network → System tab. Client-side validation mirrors schemas.py
 * DnsHostnameRequest; mutations re-fetch the list to confirm they landed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { StaticDnsCard } from "../StaticDnsCard";
import {
  fetchDnsHostnames,
  addDnsHostname,
  deleteDnsHostname,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDnsHostnames: vi.fn(),
    addDnsHostname: vi.fn(),
    deleteDnsHostname: vi.fn(),
  };
});

const listMock = vi.mocked(fetchDnsHostnames);
const addMock = vi.mocked(addDnsHostname);
const delMock = vi.mocked(deleteDnsHostname);

const ENTRY = { section: "cfg01", hostname: "nas.lan", ip: "192.168.50.20" };

beforeEach(() => {
  listMock.mockReset();
  addMock.mockReset();
  delMock.mockReset();
  listMock.mockResolvedValue([ENTRY] as never);
  addMock.mockResolvedValue({ status: "ok" } as never);
  delMock.mockResolvedValue({ status: "ok" } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

async function renderLoaded() {
  render(<StaticDnsCard />);
  // Wait for the mount fetch to resolve + render the entry. The delete button's
  // accessible name is unique to a real list row (the card's description text
  // also mentions "nas.lan" as an example, so text queries are ambiguous).
  return screen.findByRole("button", { name: /remove nas\.lan/i });
}

function fillAdd({ name = "printer.lan", ip = "192.168.50.30" } = {}) {
  fireEvent.change(screen.getByPlaceholderText("nas.lan"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText("192.168.50.20"), {
    target: { value: ip },
  });
}
async function clickAdd() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add name/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("StaticDnsCard (WARP-871)", () => {
  it("lists existing host-records from the API", async () => {
    await renderLoaded();
    // The row's IP is unique to the list (not in the description copy).
    expect(screen.getByText(/192\.168\.50\.20/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove nas\.lan/i }),
    ).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an uppercase hostname client-side", async () => {
    await renderLoaded();
    fillAdd({ name: "NAS.lan" });
    await clickAdd();
    expect(screen.getByText(/lowercase/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed IP client-side", async () => {
    await renderLoaded();
    fillAdd({ ip: "999.1.1.1" });
    await clickAdd();
    expect(screen.getByText(/valid address/i)).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("adds a name then re-fetches the list", async () => {
    await renderLoaded();
    fillAdd({ name: "printer.lan", ip: "192.168.50.30" });
    await clickAdd();
    expect(addMock).toHaveBeenCalledWith("printer.lan", "192.168.50.30");
    // mount fetch (1) + post-add refresh (2)
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/dns name added/i)).toBeInTheDocument();
  });

  it("deletes a name then re-fetches the list", async () => {
    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /remove nas\.lan/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(delMock).toHaveBeenCalledWith("nas.lan");
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a 422 validation refusal from the router in red", async () => {
    addMock.mockRejectedValue(
      new RouterStatusError("UNKNOWN", "hostname already exists.", 422),
    );
    await renderLoaded();
    fillAdd();
    await clickAdd();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already exists/i);
  });
});
