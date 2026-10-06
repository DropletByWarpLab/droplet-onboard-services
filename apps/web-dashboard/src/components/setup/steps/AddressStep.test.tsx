import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddressStep } from "./AddressStep";

const fetchVpnStatus = vi.fn();
vi.mock("@/lib/api", () => ({ fetchVpnStatus: (...args: unknown[]) => fetchVpnStatus(...args) }));
beforeEach(() => { fetchVpnStatus.mockReset(); });

describe("AddressStep — internal DNS", () => {
  it("shows the configured internal name and local trust guidance", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: "droplet-ai.lan", publicFqdn: "legacy.example.com" });
    const complete = vi.fn();
    render(<AddressStep onComplete={complete} onSkip={vi.fn()} />);
    expect(await screen.findByText("https://droplet-ai.lan")).toBeInTheDocument();
    expect(screen.queryByText(/legacy.example.com/)).not.toBeInTheDocument();
    expect(screen.getByText(/certificate must cover the internal hostname/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(complete).toHaveBeenCalledOnce();
  });
  it("reports an unconfigured name instead of waiting for cloud provisioning", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: null });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(await screen.findByText(/internal DNS name is not configured/i)).toBeInTheDocument();
    expect(screen.queryByText(/coming soon|automatically|publicly.trusted/i)).not.toBeInTheDocument();
  });
  it("can retry a failed status check", async () => {
    fetchVpnStatus.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ internalHostname: "box.lan" });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(await screen.findByText(/couldn't check the internal address/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(await screen.findByText("https://box.lan")).toBeInTheDocument();
  });
  it("keeps Skip available", async () => {
    fetchVpnStatus.mockResolvedValue({ internalHostname: null });
    const skip = vi.fn();
    render(<AddressStep onComplete={vi.fn()} onSkip={skip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(skip).toHaveBeenCalledOnce();
  });
});
