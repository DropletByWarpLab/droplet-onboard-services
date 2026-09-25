/**
 * WARP-2977 (ADR-059 §3.2) — the /security feed.
 *
 * The rule this file exists for: "nothing happened" and "nothing is
 * reporting" must never look the same. An empty feed names which empty it
 * is, and it says nothing at all until it knows.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Moon, Plane, Shield, Store } from "lucide-react";
import {
  COPY,
  SOURCE_LABEL,
  SecurityFeed,
  iconFor,
  kindsForView,
  sourcesForView,
  type SecurityFeedProps,
  type SecurityView,
} from "@/components/security/SecurityFeed";
import { NAV_GROUPS, moduleForPath } from "@/components/nav-config";
import { SPACES } from "@/components/workspace/workspace-nav-config";
import type { SecurityEvent, SecurityEventKind, SecurityHealthRow } from "@/lib/types";

const NOW = new Date("2026-09-23T02:14:00Z");

const OK: SecurityHealthRow[] = [
  { id: "camera_ingest", state: "ok", detail: "Listening", lastSeenAt: NOW.toISOString() },
  { id: "camera_system", state: "ok", detail: "Camera system running", lastSeenAt: NOW.toISOString() },
  { id: "threat_mirror", state: "ok", detail: "Network and sign-in warnings", lastSeenAt: NOW.toISOString() },
  // WARP-2977 P2b — the opening-hours ticker's row, in its pinned place before retention.
  { id: "site_mode", state: "ok", detail: "Following opening hours (Europe/London)", lastSeenAt: NOW.toISOString() },
  { id: "retention", state: "ok", detail: "Keeps 30 days; last removed 0", lastSeenAt: NOW.toISOString() },
];

function withIngest(state: SecurityHealthRow["state"]): SecurityHealthRow[] {
  return OK.map((s) => (s.id === "camera_ingest" ? { ...s, state } : s));
}

function event(over: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id: "1",
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: "front_door",
    labels: ["person"],
    cameraZones: ["porch"],
    score: 0.86,
    startedAt: new Date(NOW.getTime() - 120_000).toISOString(),
    endedAt: NOW.toISOString(),
    summary: "Person in porch",
    frigateEventId: "171.5-abc",
    zones: [],
    ...over,
  };
}

/** A WARP-2977 P2b site-mode row: site-wide, labels = [mode, modeSource]. */
function modeRow(mode: "open" | "closed" | "away", source: "schedule" | "manual", summary: string): SecurityEvent {
  return event({
    id: `m-${mode}-${source}`,
    source: "site_mode",
    kind: "mode_changed",
    camera: null,
    labels: [mode, source],
    cameraZones: [],
    score: null,
    endedAt: null,
    summary,
    frigateEventId: null,
  });
}

function props(over: Partial<SecurityFeedProps> = {}): SecurityFeedProps {
  return {
    sources: OK,
    events: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    view: "all",
    onViewChange: vi.fn(),
    includeLow: false,
    onIncludeLowChange: vi.fn(),
    canSeeThreats: true,
    now: NOW,
    ...over,
  };
}

