/**
 * WARP-2981 (ADR-059 P6, §3.8) — /security/wall, end to end in the browser
 * half: the real page, the real hook, the real `@/lib/api` fetchers, with only
 * `authFetch` answering (T-D7). So what is pinned is what the TV actually asks
 * for and what it then says:
 *
 *   · the strip: the mode badge and reason (never a person's name), the
 *     needs-attention number with its alerts, the sources not reporting;
 *   · never a number before it was given one (no "0" while loading);
 *   · "nothing is reporting" never reads like "nothing happened";
 *   · stale after 45 s, offline when the browser says so (a warning mark, the
 *     day when it is not today), the sign-out warning in the sign-in's last
 *     half hour — and a remount over a warm cache keeps the values' own time;
 *   · the way out is always visible; Full screen only where the browser
 *     offers it;
 *   · every request is a GET to one of the six reads it is allowed (§4) —
 *     and no dashboard source can even name the rack panel's route (T-D13);
 *   · wall.css: tokens only, the strip on screen above 640 px, readable muted
 *     badges, and nothing 375 px wide scrolls sideways.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PACKAGE_ROOT, packagePath } from "../helpers/test-paths";

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));

import SecurityWallPage from "@/app/security/wall/page";
import { SecurityWall } from "@/components/security/SecurityWall";
import { WALL_COPY } from "@/components/security/wall-status";
import { COPY as MODE_COPY } from "@/components/security/ModeCard";
import { COPY as FEED_COPY } from "@/components/security/SecurityFeed";
import type { SecurityHealthRow, SecurityModeView } from "@/lib/types";

// ── the box, as the wall's six reads see it ────────────────────────────────

const MODULES_ON = { modules: [{ id: "security", effective: true }, { id: "cameras", effective: true }] };
const MODE: SecurityModeView = {
  mode: "closed",
  source: "manual",
  manualEnd: "none",
  until: null,
  setBy: { id: "u9", name: "Stefan Warp" },
  setAt: "2026-09-25T20:00:00.000Z",
  hours: { state: "not_set" },
  displayTimezone: "Europe/London",
  stale: false,
  version: 3,
};
const row = (id: SecurityHealthRow["id"], state: SecurityHealthRow["state"]): SecurityHealthRow => ({ id, state, detail: "x", lastSeenAt: null });

interface Box {
  modules: unknown;
  counts: unknown;
  sources: SecurityHealthRow[];
  mode: SecurityModeView;
  me: unknown;
  birdseye: number;
  /** Paths that answer 503 instead. */
  down?: string[];
}

let box: Box;
const ALLOWED = [
  "/api/modules",
  "/api/security/incidents/summary",
  "/api/security/health",
  "/api/security/mode",
  "/api/auth/me",
  "/api/cameras/birdseye/live",
];

