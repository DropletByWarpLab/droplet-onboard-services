/**
 * WARP-1122 (§8.2) — the review-nudge check: due-marking matrix against a
 * fake prisma with REAL conditional-updateMany semantics (state + timestamp
 * guards actually filter), incl. the never-resurrect-within-a-period rule.
 */
import { describe, it, expect } from "vitest";
import { runBusinessReviewCheck } from "./business-review-nudge.service.js";

const NOW = new Date("2026-07-09T12:00:00Z");
const DAYS = 90;
const STALE = new Date("2026-01-01T00:00:00Z"); // far older than 90d
const FRESH = new Date("2026-07-01T00:00:00Z"); // inside the window

interface Row {
  id: string;
  onboardingState: string;
  reviewNudgeState: string;
  reviewDueAt: Date | null;
  reviewDismissedAt: Date | null;
  updatedAt: Date;
}

function makePrisma(initial: Partial<Row>) {
  let row: Row = {
    id: "singleton",
    onboardingState: "completed",
    reviewNudgeState: "none",
    reviewDueAt: null,
    reviewDismissedAt: null,
    updatedAt: STALE,
    ...initial,
  };
  return {
    _row: () => row,
    businessProfile: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          onboardingState: string;
          reviewNudgeState: string;
          updatedAt?: { lt: Date };
          reviewDismissedAt?: { lt: Date };
        };
        data: Partial<Row>;
      }) => {
        if (row.onboardingState !== where.onboardingState) return { count: 0 };
        if (row.reviewNudgeState !== where.reviewNudgeState) return { count: 0 };
        if (where.updatedAt && !(row.updatedAt < where.updatedAt.lt)) {
          return { count: 0 };
        }
        if (
          where.reviewDismissedAt &&
          !(
            row.reviewDismissedAt &&
            row.reviewDismissedAt < where.reviewDismissedAt.lt
          )
        ) {
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
  };
}

const asPrisma = (p: unknown) => p as never;

describe("runBusinessReviewCheck (WARP-1122)", () => {
  it("marks a stale, never-nudged completed profile due", async () => {
    const p = makePrisma({});
    const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
    expect(r).toEqual({ markedDue: true, via: "none" });
    expect(p._row()).toMatchObject({
      reviewNudgeState: "due",
      reviewDueAt: NOW,
    });
  });

  it("leaves a fresh profile alone", async () => {
    const p = makePrisma({ updatedAt: FRESH });
    const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
    expect(r.markedDue).toBe(false);
    expect(p._row().reviewNudgeState).toBe("none");
  });

  it("never nudges before the interview has completed", async () => {
    for (const state of ["not_started", "skipped", "in_progress", "re_running"]) {
      const p = makePrisma({ onboardingState: state });
      const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
      expect(r.markedDue).toBe(false);
    }
  });

  it("does NOT resurrect within the same review period after a dismissal", async () => {
    const p = makePrisma({
      reviewNudgeState: "dismissed",
      reviewDismissedAt: FRESH, // dismissed recently
    });
    const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
    expect(r.markedDue).toBe(false);
    expect(p._row().reviewNudgeState).toBe("dismissed");
  });

  it("re-arms once the dismissal itself is a full period old", async () => {
    const p = makePrisma({
      reviewNudgeState: "dismissed",
      reviewDismissedAt: STALE,
    });
    const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
    expect(r).toEqual({ markedDue: true, via: "dismissed" });
    expect(p._row().reviewNudgeState).toBe("due");
  });

  it("is idempotent while already due", async () => {
    const p = makePrisma({ reviewNudgeState: "due", reviewDueAt: STALE });
    const r = await runBusinessReviewCheck(asPrisma(p), DAYS, NOW);
    expect(r.markedDue).toBe(false);
  });
});