describe("the empty feed says which empty it is", () => {
  it("every source reporting → a quiet site", () => {
    const { container } = render(<SecurityFeed {...props()} />);
    expect(container.querySelector("[data-empty]")?.getAttribute("data-empty")).toBe("quiet");
    expect(screen.getByText(COPY.emptyQuietBody)).toBeInTheDocument();
  });

  it("camera ingest down → NOT a quiet site", () => {
    const { container } = render(<SecurityFeed {...props({ sources: withIngest("down") })} />);
    expect(container.querySelector("[data-empty]")?.getAttribute("data-empty")).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotListening)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyQuietBody)).toBeNull();
  });

  it("a quiet source → the quiet copy is qualified", () => {
    render(<SecurityFeed {...props({ sources: withIngest("quiet") })} />);
    expect(screen.getByText(COPY.emptyPartialBody)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyQuietBody)).toBeNull();
  });

  it("the sources could not be checked → not-reporting, never quiet", () => {
    const { container } = render(<SecurityFeed {...props({ sources: null, healthError: new Error("503") })} />);
    expect(container.querySelector("[data-empty]")?.getAttribute("data-empty")).toBe("not-reporting");
  });

  it("while the sources are still loading, the feed claims nothing", () => {
    const { container } = render(<SecurityFeed {...props({ sources: null })} />);
    expect(container.querySelector("[data-empty]")).toBeNull();
  });

  it("no camera system → says so, and that warnings still land here", () => {
    render(<SecurityFeed {...props({ sources: withIngest("not_configured") })} />);
    expect(screen.getByText(COPY.emptyNoCameras)).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyNoCamerasBody)).toBeInTheDocument();
  });

  it("a feed that failed to load is an alert with a retry, not an empty list", () => {
    const onRetry = vi.fn();
    render(<SecurityFeed {...props({ error: new Error("503"), onRetry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.feedDown);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

// WARP-2977 P2b — an empty view reads the sources that feed THAT view.
function withRow(id: SecurityHealthRow["id"], state: SecurityHealthRow["state"]): SecurityHealthRow[] {
  return OK.map((s) => (s.id === id ? { ...s, state } : s));
}
function without(id: SecurityHealthRow["id"]): SecurityHealthRow[] {
  return OK.filter((s) => s.id !== id);
}
function emptyKind(container: HTMLElement): string | null {
  return container.querySelector("[data-empty]")?.getAttribute("data-empty") ?? null;
}

describe("the empty state keys on the current view's own sources (WARP-2977 P2b)", () => {
  it("sourcesForView: exact rows per view, by who is looking and whether an area is picked", () => {
    const all = { canSeeThreats: true, areaSelected: false };
    const family = { canSeeThreats: false, areaSelected: false };
    expect(sourcesForView("all", all)).toEqual(["camera_ingest", "camera_system", "threat_mirror", "site_mode"]);
    expect(sourcesForView("all", family)).toEqual(["camera_ingest", "camera_system", "site_mode"]);
    // Detections arrive as camera events, and only while the camera system runs.
    expect(sourcesForView("detections", all)).toEqual(["camera_ingest", "camera_system"]);
    expect(sourcesForView("health", all)).toEqual(["camera_ingest", "camera_system"]);
    expect(sourcesForView("network", all)).toEqual(["threat_mirror"]);
    expect(sourcesForView("network", family)).toEqual([]);
    // An area holds camera rows only: threats and mode changes are site-wide.
    expect(sourcesForView("all", { ...all, areaSelected: true })).toEqual(["camera_ingest", "camera_system"]);
    expect(sourcesForView("detections", { ...all, areaSelected: true })).toEqual(["camera_ingest", "camera_system"]);
    expect(sourcesForView("health", { ...all, areaSelected: true })).toEqual(["camera_ingest", "camera_system"]);
  });

  it("the network view: cameras down says nothing about it; its own check down does", () => {
    const quiet = render(<SecurityFeed {...props({ view: "network", sources: withIngest("down") })} />);
    expect(emptyKind(quiet.container)).toBe("quiet");
    quiet.unmount();

    const down = render(<SecurityFeed {...props({ view: "network", sources: withRow("threat_mirror", "down") })} />);
    expect(emptyKind(down.container)).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotCheckingNetwork)).toBeInTheDocument();
  });

  it("a camera view ignores a stopped threat check and opening-hours ticker", () => {
    for (const view of ["detections", "health"] as SecurityView[]) {
      const r = render(
        <SecurityFeed {...props({ view, sources: withRow("threat_mirror", "down").map((s) => (s.id === "site_mode" ? { ...s, state: "down" } : s)) })} />,
      );
      expect(emptyKind(r.container), view).toBe("quiet");
      r.unmount();
    }
  });

  it("the health view reads the camera system too", () => {
    const { container } = render(<SecurityFeed {...props({ view: "health", sources: withRow("camera_system", "down") })} />);
    expect(emptyKind(container)).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotListening)).toBeInTheDocument();
  });

  it("people and vehicles with the camera system stopped is never a quiet view, with or without an area", () => {
    // Camera events can still read 'Listening' (the broker is up) while the
    // camera system itself is down — and then no detection can arrive at all.
    for (const zone of [null, "z1"]) {
      const r = render(
        <SecurityFeed {...props({ view: "detections", zone, sources: withRow("camera_system", "down") })} />,
      );
      expect(emptyKind(r.container), String(zone)).toBe("not-reporting");
      expect(screen.getByText(COPY.emptyNotListening)).toBeInTheDocument();
      r.unmount();
    }
  });

  it("'Everything above is reporting' is said only when the WHOLE header is", () => {
    const all = render(<SecurityFeed {...props({ view: "network" })} />);
    expect(emptyKind(all.container)).toBe("quiet");
    expect(screen.getByText(COPY.emptyQuietBody)).toBeInTheDocument();
    all.unmount();

    // The network view's own check is fine, but the cameras above are not.
    const some = render(<SecurityFeed {...props({ view: "network", sources: withIngest("down") })} />);
    expect(emptyKind(some.container)).toBe("quiet");
    expect(screen.getByText(COPY.emptyQuietViewBody)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyQuietBody)).toBeNull();
    some.unmount();

    const retention = render(<SecurityFeed {...props({ sources: withRow("retention", "quiet") })} />);
    expect(emptyKind(retention.container)).toBe("quiet");
    expect(screen.getByText(COPY.emptyQuietViewBody)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyQuietBody)).toBeNull();
  });

  it("no camera system never promises rows from a source that has stopped", () => {
    const noCams = (rows: SecurityHealthRow[]): SecurityHealthRow[] =>
      rows
        .filter((s) => s.id !== "camera_system")
        .map((s) => (s.id === "camera_ingest" ? { ...s, state: "not_configured" as const } : s));

    const owner = render(<SecurityFeed {...props({ sources: noCams(withRow("threat_mirror", "down")) })} />);
    expect(emptyKind(owner.container)).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotCheckingNetwork)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyNoCamerasBody)).toBeNull();
    owner.unmount();

    const familyRows = noCams(without("threat_mirror")).map((s) =>
      s.id === "site_mode" ? { ...s, state: "down" as const } : s,
    );
    const family = render(<SecurityFeed {...props({ canSeeThreats: false, sources: familyRows })} />);
    expect(emptyKind(family.container)).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotCheckingHours)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyNoCamerasFamilyBody)).toBeNull();
    family.unmount();

    // Every other source reporting: now it is simply "no camera system".
    const fine = render(<SecurityFeed {...props({ sources: noCams(OK) })} />);
    expect(emptyKind(fine.container)).toBe("no-cameras");
    expect(screen.getByText(COPY.emptyNoCamerasBody)).toBeInTheDocument();
  });

  it("everything: a stopped opening-hours check means it can't be called quiet", () => {
    const { container } = render(<SecurityFeed {...props({ sources: withRow("site_mode", "down") })} />);
    expect(emptyKind(container)).toBe("not-reporting");
    expect(screen.getByText(COPY.emptyNotCheckingHours)).toBeInTheDocument();
  });

  it("record keeping feeds no rows, so it never qualifies an empty view", () => {
    const { container } = render(<SecurityFeed {...props({ sources: withRow("retention", "down") })} />);
    expect(emptyKind(container)).toBe("quiet");
  });

  it("a source the view depends on but the header lacks is not vouched for", () => {
    const { container } = render(<SecurityFeed {...props({ sources: without("site_mode") })} />);
    expect(emptyKind(container)).toBe("not-reporting");
  });

  it("family: the threat row the server withholds is not expected", () => {
    const { container } = render(<SecurityFeed {...props({ canSeeThreats: false, sources: without("threat_mirror") })} />);
    expect(emptyKind(container)).toBe("quiet");
  });

  it("an area narrows the view to camera rows: a stopped threat check or ticker doesn't touch it", () => {
    const sources = withRow("threat_mirror", "down").map((s) => (s.id === "site_mode" ? { ...s, state: "down" as const } : s));
    const areas = [{ id: "z1", name: "Front door", linkCount: 1 }];
    const { container } = render(<SecurityFeed {...props({ zone: "z1", areas, sources })} />);
    expect(emptyKind(container)).toBe("quiet");
  });

  // An area nothing covers can never be quiet: no camera watches it, so no health row can vouch for it.
  describe("an area no camera covers", () => {
    const AREAS = [
      { id: "z1", name: "Front door", linkCount: 2 },
      { id: "z-stock", name: "Stock room", linkCount: 0 },
    ];

    it.each(["all", "detections", "health"] as SecurityView[])("%s view: says nothing covers it, never the quiet copy", (view) => {
      const { container } = render(<SecurityFeed {...props({ view, zone: "z-stock", areas: AREAS, onZoneChange: vi.fn() })} />);
      expect(emptyKind(container)).toBe("not-covered");
      expect(container.querySelector("[data-empty] .eh")).toHaveTextContent("No cameras cover Stock room yet");
      expect(container.querySelector("[data-empty]")).not.toHaveTextContent(COPY.emptyQuietBody);
    });

    it("says so before any health problem: the health rows say nothing about it", () => {
      const r = render(<SecurityFeed {...props({ zone: "z-stock", areas: AREAS, sources: null, healthError: new Error("503") })} />);
      expect(emptyKind(r.container)).toBe("not-covered");
      r.unmount();
      const down = render(<SecurityFeed {...props({ zone: "z-stock", areas: AREAS, sources: withIngest("down") })} />);
      expect(emptyKind(down.container)).toBe("not-covered");
    });

    it("someone who manages Security gets the way to fix it; everyone else is told who can", () => {
      const m = render(<SecurityFeed {...props({ zone: "z-stock", areas: AREAS, canManageAreas: true })} />);
      expect(screen.getByText(COPY.emptyNotCoveredManageBody)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: COPY.openAreas })).toHaveAttribute("href", "/security/zones");
      m.unmount();
      render(<SecurityFeed {...props({ zone: "z-stock", areas: AREAS, canManageAreas: false })} />);
      expect(screen.getByText(COPY.emptyNotCoveredBody)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: COPY.openAreas })).toBeNull();
    });

    it("an area with cameras is still quiet when everything reports", () => {
      const { container } = render(<SecurityFeed {...props({ zone: "z1", areas: AREAS })} />);
      expect(emptyKind(container)).toBe("quiet");
    });
  });

  it("the sources couldn't be checked: says exactly that", () => {
    const { container } = render(<SecurityFeed {...props({ sources: null, healthError: new Error("503") })} />);
    expect(container.querySelector("[data-empty] .eh")).toHaveTextContent(COPY.emptyUnchecked);
  });

  it("never promises a family member network warnings they can't see", () => {
    const { container } = render(
      <SecurityFeed {...props({ canSeeThreats: false, sources: without("threat_mirror").map((s) => (s.id === "camera_ingest" ? { ...s, state: "not_configured" as const } : s)) })} />,
    );
    expect(emptyKind(container)).toBe("no-cameras");
    expect(screen.getByText(COPY.emptyNoCamerasFamilyBody)).toBeInTheDocument();
    expect(container.querySelector("[data-empty]")).not.toHaveTextContent(/warning|sign-in|network/i);
  });

  it("no camera system in a camera-only view: that view fills in later — no promise about other rows", () => {
    for (const view of ["detections", "health"] as SecurityView[]) {
      const r = render(<SecurityFeed {...props({ view, sources: withIngest("not_configured") })} />);
      expect(emptyKind(r.container), view).toBe("no-cameras");
      expect(screen.getByText(COPY.emptyNoCamerasViewBody)).toBeInTheDocument();
      r.unmount();
    }
  });

  it("no camera system does not blank the network view", () => {
    const { container } = render(<SecurityFeed {...props({ view: "network", sources: withIngest("not_configured") })} />);
    expect(emptyKind(container)).toBe("quiet");
  });
});

