/**
 * WARP-2977 (ADR-059 §3.2) — the /security feed.
 *
 * The rule this file exists for: "nothing happened" and "nothing is
 * reporting" must never look the same. An empty feed names which empty it
 * is, and it says nothing at all until it knows.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { COPY, SecurityFeed, kindsForView, type SecurityFeedProps } from "@/components/security/SecurityFeed";
import { NAV_GROUPS, moduleForPath } from "@/components/nav-config";
import { SPACES } from "@/components/workspace/workspace-nav-config";
import type { SecurityEvent, SecurityHealthRow } from "@/lib/types";

const NOW = new Date("2026-09-23T02:14:00Z");

const OK: SecurityHealthRow[] = [
  { id: "camera_ingest", state: "ok", detail: "Listening", lastSeenAt: NOW.toISOString() },
  { id: "camera_system", state: "ok", detail: "Camera system running", lastSeenAt: NOW.toISOString() },
  { id: "threat_mirror", state: "ok", detail: "Network and sign-in warnings", lastSeenAt: NOW.toISOString() },
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
    ...over,
  };
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
  });

  it("a feed that failed to load is an alert with a retry, not an empty list", () => {
    const onRetry = vi.fn();
    render(<SecurityFeed {...props({ error: new Error("503"), onRetry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.feedDown);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
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
});

describe("rows", () => {
  it("a detection shows what, where, how sure, and links to its camera", () => {
    render(<SecurityFeed {...props({ events: [event()] })} />);
    const link = screen.getByRole("link", { name: "Person in porch" });
    expect(link).toHaveAttribute("href", "/cameras/front_door");
    expect(screen.getByText("front_door · 86% sure")).toBeInTheDocument();
  });

  it("a low-confidence detection says so", () => {
    render(<SecurityFeed {...props({ events: [event({ kind: "detection_low", score: 0.41 })] })} />);
    expect(screen.getByText("front_door · 41% sure · low confidence")).toBeInTheDocument();
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
    expect(kindsForView("detections", false)).toEqual(["detection"]);
    expect(kindsForView("detections", true)).toEqual(["detection", "detection_low"]);
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