function respond(url: string): unknown {
  const path = url.split("?")[0]!;
  if (box.down?.includes(path)) return { status: 503, body: { error: { code: "INCIDENTS_UNAVAILABLE", message: "x" } } };
  switch (path) {
    case "/api/modules":
      return { status: 200, body: box.modules };
    case "/api/security/incidents/summary":
      return { status: 200, body: box.counts };
    case "/api/security/health":
      return { status: 200, body: { sources: box.sources } };
    case "/api/security/mode":
      return { status: 200, body: box.mode };
    case "/api/auth/me":
      return { status: 200, body: box.me };
    case "/api/cameras/birdseye/live":
      return { status: box.birdseye, body: {} };
    default:
      return { status: 404, body: {} };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  box = {
    modules: MODULES_ON,
    counts: { openAlerts: 1, openNotices: 1, latest: [{ id: "i1", zone: { name: "Stock room" } }], alertsReady: true },
    sources: [row("camera_ingest", "ok"), row("camera_system", "down"), row("threat_mirror", "ok"), row("site_mode", "ok"), row("incidents", "ok")],
    mode: MODE,
    me: { id: "u1", username: "stefan", session: null },
    birdseye: 200,
  };
  h.authFetch.mockImplementation(async (url: string) => {
    const r = respond(url) as { status: number; body: unknown };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, headers: new Headers() };
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const strip = () => screen.getByRole("region", { name: WALL_COPY.stripLabel });
const cell = (name: string) => strip().querySelector(`[data-cell="${name}"]`) as HTMLElement;

describe("/security/wall — what the strip says (T-D7)", () => {
  it("the mode, what needs attention, and which source is not reporting", async () => {
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("attention")).getByText("2")).toBeInTheDocument());
    expect(within(cell("attention")).getByText("1 alert")).toBeInTheDocument();
    expect(within(cell("mode")).getByText(MODE_COPY.badgeClosed)).toBeInTheDocument();
    expect(within(cell("sources")).getByText("1 not reporting")).toBeInTheDocument();
    expect(within(cell("sources")).getByText("Camera system")).toBeInTheDocument();
    // At the wall's badge size, not the shell's 11 px: the state is the point of the list.
    expect(within(cell("sources")).getByText("Not reporting")).toHaveClass("badge", "danger", "sec-wall-badge");
    // Route 17's `latest` never reaches the screen: the wall names no incident or area.
    expect(document.body.textContent).not.toContain("Stock room");
  });

  it("a mode set by a named person names nobody", async () => {
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("mode")).getByText(MODE_COPY.badgeClosed)).toBeInTheDocument());
    expect(cell("mode").textContent).toContain("Closed up");
    expect(document.body.textContent).not.toMatch(/Stefan/);
  });

  it.each([
    ["lagging", true],
    ["keeping up", false],
  ])("the opening-hours ticker %s: the mode cell says whether the mode may be out of date", async (_why, stale) => {
    box.mode = { ...MODE, stale };
    box.sources = [...box.sources.filter((r) => r.id !== "site_mode"), { ...row("site_mode", stale ? "down" : "ok"), lastSeenAt: "2026-09-25T19:00:00.000Z" }];
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("sources")).getByText("1 not reporting")).toBeInTheDocument());
    const line = /Droplet hasn't checked the opening hours since .+, so the mode may be out of date\./;
    if (stale) expect(cell("mode").textContent).toMatch(line);
    else expect(cell("mode").textContent).not.toMatch(/out of date/);
  });

  it("no camera system: says so — not 'isn't available here' — and never asks for the composite", async () => {
    // No camera system means no FRIGATE_URL, so the Cameras module is not effective either.
    box.modules = { modules: [{ id: "security", effective: true }, { id: "cameras", effective: false }] };
    box.sources = [row("camera_ingest", "not_configured"), row("threat_mirror", "ok"), row("incidents", "ok")];
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByText(FEED_COPY.emptyNoCameras)).toBeInTheDocument());
    expect(screen.queryByText(WALL_COPY.camerasUnavailable)).toBeNull();
    expect((h.authFetch.mock.calls as Array<[string]>).some(([url]) => url.startsWith("/api/cameras/"))).toBe(false);
  });

  it("before any answer: no number at all — dashes, 'Waiting for Droplet…', and no 0", async () => {
    h.authFetch.mockImplementation(() => new Promise(() => {}));
    render(<SecurityWallPage />, { wrapper: Wrap });
    await new Promise((r) => setTimeout(r, 30));
    expect(strip().textContent).not.toMatch(/\d/);
    expect(within(cell("attention")).getByText(WALL_COPY.unknownValue)).toBeInTheDocument();
    expect(within(cell("updated")).getByText(WALL_COPY.waiting)).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.camerasConnecting)).toBeInTheDocument();
  });

  it("every source down and nothing open: never reads as a quiet site", async () => {
    box.counts = { openAlerts: 0, openNotices: 0 };
    box.sources = [row("camera_ingest", "down"), row("camera_system", "down"), row("threat_mirror", "down"), row("incidents", "down")];
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("attention")).getByText("0")).toBeInTheDocument());
    const text = strip().textContent ?? "";
    expect(text).not.toMatch(/all clear/i);
    expect(text).not.toContain(WALL_COPY.sourcesAllReporting);
    expect(text).toContain("3 not reporting");
    expect(text).toMatch(/may be behind/);
  });

  it("the camera composite plays for a viewer it is allowed to", async () => {
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByAltText(WALL_COPY.camerasAlt)).toBeInTheDocument());
    expect(screen.getByAltText(WALL_COPY.camerasAlt).getAttribute("src")).toBe("/api/cameras/birdseye/live?w=0");
  });
});