describe("areas (WARP-2977 P2b)", () => {
  const AREAS = [
    { id: "z1", name: "Front door", linkCount: 1 },
    { id: "z2", name: "Stock room", linkCount: 1 },
  ];

  it("no select when the viewer can see no area", () => {
    const { rerender } = render(<SecurityFeed {...props({ areas: [], onZoneChange: vi.fn() })} />);
    expect(screen.queryByRole("combobox", { name: COPY.areaLabel })).toBeNull();
    rerender(<SecurityFeed {...props({ areas: null, onZoneChange: vi.fn() })} />);
    expect(screen.queryByRole("combobox", { name: COPY.areaLabel })).toBeNull();
  });

  it("'All areas' first, then each area; picking one sends its id, 'All areas' sends null", () => {
    const onZoneChange = vi.fn();
    render(<SecurityFeed {...props({ areas: AREAS, zone: null, onZoneChange })} />);
    const select = screen.getByRole("combobox", { name: COPY.areaLabel });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      COPY.allAreas,
      "Front door",
      "Stock room",
    ]);
    fireEvent.change(select, { target: { value: "z2" } });
    expect(onZoneChange).toHaveBeenLastCalledWith("z2");
    fireEvent.change(select, { target: { value: "" } });
    expect(onZoneChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the picked area", () => {
    render(<SecurityFeed {...props({ areas: AREAS, zone: "z1", onZoneChange: vi.fn() })} />);
    expect(screen.getByRole("combobox", { name: COPY.areaLabel })).toHaveValue("z1");
  });

  it("no select in the network view: those rows never sit in an area", () => {
    render(<SecurityFeed {...props({ view: "network", areas: AREAS, onZoneChange: vi.fn() })} />);
    expect(screen.queryByRole("combobox", { name: COPY.areaLabel })).toBeNull();
  });

  it("a row names its areas as muted badges, leading its second line", () => {
    const { container } = render(
      <SecurityFeed
        {...props({
          events: [
            event({
              zones: [
                { id: "z1", name: "Front door" },
                { id: "z3", name: "Car park" },
              ],
            }),
          ],
        })}
      />,
    );
    const sub = container.querySelector('[data-kind="detection"] .sub')!;
    const badges = sub.querySelectorAll(".badge.muted");
    expect([...badges].map((b) => b.textContent)).toEqual(["Front door", "Car park"]);
    expect(sub.firstElementChild).toBe(badges[0]);
    expect(sub).toHaveTextContent("Front doorCar parkfront_door · 86% sure");
  });

  it("a row in no visible area has no area badge", () => {
    const { container } = render(<SecurityFeed {...props({ events: [event()] })} />);
    expect(container.querySelector("[data-area]")).toBeNull();
  });
});

