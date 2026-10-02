/**
 * WARP-2250 — the "Your morning briefing" tile (a0): one test per state row of
 * the matrix, the ranked-actions contract, provenance, Write/Rewrite + 429.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const fetchTodayBriefingMock = vi.fn();
const requestBriefingRewriteMock = vi.fn();

vi.mock("@/lib/api", () => ({ fetchAdminFilesUsage: vi.fn() }));
vi.mock("@/app/reports/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchTodayBriefing: (...a: unknown[]) => fetchTodayBriefingMock(...a),
  requestBriefingRewrite: (...a: unknown[]) => requestBriefingRewriteMock(...a),
}));

import { BriefingBody } from "@/app/reports/tiles";
import { BriefingRateLimited, ForbiddenError, type Briefing } from "@/app/reports/api";

const NOW = new Date("2026-09-22T08:00:00.000Z");

const action = (rank: number, over: Record<string, unknown> = {}) => ({
  rank,
  title: `Action ${rank}`,
  why: `Why ${rank}`,
  suggestion: `Do thing ${rank}`,
  sourceTools: ["email_inbox_overview"],
  ...over,
});

const brief = (over: Partial<Briefing> = {}): Briefing => ({
  id: "b1",
  forDate: "2026-09-22",
  status: "ready",
  skipReason: null,
  failureReason: null,
  headline: "Two invoices need you before noon",
  vibe: "busy",
  body: {
    summary: "First paragraph.\n\nSecond paragraph.",
    actions: [action(2), action(1)],
  },
  sources: ["email_inbox_overview", "erp_list_open_invoices"],
  model: "gpt-oss:20b",
  iterations: 5,
  artKind: "ascii",
  photoStatus: "none",
  photoRef: null,
  triggeredBy: "scheduler",
  startedAt: "2026-09-22T12:00:00.000Z",
  endedAt: "2026-09-22T12:03:00.000Z",
  readAt: null,
  ...over,
});

beforeEach(() => {
  fetchTodayBriefingMock.mockReset();
  requestBriefingRewriteMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("BriefingBody — states", () => {
  it("locked: a role below the floor sees LockedBody and nothing is fetched", () => {
    render(<BriefingBody canRead={false} now={NOW} />);
    expect(screen.getByText(/role doesn't include this/)).toBeTruthy();
    expect(fetchTodayBriefingMock).not.toHaveBeenCalled();
  });

  it("locked: a 403 renders LockedBody, never the content", async () => {
    fetchTodayBriefingMock.mockRejectedValue(new ForbiddenError());
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText(/role doesn't include this/);
  });

  it("loading: skeleton until the first fetch settles", () => {
    fetchTodayBriefingMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<BriefingBody canRead now={NOW} />);
    expect(container.querySelector(".rp-skel")).toBeTruthy();
  });

  it("error: a failed read offers retry and shows the reason", async () => {
    fetchTodayBriefingMock.mockRejectedValueOnce(new Error("boom 500"));
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Couldn't load your briefing");
    expect(screen.getByText("boom 500")).toBeTruthy();
    fetchTodayBriefingMock.mockResolvedValueOnce(brief());
    fireEvent.click(screen.getByText("Try again"));
    await screen.findByText("Two invoices need you before noon");
  });

  it("empty: 404 → 'No briefing yet today' with Write my briefing", async () => {
    fetchTodayBriefingMock.mockResolvedValue(null);
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("No briefing yet today");
    expect(screen.getByRole("button", { name: "Write my briefing" })).toBeTruthy();
  });

  it("running: Writing… with aria-busy, and polls every 5 s until it settles", async () => {
    fetchTodayBriefingMock
      .mockResolvedValueOnce(brief({ status: "running" }))
      .mockResolvedValueOnce(brief());
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Writing…");
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(fetchTodayBriefingMock).toHaveBeenCalledTimes(1);
    await screen.findByText("Two invoices need you before noon", undefined, { timeout: 7000 });
    expect(fetchTodayBriefingMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("pending: shows the queued label, not a finished briefing", async () => {
    fetchTodayBriefingMock.mockReturnValueOnce(Promise.resolve(brief({ status: "pending" })));
    fetchTodayBriefingMock.mockReturnValue(new Promise(() => {}));
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText(/Queued/);
    expect(screen.queryByText("First paragraph.")).toBeNull();
  });

  it("failed: reason verbatim + Try again, never a partial paragraph", async () => {
    fetchTodayBriefingMock.mockResolvedValue(
      brief({ status: "failed", failureReason: "invalid_output: actions[0].rank" }),
    );
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Couldn't write your briefing");
    expect(screen.getByText("invalid_output: actions[0].rank")).toBeTruthy();
    expect(screen.queryByText("First paragraph.")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("skipped: humanised reason + Write my briefing", async () => {
    fetchTodayBriefingMock.mockResolvedValue(brief({ status: "skipped", skipReason: "user_deactivated" }));
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Skipped this morning — user deactivated");
    expect(screen.getByRole("button", { name: "Write my briefing" })).toBeTruthy();
  });
});

describe("BriefingBody — ready", () => {
  it("renders headline and splits the summary on blank lines", async () => {
    fetchTodayBriefingMock.mockResolvedValue(brief());
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Two invoices need you before noon");
    expect(screen.getByText("First paragraph.").tagName).toBe("P");
    expect(screen.getByText("Second paragraph.").tagName).toBe("P");
  });

  it("renders at most five actions, in rank order, each with its suggestion", async () => {
    const six = [6, 3, 1, 5, 2, 4].map((r) => action(r));
    fetchTodayBriefingMock.mockResolvedValue(brief({ body: { summary: "x", actions: six } }));
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Action 1");
    const items = Array.from(container.querySelectorAll(".rp-brief-actions li"));
    expect(items).toHaveLength(5);
    expect(items.map((li) => li.querySelector(".rp-brief-title")!.textContent)).toEqual([
      "Action 1",
      "Action 2",
      "Action 3",
      "Action 4",
      "Action 5",
    ]);
    for (const li of items) expect(li.textContent).toMatch(/Suggested: Do thing \d/);
    expect(screen.queryByText(/not shown/)).toBeNull();
  });

  it("renders an action href only when it is an internal route", async () => {
    fetchTodayBriefingMock.mockResolvedValue(
      brief({
        body: {
          summary: "x",
          actions: [
            action(1, { href: "/email" }),
            action(2, { href: "https://evil.example" }),
            action(3, { href: "//evil.example" }),
          ],
        },
      }),
    );
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Action 1");
    const links = Array.from(container.querySelectorAll(".rp-brief-actions a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/email"]);
  });

  it("no actions → the suggestions variant with its label", async () => {
    fetchTodayBriefingMock.mockResolvedValue(
      brief({
        body: {
          summary: "Quiet day.",
          actions: [],
          suggestions: [{ title: "Archive old invoices" }, { title: "Set a camera schedule" }, { title: "Tidy shares" }],
        },
      }),
    );
    render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("No actions today — a few ideas for your workflow");
    expect(screen.getByText("Set a camera schedule")).toBeTruthy();
  });

  it("provenance: real source count, chips from sources with +N overflow", async () => {
    const sources = ["a", "b", "c", "d", "e", "f", "g"];
    fetchTodayBriefingMock.mockResolvedValue(brief({ sources }));
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Two invoices need you before noon");
    expect(container.querySelector(".rp-report-stamp")!.textContent).toMatch(/from 7 tool results/);
    const chips = Array.from(container.querySelectorAll(".rp-report-chips .rp-src-chip")).map((c) => c.textContent);
    expect(chips).toEqual(["a", "b", "c", "d", "e", "+2"]);
  });

  it("renders no timestamp while now === null (SSR)", async () => {
    // now === null also means no fetch yet — the tile waits for the client clock.
    render(<BriefingBody canRead now={null} />);
    expect(fetchTodayBriefingMock).not.toHaveBeenCalled();
    expect(document.querySelector("time, .rp-report-stamp .rp-mono + .rp-mono")).toBeNull();
  });

  it("photo art: same-origin img, aria-hidden, credit line; hides on error", async () => {
    fetchTodayBriefingMock.mockResolvedValue(
      brief({
        artKind: "photo",
        body: {
          summary: "x",
          actions: [action(1)],
          photoCredit: { photographer: "Ana", photographerUrl: "javascript:alert(1)" },
        },
      }),
    );
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("Action 1");
    const img = container.querySelector(".rp-brief-photo img")!;
    expect(img.getAttribute("src")).toBe("/api/briefings/b1/photo");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("alt")).toBe("");
    expect(container.querySelector(".rp-brief-credit")!.textContent).toBe("Photo by Ana on Pexels");
    // A non-https credit URL is never rendered as a link.
    expect(container.querySelector(".rp-brief-credit a")).toBeNull();
    fireEvent.error(img);
    expect(container.querySelector(".rp-brief-photo")).toBeNull();
  });

  it("no credit line unless artKind is photo", async () => {
    fetchTodayBriefingMock.mockResolvedValue(
      brief({ body: { summary: "x", photoCredit: { photographer: "Ana", photographerUrl: "https://x" } } }),
    );
    const { container } = render(<BriefingBody canRead now={NOW} />);
    await screen.findByText("x");
    expect(container.querySelector(".rp-brief-credit")).toBeNull();
  });
});

describe("BriefingBody — Write / Rewrite", () => {
  it("Write my briefing posts, then polls into the queued state", async () => {
    fetchTodayBriefingMock.mockResolvedValueOnce(null).mockResolvedValue(brief({ status: "pending" }));
    requestBriefingRewriteMock.mockResolvedValue({ briefingId: "b1", status: "pending" });
    render(<BriefingBody canRead now={NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Write my briefing" }));
    await screen.findByText(/Queued/);
    expect(requestBriefingRewriteMock).toHaveBeenCalledTimes(1);
  });

  it("Rewrite switches a ready briefing to in-flight immediately", async () => {
    fetchTodayBriefingMock.mockResolvedValueOnce(brief()).mockReturnValue(new Promise(() => {}));
    requestBriefingRewriteMock.mockResolvedValue({ briefingId: "b1", status: "pending" });
    render(<BriefingBody canRead now={NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rewrite" }));
    await screen.findByText(/Queued/);
  });

  it("429 too soon renders the inline minutes copy without throwing", async () => {
    fetchTodayBriefingMock.mockResolvedValue(brief());
    requestBriefingRewriteMock.mockRejectedValue(new BriefingRateLimited("briefing_run_too_soon", 250));
    render(<BriefingBody canRead now={NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rewrite" }));
    await screen.findByText("You can rewrite again in 5 min");
    expect(screen.getByText("Two invoices need you before noon")).toBeTruthy();
  });

  it("429 in progress renders the check-back copy", async () => {
    fetchTodayBriefingMock.mockResolvedValue(brief());
    requestBriefingRewriteMock.mockRejectedValue(new BriefingRateLimited("briefing_run_in_progress", null));
    render(<BriefingBody canRead now={NOW} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rewrite" }));
    await screen.findByText("Already writing — check back in a moment");
  });
});

describe("BriefingBody — reduced motion", () => {
  it("the stylesheet stops the writing pulse under prefers-reduced-motion", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../app/reports/reports.css"), "utf8");
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.rp-report\.is-writing \{ animation: none; \}/);
  });
});

