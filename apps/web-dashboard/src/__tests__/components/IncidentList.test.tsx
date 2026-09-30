/**
 * WARP-2978 (ADR-059 P3 §8) — the Incidents tab on /security.
 *
 * The list is presentational (the page wires SWR). It must hold:
 *   · each card says only what the box sent for this viewer (DS-005): the
 *     badge from the visible severity, the codes it can see, its count;
 *   · "Needs attention" / "All" drive the `state` filter;
 *   · an empty list says WHICH empty it is — never "nothing needs attention"
 *     while the incident engine or a camera source is down;
 *   · a failed read is an error with Retry, never an empty list.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IncidentList, type IncidentListProps } from "@/components/security/IncidentList";
import { IncidentCard } from "@/components/security/IncidentCard";
import { INCIDENT_COPY } from "@/components/security/incident-copy";
import type { IncidentSummary, SecurityHealthRow } from "@/lib/types";

const TZ = "Europe/London";
const NOW = new Date("2026-09-23T01:31:00Z");
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;

const OK: SecurityHealthRow[] = (["camera_ingest", "camera_system", "threat_mirror", "site_mode", "incidents", "retention"] as const).map(
  (id) => ({ id, state: "ok", detail: "", lastSeenAt: null }),
);

function incident(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f",
    scope: "area",
    zone: { id: "z1", name: "Stock room", kind: "restricted" },
    camera: null,
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    grouping: "closed",
    openedInMode: "closed",
    firstActivityAt: at("01:14"),
    lastActivityAt: at("01:20"),
    eventCount: 3,
    labels: { person: 3 },
    lastAck: null,
    ...over,
  };
}

function props(over: Partial<IncidentListProps> = {}): IncidentListProps {
  return {
    incidents: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    filter: "attention",
    onFilterChange: vi.fn(),
    sources: OK,
    canSeeThreats: true,
    timezone: TZ,
    now: NOW,
    ...over,
  };
}

describe("IncidentCard", () => {
  it("an alert: the Alert badge, the area, what and when, and that it needs attention — linked to its page", () => {
    render(
      <ul>
        <IncidentCard incident={incident()} timezone={TZ} now={NOW} />
      </ul>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/security/incidents/7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f");
    expect(within(link).getByText("Alert")).toHaveClass("badge", "danger");
    expect(link).toHaveTextContent("Stock room");
    expect(link).toHaveTextContent("Someone inside after hours · 2:14 AM – 2:20 AM");
    expect(link).toHaveTextContent("Needs attention");
  });

  it("a notice is marked Notice; plain activity has no badge and counts its visible events", () => {
    const { rerender } = render(
      <ul>
        <IncidentCard incident={incident({ severity: "notice", reasonCodes: ["camera_offline"] })} timezone={TZ} now={NOW} />
      </ul>,
    );
    expect(screen.getByText("Notice")).toHaveClass("badge", "warn");
    rerender(
      <ul>
        <IncidentCard incident={incident({ severity: "info", state: "no_action", reasonCodes: [] })} timezone={TZ} now={NOW} />
      </ul>,
    );
    expect(screen.queryByText("Alert")).toBeNull();
    expect(screen.queryByText("Notice")).toBeNull();
    expect(screen.getByRole("link")).toHaveTextContent("3 events · 2:14 AM – 2:20 AM");
    expect(screen.getByRole("link")).not.toHaveTextContent("Needs attention");
  });

  it("PR-D: the `_ongoing` count is the box's bookkeeping — never shown; the card counts the event rows (a 40-second visit is 2)", () => {
    render(
      <ul>
        <IncidentCard
          incident={incident({ severity: "info", state: "no_action", reasonCodes: [], eventCount: 2, labels: { person: 1, _ongoing: 1 }, grouping: "collecting" })}
          timezone={TZ}
          now={NOW}
        />
      </ul>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("2 events · 2:14 AM – 2:20 AM");
    expect(link).toHaveTextContent(INCIDENT_COPY.stillHappening);
    expect(link).not.toHaveTextContent(/ongoing|people/i);
  });

  it("names a camera by the name it was given, and the site-wide scopes in words", () => {
    const label = (n: string) => (n === "back_cam" ? "Back camera" : n);
    const { rerender } = render(
      <ul>
        <IncidentCard incident={incident({ scope: "camera", zone: null, camera: "back_cam" })} cameraLabel={label} timezone={TZ} now={NOW} />
      </ul>,
    );
    expect(screen.getByRole("link")).toHaveTextContent("Back camera");
    rerender(
      <ul>
        <IncidentCard incident={incident({ scope: "site_threat", zone: null, severity: "notice", reasonCodes: ["threat_signal"] })} timezone={TZ} now={NOW} />
      </ul>,
    );
    expect(screen.getByRole("link")).toHaveTextContent("Network and sign-in");
  });

  it("says who acknowledged, only as the box said it", () => {
    render(
      <ul>
        <IncidentCard
          incident={incident({ state: "acknowledged", lastAck: { action: "acknowledge", byName: "Maria", at: at("01:17") } })}
          timezone={TZ}
          now={NOW}
        />
      </ul>,
    );
    expect(screen.getByRole("link")).toHaveTextContent("Acknowledged by Maria at 2:17 AM");
  });
});

describe("IncidentList", () => {
  it("renders one card per incident, in the order given", () => {
    render(
      <IncidentList
        {...props({
          incidents: [incident({ id: "a", zone: { id: "z1", name: "Stock room", kind: "restricted" } }), incident({ id: "b", zone: { id: "z2", name: "Shop floor", kind: "interior" } })],
        })}
      />,
    );
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/security/incidents/a", "/security/incidents/b"]);
  });

  it("the filter chips: Needs attention and All, pressed by the current filter", () => {
    const onFilterChange = vi.fn();
    render(<IncidentList {...props({ onFilterChange })} />);
    expect(screen.getByRole("button", { name: INCIDENT_COPY.needsAttention })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });

  it("the area select, when the viewer can see an area", () => {
    const onZoneChange = vi.fn();
    render(<IncidentList {...props({ areas: [{ id: "z1", name: "Stock room", linkCount: 1 }], zone: null, onZoneChange })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Area" }), { target: { value: "z1" } });
    expect(onZoneChange).toHaveBeenCalledWith("z1");
  });

  it("empty and every source reporting → nothing needs attention", () => {
    const { container } = render(<IncidentList {...props()} />);
    expect(container.querySelector("[data-empty]")).toHaveAttribute("data-empty", "quiet");
    expect(screen.getByText(INCIDENT_COPY.emptyAttention)).toBeInTheDocument();
  });

  it("empty while the incident engine is down → NOT nothing needs attention, and a way to Everything", () => {
    const onShowEverything = vi.fn();
    const sources = OK.map((s) => (s.id === "incidents" ? { ...s, state: "down" as const } : s));
    const { container } = render(<IncidentList {...props({ sources, onShowEverything })} />);
    expect(container.querySelector("[data-empty]")).toHaveAttribute("data-empty", "not-reporting");
    expect(screen.queryByText(INCIDENT_COPY.emptyAttention)).toBeNull();
    expect(screen.getByText(INCIDENT_COPY.emptyNotSorting)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
    expect(onShowEverything).toHaveBeenCalled();
  });

  it("while the sources are still loading, an empty list claims nothing", () => {
    const { container } = render(<IncidentList {...props({ sources: null })} />);
    expect(container.querySelector("[data-empty]")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("a refresh that fails with incidents already shown keeps them, and says they're the last list Droplet sent, with Retry (WARP-3185 1)", () => {
    const onRetry = vi.fn();
    render(<IncidentList {...props({ incidents: [incident()], error: new Error("503"), onRetry })} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/security/incidents/7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f");
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Couldn't refresh the incidents just now. This is the last list Droplet sent.");
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("no refresh line while the list is current", () => {
    render(<IncidentList {...props({ incidents: [incident()] })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a failed read is an error with Retry — never an empty list", () => {
    const onRetry = vi.fn();
    const { container } = render(<IncidentList {...props({ incidents: null, error: new Error("503"), onRetry })} />);
    expect(container.querySelector("[data-empty]")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Droplet can't read the incidents right now");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("Show older is aria-disabled while it loads — never disabled — and a second press before the load starts is refused (WARP-3185 B)", () => {
    const onLoadMore = vi.fn();
    const first = incident({ id: "a" });
    const { rerender } = render(<IncidentList {...props({ incidents: [first], hasMore: true, onLoadMore })} />);
    const older = screen.getByRole("button", { name: "Show older" });
    older.focus();
    fireEvent.click(older);
    fireEvent.click(older);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<IncidentList {...props({ incidents: [first], hasMore: true, isLoadingMore: true, onLoadMore })} />);
    expect(older).toHaveAttribute("aria-disabled", "true");
    expect(older).not.toBeDisabled();
    expect(older).toHaveFocus();
    fireEvent.click(older);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("when the last page lands, Show older goes and focus moves to the first card it added — never <body> (WARP-3185 B)", () => {
    const onLoadMore = vi.fn();
    const first = incident({ id: "a" });
    const added = incident({ id: "b", zone: { id: "z2", name: "Shop floor", kind: "interior" } });
    const { rerender } = render(<IncidentList {...props({ incidents: [first], hasMore: true, onLoadMore })} />);
    const older = screen.getByRole("button", { name: "Show older" });
    older.focus();
    fireEvent.click(older);
    rerender(<IncidentList {...props({ incidents: [first], hasMore: true, isLoadingMore: true, onLoadMore })} />);
    rerender(<IncidentList {...props({ incidents: [first, added], hasMore: false, onLoadMore })} />);
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    expect(screen.getByRole("link", { name: /Shop floor/ })).toHaveFocus();
  });

  it("a page that lands with more still to come leaves focus on Show older, which works again", () => {
    const onLoadMore = vi.fn();
    const first = incident({ id: "a" });
    const { rerender } = render(<IncidentList {...props({ incidents: [first], hasMore: true, onLoadMore })} />);
    const older = screen.getByRole("button", { name: "Show older" });
    older.focus();
    fireEvent.click(older);
    rerender(<IncidentList {...props({ incidents: [first], hasMore: true, isLoadingMore: true, onLoadMore })} />);
    rerender(<IncidentList {...props({ incidents: [first, incident({ id: "b" })], hasMore: true, onLoadMore })} />);
    expect(screen.getByRole("button", { name: "Show older" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("Show older loads the next page", () => {
    const onLoadMore = vi.fn();
    render(<IncidentList {...props({ incidents: [incident()], hasMore: true, onLoadMore })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(onLoadMore).toHaveBeenCalled();
  });
});
