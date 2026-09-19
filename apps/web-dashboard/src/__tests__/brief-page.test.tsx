/**
 * WARP-2838 — `/brief` composed: the page, the switch panel and the real
 * `api.ts` reads, driven through one mocked `authFetch`.
 *
 * These are the two interactions review found and no existing suite covered.
 * `brief.test.ts` unit-tests the `brainIsOff` predicate and `brief-switch`
 * renders the panel in isolation; neither could see either bug, because both
 * only appear when the page's fetches and its branches are wired together.
 *
 * 1. FINDINGS SURVIVE THE SWITCH BEING TURNED OFF. `GET /api/brain/findings`
 *    is role-gated, not brain-gated — `listFindings` filters by scope, status
 *    and kind and never asks whether the brain is enabled — so an owner who
 *    accumulates findings and then turns the brain off still has them. The
 *    consent copy on this very page promises exactly that ("What it has
 *    already written stays until you delete it"). A page that hides them makes
 *    the box look like it silently discarded data it promised to keep.
 *
 * 2. "THE BOX DID NOT ANSWER" IS NOT "THE BRAIN IS OFF". A transient 500, an
 *    expired session or a momentarily unreachable orchestrator used to collapse
 *    to `coverage = null`, which read as off AND as not-togglable — the exact
 *    pair that renders "This box is pinned off by its operator (BRAIN_ENABLED)
 *    — ask whoever administers it". A confident, specific, wrong diagnosis,
 *    sending an owner to a sysadmin over an env var nobody set. It can fire
 *    right after a SUCCESSFUL toggle, because `onChanged` refetches.
 *
 * The real `api.ts` is used deliberately (only `@/lib/auth` is mocked), so the
 * fetch layer's own degradation is under test rather than stubbed past.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children?: React.ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(),
}));
vi.mock("@/lib/auth", () => ({ authFetch: authFetchMock }));

import BriefPage from "@/app/brief/page";
import type { Coverage, Finding } from "@/app/brief/api";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    kind: "loss",
    title: "Three invoices are 90 days overdue",
    rationale: "Because the ledger says so.",
    impactMinor: "4000000",
    currency: "USD",
    confidence: 0.8,
    status: "new",
    detectorKey: "money.overdue",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastConfirmedAt: "2026-09-07T00:00:00.000Z",
    evidence: {},
    ...over,
  };
}

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    passes: [],
    corpus: { documentsReady: 4000, documentsDigested: 0 },
    ...over,
  };
}

/** A `Response`-shaped stand-in — only the three members `api.ts` reads. */
function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function fail(status: number) {
  return { ok: false, status, json: async () => ({ error: "nope" }) };
}

/**
 * Route by URL rather than by call order: the page fires both reads in one
 * `Promise.all`, so an order-keyed mock pins an implementation detail and
 * silently mis-answers the moment somebody reorders the array.
 */
function serve(routes: { findings?: unknown; coverage?: unknown }) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/brain/findings")) return routes.findings ?? ok({ findings: [], total: 0 });
    if (url.startsWith("/api/brain/coverage")) return routes.coverage ?? ok(coverage());
    throw new Error(`unexpected url ${url}`);
  });
}

