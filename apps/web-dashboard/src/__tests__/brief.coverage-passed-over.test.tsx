/**
 * WARP-2834 — the "documents passed over" sentence, at a count of ONE.
 *
 * That sentence turns on the same number in four places: the noun
 * ("document"/"documents"), its verb ("was"/"were"), the possessive pronoun
 * ("whose it"/"whose they"), and the sentence that follows ("It is"/"They
 * are not queued for a later pass"). Split across independent switches they
 * drift apart silently — the first draft of this block shipped "whose it
 * were … They are not queued" for a single document, because two of the four
 * were never switched at all.
 *
 * Nothing in the type system catches an agreement bug, and no demo box will
 * either: `passedOver === 1` needs a corpus pass that REACHED exactly one more
 * document than it READ, a state rare enough to reach an owner before it
 * reaches a reviewer. So it is pinned here per count, and asserted on the
 * rendered paragraph rather than on a helper — the agreement lives in the JSX,
 * there is no function to unit-test.
 *
 * ShellPage is mocked to a passthrough (same as reports.page.test) — its SWR
 * health chip would only add noise to a copy assertion.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import type { Coverage } from "@/app/brief/api";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: "owner" }, isLoading: false }),
  authFetch: vi.fn(),
}));

// `vi.hoisted` because the `vi.mock` factory below is hoisted above every
// top-level const, and each case needs to swap the body the page reads.
//
// Only the two fetches are stubbed. `brainIsOff` stays REAL: it is the gate
// that decides whether the coverage line renders at all, and stubbing it would
// let this file pass green against a page that never shows the sentence.
const H = vi.hoisted(() => ({ coverage: null as unknown }));

vi.mock("@/app/brief/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchFindings: vi.fn(async () => ({ findings: [], total: 0 })),
  // WARP-2838 changed `fetchCoverage` from `Coverage` to the discriminated
  // `CoverageResult`, so that a fetch that FAILED is distinguishable from a
  // box that answered "the brain is off" — two states this page must not say
  // the same sentence about. A mock returning the bare `Coverage` leaves
  // `reached` undefined, which the page correctly reads as "did not answer":
  // it renders the unreachable line and none of the copy this file asserts on.
  fetchCoverage: vi.fn(async () => ({ reached: true as const, coverage: H.coverage })),
}));

import BriefPage from "@/app/brief/page";

type Pass = Coverage["passes"][number];

function corpusPass(over: Partial<Pass> = {}): Pass {
  return {
    passKey: "corpus.documents",
    enabled: true,
    lastRunAt: "2026-09-07T10:00:00.000Z",
    lastSucceededAt: "2026-09-07T10:00:00.000Z",
    lastError: null,
    unitsSeen: 0,
    unitsDigested: 0,
    rowsWritten: 0,
    ...over,
  };
}

function coverage(passes: Pass[]): Coverage {
  return { enabled: true, passes, corpus: { documentsReady: 4000, documentsDigested: 0 } };
}

async function renderBrief(body: Coverage) {
  H.coverage = body;
  const { container } = render(<BriefPage />);
  // The coverage line is painted from state the page's load effect sets, so
  // wait for the first sentence before reading the second.
  await screen.findByText(/indexed documents/);
  return container;
}

/** The rendered sentence, whitespace-collapsed — JSX indentation is real text
 *  in `textContent`, and this asserts wording, not source wrapping. */
function passedOverSentence(container: HTMLElement): string | null {
  const p = Array.from(container.querySelectorAll("p")).find((el) =>
    /passed over/.test(el.textContent ?? ""),
  );
  return p ? (p.textContent ?? "").replace(/\s+/g, " ").trim() : null;
}

afterEach(() => {
  cleanup();
});

describe("/brief — documents passed over (WARP-2834)", () => {
  it("agrees in number when exactly one document was passed over", async () => {
    const container = await renderBrief(coverage([corpusPass({ unitsSeen: 1, unitsDigested: 0 })]));
    const text = passedOverSentence(container);

    expect(text).toContain("1 document was passed over");
    // The pronoun and its verb are ONE clause. Switching the pronoun and
    // leaving the verb plural is what produced "whose it were".
    expect(text).toContain("whose it was");
    expect(text).not.toContain("whose it were");
    // ...and the sentence after it is number-dependent too. It sat outside the
    // switch entirely, so it said "They" about a single document.
    expect(text).toContain("It is not queued for a later pass.");
    expect(text).not.toContain("They are not queued");
  });

  it("agrees in number when several were passed over", async () => {
    const container = await renderBrief(coverage([corpusPass({ unitsSeen: 5, unitsDigested: 2 })]));
    const text = passedOverSentence(container);

    expect(text).toContain("3 documents were passed over");
    expect(text).toContain("whose they were");
    expect(text).toContain("They are not queued for a later pass.");
    expect(text).not.toContain("It is not queued");
  });

  it("says nothing when the pass read everything it reached", async () => {
    const container = await renderBrief(
      coverage([corpusPass({ unitsSeen: 240, unitsDigested: 240 })]),
    );
    expect(passedOverSentence(container)).toBeNull();
  });

  it("says nothing when digested runs ahead of seen — the clamp, not a negative", async () => {
    // The two counters advance in separate statements over the pass's life, so
    // a read between them can show digested > seen. "-2 documents were passed
    // over" would be worse than saying nothing at all.
    const container = await renderBrief(coverage([corpusPass({ unitsSeen: 3, unitsDigested: 5 })]));
    expect(passedOverSentence(container)).toBeNull();
  });

  it("says nothing when the corpus pass has never been scheduled", async () => {
    // No BrainPass row at all. There is no gap to report, and the `?? 0`
    // fallbacks must not manufacture one.
    const container = await renderBrief(coverage([]));
    expect(passedOverSentence(container)).toBeNull();
  });
});