describe("/security/wall — freshness and the sign-out warning (T-D7)", () => {
  async function settled(now?: number) {
    const view = render(<SecurityWall now={now} />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("attention")).getByText("2")).toBeInTheDocument());
    return view;
  }

  it("more than 45 s since the stalest answer: the banner with its time, the values kept and dimmed", async () => {
    const t0 = Date.now();
    const { rerender } = await settled(t0);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<SecurityWall now={t0 + 46_000} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(WALL_COPY.staleTitle);
    expect(banner.textContent).toMatch(/What you see is from \d{1,2}:\d{2}/);
    expect(within(cell("attention")).getByText("2")).toBeInTheDocument();
    expect(strip().className).toContain("is-stale");
    // The warning mark /security's ModeCard uses — not the neutral look of the sign-out notice.
    expect(banner.querySelector(".badge.warn svg")).not.toBeNull();
  });

  it("an outage across midnight: the banner and 'Updated' name the day, not only the time", async () => {
    const t0 = Date.now();
    const { rerender } = await settled(t0);
    rerender(<SecurityWall now={t0 + 30 * 3_600_000} />);
    const day = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}/;
    expect(screen.getByRole("status").textContent).toMatch(new RegExp(`What you see is from ${day.source}`));
    expect(cell("updated").textContent).toMatch(day);
  });

  it("remounted over a warm cache while Droplet is down: the old values keep THEIR time — never 'Waiting', never 'haven't loaded'", async () => {
    const cache = new Map();
    const Warm = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const t0 = Date.now();
    const first = render(<SecurityWall now={t0} />, { wrapper: Warm });
    await waitFor(() => expect(within(cell("attention")).getByText("2")).toBeInTheDocument());
    first.unmount();
    box.down = ["/api/modules", "/api/security/incidents/summary", "/api/security/health", "/api/security/mode"];
    render(<SecurityWall now={t0 + 3_600_000} />, { wrapper: Warm });
    expect(within(cell("attention")).getByText("2")).toBeInTheDocument();
    expect(cell("updated").textContent).not.toContain(WALL_COPY.waiting);
    expect(cell("updated").textContent).toMatch(/\d{1,2}:\d{2}/);
    // The remount asks again, and every one of those reads fails.
    const asked = (path: string) => (h.authFetch.mock.calls as Array<[string]>).filter(([url]) => url === path).length;
    await waitFor(() => expect(asked("/api/security/mode")).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/What you see is from .*\d{1,2}:\d{2}/);
    expect(banner.textContent).not.toContain(WALL_COPY.staleNeverBody);
  });

  it("offline: says so, whatever the age", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    await settled();
    expect(screen.getByRole("status")).toHaveTextContent(WALL_COPY.offlineTitle);
  });

  it("a read that fails before it ever answers: the banner says parts haven't loaded — never 'Waiting' for ever", async () => {
    box.down = ["/api/security/mode"];
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(WALL_COPY.staleNeverBody));
    expect(within(cell("mode")).getByText(WALL_COPY.modeUnknown)).toBeInTheDocument();
  });

  it.each([
    ["29 minutes out: warned", 29 * 60_000, true],
    ["31 minutes out: not yet", 31 * 60_000, false],
  ])("a sign-in ending %s", async (_why, ms, shown) => {
    const t0 = Date.now();
    box.me = { id: "u1", session: { endsAt: new Date(t0 + ms).toISOString() } };
    render(<SecurityWall now={t0} />, { wrapper: Wrap });
    await waitFor(() => expect(within(cell("attention")).getByText("2")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 20));
    const warning = screen.queryByText(/will be signed out by .* at the latest/);
    expect(Boolean(warning)).toBe(shown);
  });

  it("the sign-out notice is neutral: no warning mark", async () => {
    const t0 = Date.now();
    box.me = { id: "u1", session: { endsAt: new Date(t0 + 10 * 60_000).toISOString() } };
    render(<SecurityWall now={t0} />, { wrapper: Wrap });
    const notice = await screen.findByText(/will be signed out by .* at the latest/);
    expect(notice.closest("[data-banner]")).toHaveAttribute("data-banner", "sign-out");
    expect(notice.closest("[data-banner]")!.querySelector(".badge")).toBeNull();
  });

  it("no session on /auth/me (an older orchestrator) → no warning", async () => {
    box.me = { id: "u1" };
    await settled();
    expect(screen.queryByText(/signed out/)).toBeNull();
  });
});

describe("/security/wall — the way out, and Full screen", () => {
  afterEach(() => {
    for (const k of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) delete (document as unknown as Record<string, unknown>)[k];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  });

  it("'Back to Security' is always there — a visible control, first in the tab order, to /security", async () => {
    render(<SecurityWallPage />, { wrapper: Wrap });
    const leave = await screen.findByRole("link", { name: WALL_COPY.leave });
    expect(leave).toHaveAttribute("href", "/security");
    expect(leave).toHaveClass("btn", "sm");
    expect(leave.className).not.toMatch(/sr-only/);
    await waitFor(() => expect(within(cell("attention")).getByText("2")).toBeInTheDocument());
    const main = document.querySelector("main#main")!;
    expect(main.querySelector("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")).toBe(leave);
  });

  it("no Full screen button where the browser doesn't offer it (an iPhone)", async () => {
    render(<SecurityWallPage />, { wrapper: Wrap });
    await screen.findByRole("link", { name: WALL_COPY.leave });
    expect(screen.queryByRole("button", { name: WALL_COPY.fullScreen })).toBeNull();
  });

  it("where it is offered: Full screen asks for the wall itself, and the label follows the browser", async () => {
    let current: Element | null = null;
    const request = vi.fn(function (this: Element) {
      return Promise.resolve();
    });
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    render(<SecurityWallPage />, { wrapper: Wrap });
    const full = await screen.findByRole("button", { name: WALL_COPY.fullScreen });
    // The way out still comes first in the tab order, before Full screen.
    const controls = [...document.querySelectorAll("main#main a[href], main#main button")];
    expect(controls).toEqual([screen.getByRole("link", { name: WALL_COPY.leave }), full]);
    fireEvent.click(full);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(document.querySelector("main#main"));
    current = document.querySelector("main#main");
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    fireEvent.click(screen.getByRole("button", { name: WALL_COPY.exitFullScreen }));
    expect(exit).toHaveBeenCalledTimes(1);
    current = null;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.getByRole("button", { name: WALL_COPY.fullScreen })).toBeInTheDocument();
  });
});

