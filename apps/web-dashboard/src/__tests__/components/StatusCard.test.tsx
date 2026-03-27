import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusCard } from "@/components/StatusCard";

describe("StatusCard", () => {
  it("renders title and value", () => {
    render(<StatusCard title="Hostname" value="droplet-pi" />);
    expect(screen.getByText("Hostname")).toBeInTheDocument();
    expect(screen.getByText("droplet-pi")).toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(
      <StatusCard title="IP" value="192.168.1.100" subtitle="DHCP" />
    );
    expect(screen.getByText("DHCP")).toBeInTheDocument();
  });

  it("does not render subtitle when not provided", () => {
    const { container } = render(
      <StatusCard title="IP" value="192.168.1.100" />
    );
    const subtitles = container.querySelectorAll(".text-xs.text-slate-500");
    expect(subtitles.length).toBe(0);
  });

  it("shows status indicator when provided", () => {
    const { container } = render(
      <StatusCard title="DB" value="Connected" status="ok" />
    );
    const indicator = container.querySelector(".bg-emerald-500");
    expect(indicator).toBeInTheDocument();
  });

  it("shows error status indicator", () => {
    const { container } = render(
      <StatusCard title="DB" value="Offline" status="error" />
    );
    const indicator = container.querySelector(".bg-red-500");
    expect(indicator).toBeInTheDocument();
  });
});
