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
    // Subtitle element uses `type-caption-1 text-label-tertiary`; absent when
    // no subtitle prop is provided.
    const subtitles = container.querySelectorAll(".text-label-tertiary");
    expect(subtitles.length).toBe(0);
  });

  it("shows status indicator when provided", () => {
    const { container } = render(
      <StatusCard title="DB" value="Connected" status="ok" />
    );
    // StatusCard maps `ok` → `bg-system-green` (design-system token, replaces
    // the former `bg-emerald-500` Tailwind default).
    const indicator = container.querySelector(".bg-system-green");
    expect(indicator).toBeInTheDocument();
  });

  it("shows error status indicator", () => {
    const { container } = render(
      <StatusCard title="DB" value="Offline" status="error" />
    );
    // `error` → `bg-system-red` (design-system token, replaces former
    // `bg-red-500` Tailwind default).
    const indicator = container.querySelector(".bg-system-red");
    expect(indicator).toBeInTheDocument();
  });

  it("uses human-readable aria-label for status dot (not raw enum)", () => {
    // WARP-298: aria-label was previously the raw enum ("ok"/"warning"); now
    // mapped to plain English so SR users get useful announcements.
    const { rerender } = render(
      <StatusCard title="DB" value="Connected" status="ok" />
    );
    expect(screen.getByLabelText("All good")).toBeInTheDocument();

    rerender(<StatusCard title="DB" value="Warn" status="warning" />);
    expect(screen.getByLabelText("Needs attention")).toBeInTheDocument();

    rerender(<StatusCard title="DB" value="Down" status="error" />);
    expect(screen.getByLabelText("Error")).toBeInTheDocument();

    rerender(<StatusCard title="DB" value="Offline" status="offline" />);
    expect(screen.getByLabelText("Offline")).toBeInTheDocument();
  });
});