describe("the source header", () => {
  it("lists every source with a plain-language state", () => {
    const { container } = render(<SecurityFeed {...props({ sources: withIngest("down") })} />);
    const ingest = container.querySelector('[data-source="camera_ingest"]')!;
    expect(ingest).toHaveTextContent("Camera events");
    expect(ingest).toHaveTextContent("Not reporting");
    expect(container.querySelector('[data-source="retention"]')).toHaveTextContent("Reporting");
  });

  it("names the opening-hours ticker's row (WARP-2977 P2b)", () => {
    expect(SOURCE_LABEL.site_mode).toBe("Opening hours");
    const { container } = render(<SecurityFeed {...props()} />);
    expect(container.querySelector('[data-source="site_mode"]')).toHaveTextContent("Opening hours");
  });
});

describe("site-mode rows (WARP-2977 P2b)", () => {
  it("every event kind has an icon (a new kind fails the Record below at compile time)", () => {
    const KINDS: Record<SecurityEventKind, true> = {
      detection: true,
      detection_ongoing: true,
      detection_low: true,
      camera_offline: true,
      camera_online: true,
      source_offline: true,
      source_online: true,
      threat: true,
      mode_changed: true,
    };
    for (const kind of Object.keys(KINDS) as SecurityEventKind[]) {
      expect(iconFor(event({ kind })), kind).toBeTruthy();
    }
  });

  it("a mode change shows the mode's glyph", () => {
    expect(iconFor(modeRow("open", "schedule", "Open (opening hours)"))).toBe(Store);
    expect(iconFor(modeRow("closed", "manual", "Closed up by Maria"))).toBe(Moon);
    expect(iconFor(modeRow("away", "manual", "Set to away by Stefan"))).toBe(Plane);
    expect(iconFor(event({ kind: "mode_changed", labels: [] }))).toBe(Shield);
  });

  it("renders as a site-wide row: its summary is the title, with no camera link", () => {
    render(<SecurityFeed {...props({ events: [modeRow("closed", "manual", "Closed up by Maria")] })} />);
    expect(screen.getByText("Closed up by Maria")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("each mode row carries its own glyph and says it is the site mode", () => {
    const { container } = render(
      <SecurityFeed
        {...props({
          events: [
            modeRow("open", "schedule", "Open (opening hours)"),
            modeRow("closed", "schedule", "Closed (opening hours)"),
            modeRow("away", "manual", "Set to away by Stefan"),
          ],
        })}
      />,
    );
    const rows = [...container.querySelectorAll('[data-kind="mode_changed"]')];
    expect(rows.map((r) => r.querySelector(".nm")?.textContent)).toEqual([
      "Open (opening hours)",
      "Closed (opening hours)",
      "Set to away by Stefan",
    ]);
    expect(rows.map((r) => r.querySelector(".ri svg")?.getAttribute("class"))).toEqual([
      expect.stringMatching(/store/),
      expect.stringMatching(/moon/),
      expect.stringMatching(/plane/),
    ]);
    for (const r of rows) expect(r.querySelector(".sub")).toHaveTextContent(COPY.modeRowSub);
  });
});

describe("rows", () => {
  it("a detection shows what, where, how sure, and links to its camera", () => {
    render(<SecurityFeed {...props({ events: [event()] })} />);
    const link = screen.getByRole("link", { name: "Person in porch" });
    expect(link).toHaveAttribute("href", "/cameras/front_door");
    expect(screen.getByText("front_door · 86% sure")).toBeInTheDocument();
  });

  it("cameras are named the way the household named them", () => {
    const label = (n: string) => (n === "front_door" ? "Front door" : n);
    render(
      <SecurityFeed
        {...props({
          cameraLabel: label,
          events: [
            event(),
            event({ id: "2", source: "frigate_status", kind: "camera_offline", severity: "notice", labels: [], score: null, summary: "Camera front_door stopped reporting" }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Front door · 86% sure")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Front door stopped reporting" })).toBeInTheDocument();
  });

  it("a low-confidence detection says so", () => {
    render(<SecurityFeed {...props({ events: [event({ kind: "detection_low", score: 0.41 })] })} />);
    expect(screen.getByText("front_door · 41% sure · low confidence")).toBeInTheDocument();
  });

  it("WARP-2978 PR-D — a person still in view reads \"Still in view\", with a person's glyph and their score so far", () => {
    const { container } = render(
      <SecurityFeed
        {...props({
          events: [
            event({
              id: "o1",
              kind: "detection_ongoing",
              endedAt: null,
              cameraZones: [],
              score: 0.88,
              summary: "Person still in view after 30 s",
            }),
            event({ id: "d1" }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Person still in view after 30 s")).toBeInTheDocument();
    const rows = container.querySelectorAll("li.lrow[data-kind]");
    expect(rows[0]).toHaveAttribute("data-kind", "detection_ongoing");
    expect(rows[0]!.querySelector("[data-ongoing]")).toHaveTextContent("Still in view");
    expect(rows[0]).toHaveTextContent("front_door · 88% sure");
    // Only the ongoing row carries it; the person's finished detection does not.
    expect(rows[1]!.querySelector("[data-ongoing]")).toBeNull();
    expect(iconFor(event({ kind: "detection_ongoing" }))).toBe(iconFor(event({ kind: "detection" })));
  });

  it("a threat has no camera link and names its kind; an alert-severity row is marked", () => {
    render(
      <SecurityFeed
        {...props({
          events: [
            event({
              id: "9",
              source: "activity_mirror",
              kind: "threat",
              severity: "alert",
              camera: null,
              labels: ["auth"],
              score: null,
              summary: "5 failed sign-ins",
            }),
          ],
        })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Sign-in")).toBeInTheDocument();
    expect(screen.getByText("Serious")).toBeInTheDocument();
  });

  it("'Show older' appears only when there is more, and asks for it", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<SecurityFeed {...props({ events: [event()], hasMore: false })} />);
    expect(screen.queryByRole("button", { name: COPY.loadMore })).toBeNull();
    rerender(<SecurityFeed {...props({ events: [event()], hasMore: true, onLoadMore })} />);
    fireEvent.click(screen.getByRole("button", { name: COPY.loadMore }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

describe("filters", () => {
  it("the network and sign-in view is offered only to people who can see it", () => {
    const { rerender } = render(<SecurityFeed {...props({ canSeeThreats: true })} />);
    expect(screen.getByRole("button", { name: "Network and sign-in" })).toBeInTheDocument();
    rerender(<SecurityFeed {...props({ canSeeThreats: false })} />);
    expect(screen.queryByRole("button", { name: "Network and sign-in" })).toBeNull();
  });

  it("the low-confidence toggle only shows where detections can appear", () => {
    const { rerender } = render(<SecurityFeed {...props({ view: "detections" })} />);
    expect(screen.getByRole("button", { name: COPY.includeLow })).toBeInTheDocument();
    rerender(<SecurityFeed {...props({ view: "health" })} />);
    expect(screen.queryByRole("button", { name: COPY.includeLow })).toBeNull();
  });

  it("kindsForView: detections widen to low only when asked", () => {
    expect(kindsForView("all", false)).toBeUndefined();
    // WARP-2978 PR-D — a person still in view is a detection too.
    expect(kindsForView("detections", false)).toEqual(["detection", "detection_ongoing"]);
    expect(kindsForView("detections", true)).toEqual(["detection", "detection_ongoing", "detection_low"]);
    expect(kindsForView("health", true)).toEqual(["camera_offline", "camera_online", "source_offline", "source_online"]);
    expect(kindsForView("network", false)).toEqual(["threat"]);
  });
});

describe("nav — every shell reaches /security, gated on its own module", () => {
  it("is in the sidebar's Operations group, gated on `security`", () => {
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/security");
    expect(item?.requiresModule).toBe("security");
    expect(moduleForPath("/security")?.moduleId).toBe("security");
  });

  it("is a chip in the Workspace shell's Operations space", () => {
    expect(SPACES.find((s) => s.id === "ops")?.hrefs).toContain("/security");
  });
});