describe("/security/wall — what it asks (T-D7)", () => {
  it("every request is a GET to one of the six reads it is allowed", async () => {
    box.me = { id: "u1", session: { endsAt: new Date(Date.now() + 60_000).toISOString() } };
    render(<SecurityWallPage />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByAltText(WALL_COPY.camerasAlt)).toBeInTheDocument());
    const calls = h.authFetch.mock.calls as Array<[string, RequestInit | undefined]>;
    const paths = new Set(calls.map(([url]) => url.split("?")[0]));
    expect([...paths].sort()).toEqual([...ALLOWED].sort());
    for (const [url, init] of calls) expect(init?.method ?? "GET", url).toBe("GET");
  });
});

// ── T-D13: the rack's box-wide number never reaches a browser ─────────────

/** Built from parts, so this file does not match itself. */
const PANEL_ROUTE = ["/api", "panel", ""].join("/");

function sourcesUnder(rel: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(PACKAGE_ROOT, full).split(sep).join("/"));
    }
  };
  visit(packagePath(rel));
  return out;
}

describe("DS-005 source pin (T-D13)", () => {
  it(`no dashboard source names the rack panel's route (${PANEL_ROUTE}…)`, () => {
    const files = sourcesUnder("src");
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter((f) => readFileSync(packagePath(f), "utf8").includes(PANEL_ROUTE))).toEqual([]);
  });
});

// ── T-D12 (half): the stylesheet ───────────────────────────────────────────

describe("wall.css — tokens only, and a phone never scrolls sideways", () => {
  const css = readFileSync(packagePath("src/components/security/wall.css"), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("above 640 px the page is exactly the viewport's height, so the strip is never pushed below the fold", () => {
    expect(code).toMatch(/@media \(min-width: 641px\) \{\s*\.droplet-shell\.sec-wall \{ height: 100dvh; \}\s*\}/);
    expect(code).toMatch(/\.droplet-shell\.sec-wall \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto auto;/);
  });

  it("≤ 640 px: the rows stack from the top — no empty bands between them", () => {
    expect(code).toMatch(/@media \(max-width: 640px\) \{[^@]*\.droplet-shell\.sec-wall \{[^}]*align-content: start;/);
  });

  it("a muted badge on the strip is readable (4.41:1 → --text), and a stale strip's badges lose their colour", () => {
    expect(code).toMatch(/\.droplet-shell \.sec-wall-strip \.badge\.muted \{ color: var\(--text\); \}/);
    expect(code).toMatch(/\.droplet-shell \.sec-wall-strip\.is-stale \.badge \{ filter: grayscale\(1\); \}/);
  });

  it("the way out is never visually hidden", () => {
    expect(code).not.toMatch(/\.sec-wall-leave[^{,]*\{[^}]*(clip|width: 1px|position: absolute)/);
  });

  it("≤ 640 px: the composite goes 16:9 and the cells wrap at 150 px", () => {
    expect(code).toMatch(/@media \(max-width: 640px\) \{[^@]*\.sec-wall-cameras \{[^}]*aspect-ratio: 16 \/ 9;/);
    expect(code).toMatch(/@media \(max-width: 640px\) \{[^@]*\.sec-wall-strip > dl \{[^}]*repeat\(auto-fit, minmax\(150px, 1fr\)\)/);
  });

  it("nothing is fixed wider than a 375 px phone's content box", () => {
    for (const m of code.matchAll(/(?:^|[;{\s])(?:min-)?width:\s*(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(343);
  });

  it("no hard-coded colours: every colour is a token", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
  });

  it("a visible focus ring on what a keyboard can reach", () => {
    expect(code).toMatch(/\.sec-wall-leave:focus-visible,\s*\.droplet-shell \.sec-wall-full:focus-visible \{ outline: 2px solid var\(--brand\)/);
  });
});