beforeEach(() => {
  authFetchMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("/brief — findings outlive the switch (WARP-2838 review item 1)", () => {
  it("still shows findings written before the brain was turned off", async () => {
    serve({
      findings: ok({ findings: [finding()], total: 1 }),
      coverage: ok(coverage({ enabled: false, canToggle: true })),
    });
    render(<BriefPage />);

    // The consent copy one element up promises these stay. They are on the
    // wire — /findings is not gated on brain state — so hiding them would make
    // the box look like it deleted them.
    expect(await screen.findByText(/three invoices are 90 days overdue/i)).toBeInTheDocument();
  });

  it("says the findings are kept rather than being produced, so the list is not read as live", async () => {
    serve({
      findings: ok({ findings: [finding()], total: 1 }),
      coverage: ok(coverage({ enabled: false, canToggle: true })),
    });
    render(<BriefPage />);

    expect(await screen.findByText(/nothing new is being produced/i)).toBeInTheDocument();
  });

  it("renders no such note when the brain is on — the list IS live", async () => {
    serve({
      findings: ok({ findings: [finding()], total: 1 }),
      coverage: ok(coverage({ enabled: true, canToggle: true })),
    });
    render(<BriefPage />);

    expect(await screen.findByText(/three invoices are 90 days overdue/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing new is being produced/i)).not.toBeInTheDocument();
  });

  it("says nothing extra when the brain is off and there is nothing to keep", async () => {
    // The panel above IS the state of the page here. A second line repeating
    // "turn the brain on" is the dead-end copy WARP-2838 exists to remove.
    serve({
      findings: ok({ findings: [], total: 0 }),
      coverage: ok(coverage({ enabled: false, canToggle: true })),
    });
    render(<BriefPage />);

    expect(await screen.findByRole("button", { name: /turn the brain on/i })).toBeInTheDocument();
    expect(screen.queryByText(/nothing needs your attention/i)).not.toBeInTheDocument();
  });
});

describe("/brief — a box that did not answer is not a pinned box (WARP-2838 review item 2)", () => {
  it("does not accuse the operator of a pin when /coverage 500s", async () => {
    serve({ findings: ok({ findings: [], total: 0 }), coverage: fail(500) });
    render(<BriefPage />);

    await screen.findByText(/could not check whether the brain is on/i);
    // 🔴 The false diagnosis. Nothing was pinned; the box just did not answer.
    expect(screen.queryByText(/pinned off by its operator/i)).not.toBeInTheDocument();
    expect(screen.queryByText("BRAIN_ENABLED")).not.toBeInTheDocument();
  });

  it("does not claim the brain is off when /coverage 500s", async () => {
    serve({ findings: ok({ findings: [], total: 0 }), coverage: fail(500) });
    render(<BriefPage />);

    await screen.findByText(/could not check whether the brain is on/i);
    expect(screen.queryByText(/the brain is off\./i)).not.toBeInTheDocument();
  });

  it("does not offer the consent screen to somebody whose brain may well be on", async () => {
    serve({ findings: ok({ findings: [], total: 0 }), coverage: fail(401) });
    render(<BriefPage />);

    await screen.findByText(/could not check whether the brain is on/i);
    expect(screen.queryByRole("button", { name: /turn the brain on/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/sent to that provider/i)).not.toBeInTheDocument();
  });

  it("survives a fetch that throws rather than resolving non-ok", async () => {
    // `authFetch` calls `fetch`, which REJECTS on a dropped connection instead
    // of resolving a non-ok Response. Left uncaught this rejects the page's
    // `Promise.all` and the screen is stuck on "Loading…" forever.
    authFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/brain/findings")) return ok({ findings: [], total: 0 });
      throw new TypeError("Failed to fetch");
    });
    render(<BriefPage />);

    expect(await screen.findByText(/could not check whether the brain is on/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("still shows findings it did receive when only /coverage failed", async () => {
    serve({ findings: ok({ findings: [finding()], total: 1 }), coverage: fail(500) });
    render(<BriefPage />);

    expect(await screen.findByText(/three invoices are 90 days overdue/i)).toBeInTheDocument();
  });

  it("offers a retry, and recovers when the box answers", async () => {
    let attempt = 0;
    authFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/brain/findings")) return ok({ findings: [], total: 0 });
      attempt += 1;
      return attempt === 1 ? fail(500) : ok(coverage({ enabled: false, canToggle: true }));
    });
    render(<BriefPage />);

    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    // The real state, once the box is reachable: the consent screen.
    expect(await screen.findByRole("button", { name: /turn the brain on/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/could not check whether the brain is on/i)).not.toBeInTheDocument(),
    );
  });

  it("does not flash the phantom pin when the refetch after a successful toggle fails", async () => {
    // `onChanged` reloads. That reload can fail on its own, and used to repaint
    // the owner who had JUST switched the brain on as pinned off by an operator.
    let coverageCalls = 0;
    authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/brain/findings")) return ok({ findings: [], total: 0 });
      if (url === "/api/brain/settings" && init?.method === "PUT") return ok({ enabled: true });
      coverageCalls += 1;
      return coverageCalls === 1 ? ok(coverage({ enabled: false, canToggle: true })) : fail(500);
    });
    render(<BriefPage />);

    fireEvent.click(await screen.findByRole("button", { name: /turn the brain on/i }));
    await screen.findByText(/could not check whether the brain is on/i);
    expect(screen.queryByText(/pinned off by its operator/i)).not.toBeInTheDocument();
  });
});
