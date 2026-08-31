import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KpiStrip } from "./KpiStrip";
import { ConnectionHero } from "./ConnectionHero";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { ConnectorCard } from "@/components/integrations/ConnectorCard";
import type { ConnectorMeta, IntegrationConnection } from "@/lib/erp-types";
import { CONNECTED_DETAIL } from "./erp.fixtures";

describe("KpiStrip", () => {
  it("shows em-dash placeholders when there is no snapshot", () => {
    render(<KpiStrip />);
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("shows real values when connected", () => {
    render(<KpiStrip kpis={CONNECTED_DETAIL.kpis} />);
    expect(screen.getByText("$8,240")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("$42,910")).toBeTruthy();
  });
});

describe("ConnectionHero", () => {
  it("renders the not-connected headline and connect CTA", () => {
    const c: IntegrationConnection = { provider: "eaglesoft", status: "NOT_CONFIGURED", writeEnabled: false };
    render(<ConnectionHero connection={c} onConnect={vi.fn()} onManage={vi.fn()} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("Connect Eaglesoft")).toBeTruthy();
  });

  it("renders the connected headline and a read-only pill", () => {
    render(<ConnectionHero connection={CONNECTED_DETAIL.connection} onConnect={vi.fn()} onManage={vi.fn()} />);
    expect(screen.getByText("Connected to Eaglesoft")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText("Manage")).toBeTruthy();
  });

  it("shows Fix connection when the connection is degraded", () => {
    const c: IntegrationConnection = {
      provider: "eaglesoft",
      status: "DEGRADED",
      writeEnabled: false,
      reason: "The Eaglesoft server didn't answer.",
    };
    render(<ConnectionHero connection={c} onConnect={vi.fn()} onManage={vi.fn()} />);
    expect(screen.getByText("Eaglesoft needs attention")).toBeTruthy();
    expect(screen.getByText("Fix connection")).toBeTruthy();
  });

  /**
   * WARP-2483 — the far end of the hub tile's "Remove credential" action.
   *
   * The hub sends a disconnected-but-key-still-stored tile HERE, because
   * Disconnect lives on `ManageSheet` and `onManage` is what opens it. Without
   * this branch the hero offered only "Connect Eaglesoft", so the owner
   * followed an action that promised to finish the purge and arrived at a page
   * whose only button stores a SECOND credential — precisely the dead-end
   * click WARP-2291 exists to forbid.
   *
   * Mutation: drop the `credentialsPurged === false` branch → red, because the
   * hero falls back to "Connect Eaglesoft" and `onManage` is never reachable.
   */
  it("offers the disconnect path again when a disconnected connection still holds its credential", () => {
    const onManage = vi.fn();
    const c: IntegrationConnection = {
      provider: "eaglesoft",
      status: "DISABLED",
      writeEnabled: false,
      credentialsPurged: false,
    };
    render(<ConnectionHero connection={c} onConnect={vi.fn()} onManage={onManage} />);

    expect(screen.getByText("Disconnected")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Remove credential/ });
    fireEvent.click(button);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  /**
   * …and the purged connection does NOT get that button. There is nothing left
   * to remove, and an action that cannot change anything is noise on the one
   * screen that just told the owner the key is gone.
   *
   * Mutation: offer "Remove credential" for every DISABLED connection → red.
   */
  it("offers setup, not removal, once the credential is actually gone", () => {
    const c: IntegrationConnection = {
      provider: "eaglesoft",
      status: "DISABLED",
      writeEnabled: false,
      credentialsPurged: true,
    };
    render(<ConnectionHero connection={c} onConnect={vi.fn()} onManage={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Remove credential/ })).toBeNull();
    expect(screen.getByText("Connect Eaglesoft")).toBeTruthy();
  });
});

describe("SafetyChip", () => {
  it("renders the PHI read chip verbatim", () => {
    render(<SafetyChip variant="read-phi" />);
    expect(screen.getByText("Read · PHI · stays on LAN")).toBeTruthy();
  });

  it("renders the write chip verbatim", () => {
    render(<SafetyChip variant="write" />);
    expect(screen.getByText("Write · confirm to apply")).toBeTruthy();
  });
});

describe("ConnectorCard", () => {
  const meta = (over: Partial<ConnectorMeta>): ConnectorMeta => ({
    id: "eaglesoft",
    name: "Eaglesoft",
    category: "Practice management",
    description: "Read your schedule, patients, and balances.",
    availability: "available",
    ...over,
  });

  // WARP-2291: the card renders an explicit ConnectionState and carries the
  // dispatch its buttons perform. `reported` is the state these two cases
  // were always describing — a status the box actually told us about.
  const entry = (m: ConnectorMeta, connection: IntegrationConnection) => ({
    meta: m,
    state: { kind: "reported" as const, connection },
    connect: { kind: "wizard" as const, catalogId: "eaglesoft" },
    // WARP-2560 (ADR-044) — the practice surface lives at /practice now. The
    // hub tile still opens it; only the address changed.
    open: { kind: "route" as const, href: "/practice" },
  });

  it("an available connector shows Connect", () => {
    render(
      <ConnectorCard
        entry={entry(meta({}), { provider: "eaglesoft", status: "NOT_CONFIGURED", writeEnabled: false })}
        onConnect={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Connect")).toBeTruthy();
  });

  it("a coming-soon connector shows Coming soon and no action button", () => {
    render(
      <ConnectorCard
        entry={entry(
          meta({ id: "dentrix", name: "Dentrix", availability: "coming-soon" }),
          { provider: "dentrix", status: "NOT_CONFIGURED", writeEnabled: false },
        )}
        onConnect={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect(screen.queryByText("Connect")).toBeNull();
  });
});
